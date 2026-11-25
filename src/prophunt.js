'use strict';
/* Prop Hunt rules. Hiders vs seekers on the Storehouse map.
   - Hiders are disguised as props; the same props are scattered around as clutter (harmless, identical art).
   - Seekers are blindfolded for the first PH.HIDE seconds, then swing at suspects. The nearest thing in the swing wins:
     a hider is FOUND (and joins the seekers, snowball), a harmless prop leaves the seeker dizzy.
   - Hiders earn a point per second alive (the room's normal survival score), plus the last ones standing get the usual bonus.
   - Hiders can freeze (hold), dash, change prop (copy a nearby one) and taunt (a noise: points, but it tells everyone roughly where).
   Everything here is server-authoritative; the client only sends inputs (see queueInputs / runStep in room.js). */
const T = require('../public/shared.js');

const { PH, PROPS, DT, STATE } = T;
const r1 = (v) => Math.round(v * 10) / 10;
const TAU = Math.PI * 2;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rint = (n) => (Math.random() * n) | 0;

/** How many seekers a round starts with: one per ~5 players. */
const seekerCount = (n) => (n >= 13 ? 3 : n >= 8 ? 2 : 1);

/** Scatter `n` props over the arena: tight themed clusters (a stack of barrels, a pile of sacks) plus loners, never in a wall, never on a spawn point and never touching each other. */
function genClutter(map, n) {
  const out = [];
  const okAt = (x, y, r) => x > r + 6 && y > r + 6 && x < map.w - r - 6 && y < map.h - r - 6 && T.circleFree(map, x, y, r + 3);
  const spaced = (x, y) => { for (let i = 0; i < out.length; i++) { const c = out[i], dx = c.x - x, dy = c.y - y; if (dx * dx + dy * dy < 38 * 38) return false; } return true; };
  const clear = (x, y) => map.spawns.every((s) => Math.hypot(s[0] - x, s[1] - y) > 64);
  const place = (x, y, t, v) => {
    x = r1(x); y = r1(y);
    if (!okAt(x, y, PROPS[t].r) || !spaced(x, y) || !clear(x, y)) return false;
    out.push({ t, x, y, v }); return true;
  };
  const centers = [];
  for (let k = 0, want = Math.max(7, Math.round(n / 9)); k < want * 12 && centers.length < want; k++) {
    const x = 120 + Math.random() * (map.w - 240), y = 120 + Math.random() * (map.h - 240);
    if (T.circleFree(map, x, y, 40)) centers.push({ x, y, th: [rint(PROPS.length), rint(PROPS.length)] });
  }
  for (let tries = 0; out.length < n && tries < n * 60; tries++) {
    if (centers.length && Math.random() < 0.6) {
      const c = centers[rint(centers.length)], a = Math.random() * TAU, d = 18 + Math.random() * Math.random() * 170;
      place(c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, Math.random() < 0.72 ? c.th[rint(2)] : rint(PROPS.length), rint(16));
    } else place(Math.random() * map.w, Math.random() * map.h, rint(PROPS.length), rint(16));
  }
  return out;
}

/** Everything about the current round that is not on the players themselves. */
function fresh() { return { hide: 0, t: 0, pingAt: 0, clutter: [], seq: 0 }; }

const PropHunt = {
  fresh,

  /** A new round is being set up (countdown): fresh clutter for the map, sized to the crowd. */
  reset(room) {
    const ph = room.ph = fresh();
    room.phWin = '';
    const n = T.clamp(PH.CLUTTER_MIN + PH.CLUTTER_PER * room.players.size, PH.CLUTTER_MIN, PH.CLUTTER_MAX);
    ph.clutter = genClutter(room.map, n);
    ph.seq++;
    room.broadcast(PropHunt.propsMsg(room));
  },

  /** What clients need to draw the clutter. `c` is the whole list: [type, x, y, turn]. The index is the clutter's id. */
  propsMsg(room) { const ph = room.ph; return { t: 'props', seq: ph ? ph.seq : 0, c: ph ? ph.clutter.map((c) => [c.t, c.x, c.y, c.v]) : [] }; },

  makeHider(p) {
    p.it = 0; p.pr = 1 + rint(PROPS.length); p.pv = rint(16); p.mt = 0; p.tt = 0; p.cd = 0; p.abT = 0; p.aux = 0; p.stun = 0; p.imm = 0; p.lock = 0; p.swT = 0;
    p.vx = p.vy = 0; p.z = 0; p.bm = 0; p.hold = 0; p.rep = 0; p.repT = 0;
  },

  /** Choose the seekers, disguise everybody else. Returns the seekers. */
  start(room) {
    const arr = shuffle([...room.players.values()].filter((p) => !p.out));
    const seekers = arr.slice(0, seekerCount(arr.length));
    for (const p of arr) { if (seekers.includes(p)) { p.it = 1; p.pr = 0; p.swT = 0; p.from = 0; } else PropHunt.makeHider(p); }
    const ph = room.ph || (room.ph = fresh());
    ph.hide = PH.HIDE; ph.t = 0; ph.pingAt = PH.PING_FIRST;
    return seekers;
  },

  isHider: (p) => !!p && !p.it && p.pr > 0 && !p.out && !p.gone,
  isSeeker: (p) => !!p && !!p.it && !p.out && !p.gone,
  hidersLeft(room) { let n = 0; for (const p of room.players.values()) if (!p.wait && PropHunt.isHider(p)) n++; return n; },

  /** A hider is found: they become a seeker (with a moment to get their bearings), the finder scores. */
  convert(room, hider, finder) {
    const e = { k: 'found', a: finder ? finder.id : 0, b: hider.id, x: r1(hider.x), y: r1(hider.y), pr: hider.pr, pv: hider.pv | 0 };
    hider.it = 1; hider.pr = 0; hider.lock = PH.FIND_LOCK; hider.stun = 0; hider.vx = hider.vy = 0; hider.abT = 0; hider.cd = 0; hider.imm = 0; hider.swT = 0; hider.mt = 0; hider.tt = 0; hider.from = 0;
    room.emit(e);
    room.rosterDirty = true;
  },

  find(room, seeker, hider) {
    seeker.tags++; room.tagCount++;
    if (!seeker.noScore) seeker.score += PH.FIND_PTS;
    PropHunt.convert(room, hider, seeker);
  },

  canAct(room, p) { return room.state === STATE.PLAY && !p.out && !p.gone && !(room.ph && room.ph.hide > 0 && p.it); },

  /** A seeker swings in the direction they face. The nearest thing in the swing is what it hits: a hider is found, a harmless prop leaves the seeker dizzy. */
  swing(room, p) {
    if (!PropHunt.canAct(room, p) || !p.it || p.swT > 0 || p.stun > 0 || p.lock > 0 || (p.c === T.CHARS.findIndex((c) => c.id === 'mole') && p.abT > 0) || (p.z || 0) >= T.GOD_AIR) return false;
    p.swT = PH.SWING_CD; p.lastActiveAt = Date.now();
    const rp = T.CHARS[p.c].radius, fx = p.fx, fy = p.fy;
    let best = null, bd = Infinity, bi = -1;
    const consider = (x, y, rq, hit, idx) => {
      const dx = x - p.x, dy = y - p.y, d = Math.hypot(dx, dy), gap = d - rq - rp;
      if (gap > PH.SWING_R) return;
      if (gap > PH.SWING_NEAR && (d < 1 || (dx * fx + dy * fy) / d < PH.SWING_DOT)) return;        // outside the cone (anything within touching distance is always hit)
      if (d < bd) { bd = d; best = hit; bi = idx; }
    };
    for (const q of room.players.values()) if (PropHunt.isHider(q) && !q.wait) consider(q.x, q.y, PROPS[q.pr - 1].r, q, -1);
    const cl = room.ph ? room.ph.clutter : [];
    for (let i = 0; i < cl.length; i++) consider(cl[i].x, cl[i].y, PROPS[cl[i].t].r, null, i);
    room.emit({ k: 'swing', id: p.id, x: r1(p.x), y: r1(p.y), dx: Math.round(fx * 100) / 100, dy: Math.round(fy * 100) / 100 });
    if (best) PropHunt.find(room, p, best);
    else if (bi >= 0) {                                                               // a harmless prop: the swing bounces off and the seeker is dizzy
      p.stun = Math.max(p.stun, PH.MISS_STUN); p.vx *= 0.3; p.vy *= 0.3;
      room.emit({ k: 'dud', id: p.id, ci: bi, x: cl[bi].x, y: cl[bi].y });
    }
    return true;
  },

  /** Hider: copy the nearest clutter prop within reach (type and turn, so it matches it exactly). */
  morph(room, p) {
    if (!PropHunt.canAct(room, p) || !PropHunt.isHider(p) || p.mt > 0 || p.stun > 0) return false;
    const cl = room.ph ? room.ph.clutter : [];
    let bi = -1, bd = PH.MORPH_R;
    for (let i = 0; i < cl.length; i++) { const d = Math.hypot(cl[i].x - p.x, cl[i].y - p.y); if (d < bd) { bd = d; bi = i; } }
    if (bi < 0) { p.mt = 0.6; room.emit({ k: 'nomorph', id: p.id }); return false; }
    p.pr = 1 + cl[bi].t; p.pv = cl[bi].v; p.mt = PH.MORPH_CD;
    room.emit({ k: 'morph', id: p.id, x: r1(p.x), y: r1(p.y) });
    return true;
  },

  /** Hider: make a noise. Worth points, but everybody hears roughly where it came from. */
  taunt(room, p) {
    if (!PropHunt.canAct(room, p) || !PropHunt.isHider(p) || p.tt > 0 || p.stun > 0 || !room.ph || room.ph.hide > 0) return false;
    const ph0 = room.ph; p.tt = PH.TAUNT_CD;
    if (!p.noScore) p.score += PH.TAUNT_PTS;
    ph0.noise = { x: p.x, y: p.y, r: 150, at: room.tickN };
    room.emit({ k: 'taunt', id: p.id, x: r1(p.x), y: r1(p.y), n: rint(4) });
    return true;
  },

  /** One processed input from a human: the pressed-this-frame buttons (bit 8 swing, 16 taunt, 32 change prop). */
  input(room, p, inp) {
    const h = inp.h | 0, prev = p.hPrev | 0; p.hPrev = h;
    const edge = h & ~prev;
    if (!edge || room.state !== STATE.PLAY) return;
    if (p.it) { if (edge & 8) PropHunt.swing(room, p); }
    else if (PropHunt.isHider(p)) { if (edge & 16) PropHunt.taunt(room, p); if (edge & 32) PropHunt.morph(room, p); }
  },

  /** Make a hider into a seeker without scoring anyone (the last seeker left, or only idle ones remain). */
  promote(room) {
    const hs = [...room.players.values()].filter((p) => PropHunt.isHider(p) && !p.wait);
    if (hs.length < 2) return false;
    const pool = hs.filter((p) => !p.noScore && !p.afk), pick = (pool.length ? pool : hs)[rint(pool.length || hs.length)];
    PropHunt.convert(room, pick, null);
    return true;
  },

  /** Once per tick while the round is running. */
  tick(room) {
    const ph = room.ph; if (!ph) return;
    for (const p of room.players.values()) if (p.swT > 0) p.swT -= DT;
    if (ph.hide > 0) { ph.hide -= DT; if (ph.hide <= 0) { ph.hide = 0; room.emit({ k: 'seek' }); } }
    else {
      ph.t += DT;
      if (ph.t >= ph.pingAt) {                                                        // radar ping: a circle that covers one hider somewhere inside it
        ph.pingAt += PH.PING_EVERY;
        const hs = [...room.players.values()].filter((p) => PropHunt.isHider(p) && !p.wait);
        if (hs.length) {
          const h = hs[rint(hs.length)], a = Math.random() * TAU, d = Math.random() * PH.PING_R * 0.55;
          const px = r1(T.clamp(h.x + Math.cos(a) * d, 0, room.map.w)), py = r1(T.clamp(h.y + Math.sin(a) * d, 0, room.map.h));
          ph.noise = { x: px, y: py, r: PH.PING_R, at: room.tickN };
          room.emit({ k: 'ping', x: px, y: py, r: PH.PING_R });
        }
      }
    }
    let hid = 0, seek = 0, active = 0;
    for (const p of room.players.values()) {
      if (p.out || p.gone || p.wait) continue;
      if (p.it) { seek++; if (!p.afk) active++; } else hid++;
    }
    if (hid === 0) { room.endRound(); return; }                                      // everybody was found
    if (active === 0) { if (!PropHunt.promote(room) && seek === 0) room.endRound(); }  // nobody left to hunt: one of the hiders is drafted (or the last hider simply wins)
    else if (room.activeCount() < room.minPlayers()) room.toWait();
  },
};

module.exports = { PropHunt, genClutter, seekerCount };
