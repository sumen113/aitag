'use strict';
/* Bot AI: grid navigation (BFS flow fields) + simple steering.
   Chasers follow a path field toward their target; runners pick a "safe" cell
   they can reach before the tagger does. Bots use their characters' abilities. */
const T = require('../public/shared.js');
const { PropHunt } = require('./prophunt');

const CS = 40;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const IDX = {}; T.CHARS.forEach((c, i) => (IDX[c.id] = i));
// bot difficulty: speed multiplier, reaction time (ticks between decisions), steering noise, ability use chance
const DIFFS = {
  easy:   { sm: 0.84, think: [13, 22], wobble: 2.2, abil: 0.45 },
  normal: { sm: 0.93, think: [7, 14],  wobble: 1.0, abil: 0.8 },
  hard:   { sm: 1.0,  think: [5, 9],   wobble: 0.5, abil: 1.0 },
};
let WOB = 1;

class Nav {
  constructor(map) {
    this.map = map;
    this.cols = Math.ceil(map.w / CS);
    this.rows = Math.ceil(map.h / CS);
    this.n = this.cols * this.rows;
    this.blocked = new Uint8Array(this.n);
    this.open = new Float32Array(this.n);
    this.queue = new Int32Array(this.n);
    for (let i = 0; i < this.n; i++) {
      const [x, y] = this.center(i);
      this.blocked[i] = T.circleFree(map, x, y, 20) ? 0 : 1;
    }
    for (let i = 0; i < this.n; i++) {
      const cx = i % this.cols, cy = (i / this.cols) | 0;
      let free = 0;
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && ny >= 0 && nx < this.cols && ny < this.rows && !this.blocked[ny * this.cols + nx]) free++;
      }
      this.open[i] = free / 8;
    }
  }
  idx(x, y) {
    const c = T.clamp((x / CS) | 0, 0, this.cols - 1), r = T.clamp((y / CS) | 0, 0, this.rows - 1);
    return r * this.cols + c;
  }
  center(i) { return [((i % this.cols) + 0.5) * CS, (((i / this.cols) | 0) + 0.5) * CS]; }
  nearestFree(i) {
    if (!this.blocked[i]) return i;
    const cx = i % this.cols, cy = (i / this.cols) | 0;
    for (let rad = 1; rad <= 4; rad++) {
      let best = -1, bd = 1e9;
      for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const j = ny * this.cols + nx;
        if (this.blocked[j]) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = j; }
      }
      if (best >= 0) return best;
    }
    return i;
  }
  /** BFS from `start`; fills dist (steps) and par (parent cell). */
  bfs(start, dist, par, limit) {
    dist.fill(-1); par.fill(-1);
    const s = this.nearestFree(start);
    dist[s] = 0;
    const q = this.queue; let head = 0, tail = 0; q[tail++] = s;
    const cols = this.cols, rows = this.rows, blocked = this.blocked;
    while (head < tail) {
      const cur = q[head++], d = dist[cur];
      if (d >= limit) continue;
      const cx = cur % cols, cy = (cur / cols) | 0;
      for (let k = 0; k < 8; k++) {
        const dx = DIRS[k][0], dy = DIRS[k][1], nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const ni = ny * cols + nx;
        if (blocked[ni] || dist[ni] >= 0) continue;
        if (dx && dy && (blocked[cy * cols + nx] || blocked[ny * cols + cx])) continue;
        dist[ni] = d + 1; par[ni] = cur; q[tail++] = ni;
      }
    }
    return s;
  }
  /** Walk downhill on a distance field `steps` cells; returns world point or null. */
  follow(dist, start, steps) {
    let cur = this.nearestFree(start);
    if (dist[cur] < 0) return null;
    for (let s = 0; s < steps; s++) {
      const cx = cur % this.cols, cy = (cur / this.cols) | 0;
      let best = -1, bd = dist[cur];
      for (let k = 0; k < 8; k++) {
        const nx = cx + DIRS[k][0], ny = cy + DIRS[k][1];
        if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) continue;
        const j = ny * this.cols + nx;
        if (dist[j] >= 0 && dist[j] < bd) { bd = dist[j]; best = j; }
      }
      if (best < 0) break;
      cur = best;
    }
    return this.center(cur);
  }
}

const navCache = new Map();
function getNav(map) {
  let n = navCache.get(map.id);
  if (!n) { n = new Nav(map); navCache.set(map.id, n); }
  return n;
}

function lineClear(map, x0, y0, x1, y1, r) {
  const d = Math.hypot(x1 - x0, y1 - y0), n = Math.max(1, Math.ceil(d / 24));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    if (!T.circleFree(map, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r)) return false;
  }
  return true;
}

function setDir(p, tx, ty, wobble) {
  let dx = tx - p.x, dy = ty - p.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) { p.input.x = 0; p.input.y = 0; return; }
  dx /= d; dy /= d;
  if (wobble) {
    const a = (Math.random() - 0.5) * wobble * WOB, c = Math.cos(a), s = Math.sin(a);
    const rx = dx * c - dy * s, ry = dx * s + dy * c; dx = rx; dy = ry;
  }
  p.input.x = Math.round(dx * 100) / 100; p.input.y = Math.round(dy * 100) / 100;
}

function botAbility(room, p, itp, d, los, target) {
  const id = T.CHARS[p.c].id;
  let use = false, aim = null;
  if (p.it) {
    if (!target) return;
    const td = d;
    if (id === 'fox') use = td < 260 && td > 90 && los;
    else if (id === 'frog') use = td < 280 && td > 100;
    else if (id === 'ghost') use = !los && td < 380;
    else if (id === 'cat') use = p.abT > 0 ? td < 170 && los : td < 480 && Math.random() < 0.5;   // pounce when close, else cloak
    else if (id === 'bear') use = td < 150;
    else if (id === 'robot') use = td > 80 && td < 260 && los;
    else if (id === 'penguin') use = td > 170 && td < 380 && los;
    else if (id === 'star') use = td > 90 && td < 330 && los;
    else if (id === 'avocado') use = td > 110 && td < 460 && los;       // the bot is already steering at the target
    else if (id === 'dog') use = td > 60 && td < 340;                    // leave pits across the runners' paths
    else if (id === 'mole') use = p.abT > 0 ? td < 120 : td > 170 && td < 440 && los;   // tunnel in, pop up under them
    else if (id === 'skunk') use = td > 70 && td < 280 && los;
  } else if (itp) {
    if (id === 'fox') use = d < 140;
    else if (id === 'frog') use = d < 120;
    else if (id === 'ghost') use = d < 150;
    else if (id === 'cat') use = d < 320;
    else if (id === 'bear') use = d < 150;
    else if (id === 'octo') use = d < 230;
    else if (id === 'owl') use = d < 260;
    else if (id === 'robot') use = d < 110;
    else if (id === 'penguin') use = d < 230;
    else if (id === 'raccoon') use = d < 200;
    else if (id === 'star') use = d < 210;
    else if (id === 'bird') use = d < 190;
    else if (id === 'avocado') { use = d > 100 && d < 400 && lineClear(room.map, p.x, p.y, itp.x, itp.y, 12); aim = itp; }   // turn and spit at IT
    else if (id === 'dog') use = d < 280;
    else if (id === 'mole') use = p.abT > 0 ? d < 100 : d < 210;
    else if (id === 'donkey') use = d < 140;                                 // IT is right behind: kick it off
    else if (id === 'skunk') use = d < 230;
    else if (id === 'bat') use = p.aux > 0 ? d < 130 : p.cd <= 0 && d > 240 && d < 520;     // drop a beacon while safe, snap back when IT closes in
  }
  if (use && Math.random() < DIFFS[room.diff || 'normal'].abil) { p.input.a = 1; if (aim) setDir(p, aim.x + aim.vx * 0.15, aim.y + aim.vy * 0.15, 0); }
}


/* ------------------------------- Prop Hunt bots ------------------------------- */
// Bots play fair: a seeker bot can't tell a hider from clutter. It sweeps the clutter, goes for anything that moves, and checks around noises and radar pings.
// A hider bot picks a spot among the clutter, copies a nearby prop, freezes, and runs for a better spot when a seeker gets close.
const FEAR = { easy: 230, normal: 170, hard: 130 };
function walkTo(room, p, ai, x, y, wob) {
  const nav = getNav(room.map);
  if (!ai.dist || ai.dist.length !== nav.n) { ai.dist = new Int16Array(nav.n); ai.par = new Int32Array(nav.n); }
  const r = T.hiderDef(p) ? T.hiderDef(p).radius : T.CHARS[p.c].radius;
  if (lineClear(room.map, p.x, p.y, x, y, r)) { setDir(p, x, y, wob); return; }
  nav.bfs(nav.idx(x, y), ai.dist, ai.par, 9999);
  const wp = nav.follow(ai.dist, nav.idx(p.x, p.y), 3);
  if (wp) setDir(p, wp[0], wp[1], wob); else setDir(p, x, y, wob);
}

function thinkHider(room, p, ai) {
  const ph = room.ph, st = ai.hs || (ai.hs = { spot: null, mode: 'pick', until: 0 }), df = DIFFS[room.diff || 'normal'];
  const seekers = room.itPlayers().filter((q) => !q.out && !q.gone);
  let near = null, nd = 1e9;
  for (const q of seekers) { const d = Math.hypot(q.x - p.x, q.y - p.y); if (d < nd) { nd = d; near = q; } }
  const clutter = ph.clutter;
  const pickSpot = () => {
    let best = null, bs = -1e9;
    for (let k = 0; k < 10; k++) {
      const c = clutter[(Math.random() * clutter.length) | 0]; if (!c) continue;
      let dens = 0; for (const o of clutter) if (Math.hypot(o.x - c.x, o.y - c.y) < 130) dens++;
      let sd = 1e9; for (const q of seekers) sd = Math.min(sd, Math.hypot(q.x - c.x, q.y - c.y));
      const s = dens * 2 + Math.min(sd, 900) / 40 - Math.hypot(c.x - p.x, c.y - p.y) / 120 + Math.random() * 4;
      if (s > bs) { bs = s; best = c; }
    }
    return best;
  };
  const fleeing = st.mode === 'flee';
  if (near && nd < FEAR[room.diff || 'normal'] && !fleeing && lineClear(room.map, p.x, p.y, near.x, near.y, 10)) {      // a seeker is right here: bolt
    st.mode = 'flee'; st.spot = null; st.until = room.tickN + 150;
    p.input.h = 0; if (p.cd <= 0 && nd < 130) p.input.a = 1;
    const a = Math.atan2(p.y - near.y, p.x - near.x); setDir(p, p.x + Math.cos(a) * 200, p.y + Math.sin(a) * 200, 0.2);
    return;
  }
  if (st.mode === 'pick' || (fleeing && (room.tickN > st.until || !st.spot))) {
    const c = pickSpot(); st.spot = c ? { x: c.x + (Math.random() - 0.5) * 30, y: c.y + (Math.random() - 0.5) * 30 } : null; st.mode = 'go'; st.until = room.tickN + 900;
  }
  if (st.mode === 'go') {
    p.input.h = 0;
    if (!st.spot) { p.input.x = p.input.y = 0; return; }
    if (fleeing || near && nd < 260) { /* keep moving */ }
    const d = Math.hypot(st.spot.x - p.x, st.spot.y - p.y);
    if (d < 70 && p.mt <= 0) PropHunt.morph(room, p);                                  // blend in with whatever is next to us
    if (d < 26 || room.tickN > st.until) { st.mode = 'hold'; st.until = room.tickN + 400 + ((Math.random() * 900) | 0); p.input.x = p.input.y = 0; p.input.h = 8; return; }
    walkTo(room, p, ai, st.spot.x, st.spot.y, 0.1);
    if (near && nd < 300 && p.cd <= 0 && nd < 120) p.input.a = 1;
    return;
  }
  if (st.mode === 'flee') {
    p.input.h = 0;
    if (near && nd < 200) { const a = Math.atan2(p.y - near.y, p.x - near.x); setDir(p, p.x + Math.cos(a) * 220, p.y + Math.sin(a) * 220, 0.3); if (p.cd <= 0 && nd < 110) p.input.a = 1; }
    else { st.mode = 'pick'; }
    return;
  }
  // hold: scenery. An occasional taunt when nobody is anywhere near; relocate now and then so a long round isn't just standing still
  p.input.x = p.input.y = 0; p.input.h = 8;
  if (ph.hide <= 0 && p.tt <= 0 && (!near || nd > 520) && Math.random() < 0.012 * df.abil) { p.input.h = 0; PropHunt.taunt(room, p); p.input.h = 8; }
  if (room.tickN > st.until && (!near || nd > 600)) { st.mode = 'pick'; p.input.h = 0; }
}

function thinkSeeker(room, p, ai) {
  const ph = room.ph, st = ai.ss || (ai.ss = { tgt: null, until: 0, cool: 0 });
  if (ph.hide > 0 || p.stun > 0 || p.lock > 0) { p.input.x = p.input.y = 0; return; }
  const hiders = [...room.players.values()].filter((q) => PropHunt.isHider(q) && !q.wait);
  const pickTarget = () => {
    for (const q of hiders) {                                               // anything that moves gets a closer look
      const sp = Math.hypot(q.vx, q.vy), d = Math.hypot(q.x - p.x, q.y - p.y);
      if (sp > 70 && d < 480 && lineClear(room.map, p.x, p.y, q.x, q.y, 10)) return { x: q.x, y: q.y, live: q };
    }
    const cl = ph.clutter; if (!cl.length) return null;
    const noise = ph.noise && room.tickN - ph.noise.at < 900 ? ph.noise : null;
    let best = null, bs = 1e9;
    for (let k = 0; k < 8; k++) {
      const c = cl[(Math.random() * cl.length) | 0];
      let s = Math.hypot(c.x - p.x, c.y - p.y);
      if (noise) s = Math.hypot(c.x - noise.x, c.y - noise.y) * 0.5 + (Math.hypot(c.x - noise.x, c.y - noise.y) > noise.r ? 600 : 0) + s * 0.2;
      if (s < bs) { bs = s; best = c; }
    }
    return best ? { x: best.x, y: best.y } : null;
  };
  if (!st.tgt || room.tickN > st.until) { st.tgt = pickTarget(); st.until = room.tickN + 420; }
  if (!st.tgt) { p.input.x = p.input.y = 0; return; }
  if (st.tgt.live) { st.tgt.x = st.tgt.live.x; st.tgt.y = st.tgt.live.y; }
  const d = Math.hypot(st.tgt.x - p.x, st.tgt.y - p.y);
  if (d < 70) {                                                             // close enough: turn and swing
    p.fx = (st.tgt.x - p.x) / (d || 1); p.fy = (st.tgt.y - p.y) / (d || 1);
    p.input.x = p.input.y = 0;
    PropHunt.swing(room, p); st.tgt = null;
    return;
  }
  walkTo(room, p, ai, st.tgt.x, st.tgt.y, 0.12);
}

function thinkPropBot(room, p) {
  if (room.state !== T.STATE.PLAY || p.out || !room.ph) { p.input.x = p.input.y = 0; p.input.a = 0; p.input.h = 0; return; }
  const ai = p.ai || (p.ai = { next: 0, tgt: -1, wp: null, wpUntil: 0 });
  if (room.tickN < ai.next) return;
  const df = DIFFS[room.diff || 'normal']; WOB = df.wobble;
  ai.next = room.tickN + df.think[0] + ((Math.random() * (df.think[1] - df.think[0])) | 0);
  if (p.it) { p.input.h = 0; thinkSeeker(room, p, ai); } else thinkHider(room, p, ai);
}

function thinkBot(room, p) {
  if (room.mode === 'prophunt') { thinkPropBot(room, p); return; }
  if (room.state !== T.STATE.PLAY || p.out) { p.input.x = 0; p.input.y = 0; p.input.a = 0; return; }
  const ai = p.ai || (p.ai = { next: 0, tgt: -1, wp: null, wpUntil: 0 });
  if (room.tickN < ai.next) return;
  const df = DIFFS[room.diff || 'normal']; WOB = df.wobble;
  ai.next = room.tickN + df.think[0] + ((Math.random() * (df.think[1] - df.think[0])) | 0);
  const map = room.map, nav = getNav(map);
  if (!ai.dist || ai.dist.length !== nav.n) { ai.dist = new Int16Array(nav.n); ai.par = new Int32Array(nav.n); ai.tgt = -1; }
  const r = T.CHARS[p.c].radius;

  if (p.it) {
    let best = null, bd = 1e9, fallback = null, fd = 1e9;
    for (const q of room.players.values()) {
      if (q === p || q.it || q.out) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < fd) { fd = d; fallback = q; }
      if (q.imm > 0.25) continue;
      if ((q.c === IDX.frog || q.c === IDX.mole) && q.abT > 0) continue;
      if (q.c === IDX.cat && q.abT > 0 && d > 200) continue;     // cloaked: bots lose sight
      if (d < bd) { bd = d; best = q; }
    }
    const tgt = best || fallback;
    if (!tgt) { p.input.x = 0; p.input.y = 0; return; }
    const d = Math.hypot(tgt.x - p.x, tgt.y - p.y);
    const los = lineClear(map, p.x, p.y, tgt.x, tgt.y, 16);
    if (best && los) {
      const t = Math.min(0.35, d / 300);
      setDir(p, tgt.x + tgt.vx * t * 0.7, tgt.y + tgt.vy * t * 0.7, 0.15);
    } else {
      nav.bfs(nav.idx(tgt.x, tgt.y), ai.dist, ai.par, 9999);
      const wp = nav.follow(ai.dist, nav.idx(p.x, p.y), 3);
      if (wp) setDir(p, wp[0], wp[1], 0.12); else setDir(p, tgt.x, tgt.y, 0.2);
    }
    botAbility(room, p, null, d, los, best);
    return;
  }

  // ----- runner -----
  const its = room.itPlayers();                   // one tagger, or two in big rooms: flee from whichever is closest
  if (!its.length) { p.input.x = 0; p.input.y = 0; return; }
  let itp = its[0], d = Math.hypot(p.x - itp.x, p.y - itp.y);
  for (const q of its) { const dq = Math.hypot(p.x - q.x, p.y - q.y); if (dq < d) { d = dq; itp = q; } }
  if (d > 700) {                                  // far away: amble about
    if (!ai.wp || room.tickN > ai.wpUntil || Math.hypot(ai.wp[0] - p.x, ai.wp[1] - p.y) < 40) {
      for (let tries = 0; tries < 8; tries++) {
        const a = Math.random() * Math.PI * 2, rr = 120 + Math.random() * 220;
        const wx = p.x + Math.cos(a) * rr, wy = p.y + Math.sin(a) * rr;
        if (T.circleFree(map, wx, wy, r + 6) && lineClear(map, p.x, p.y, wx, wy, r)) { ai.wp = [wx, wy]; break; }
      }
      ai.wpUntil = room.tickN + 90;
    }
    if (ai.wp) { setDir(p, ai.wp[0], ai.wp[1], 0.2); p.input.x *= 0.6; p.input.y *= 0.6; }
    else { p.input.x = 0; p.input.y = 0; }
    return;
  }
  const me = nav.idx(p.x, p.y);
  const start = nav.bfs(me, ai.dist, ai.par, 14);
  if (!room.itFields || room.itFieldsN !== nav.n) { room.itFields = new Map(); room.itFieldsN = nav.n; }
  const fields = [];
  for (const q of its) {                          // one cached distance field per tagger, refreshed every 8 ticks
    let f = room.itFields.get(q.id);
    if (!f) { f = { dist: new Int16Array(nav.n), par: new Int32Array(nav.n), tick: -999 }; room.itFields.set(q.id, f); }
    if (f.tick + 8 <= room.tickN) { nav.bfs(nav.idx(q.x, q.y), f.dist, f.par, 9999); f.tick = room.tickN; }
    fields.push(f.dist);
  }
  let bestC = -1, bestS = -1e9;
  for (let i = 0; i < nav.n; i++) {
    const dm = ai.dist[i]; if (dm < 0) continue;
    let di = -1;
    for (const fd of fields) { const v = fd[i]; if (v >= 0 && (di < 0 || v < di)) di = v; }
    if (di < 0) continue;
    let s = Math.max(-8, Math.min(12, di - dm)) * 3 + di * 0.15 - dm * 0.2 + nav.open[i] * 3;
    if (i === ai.tgt) s += 2.5;
    if (s > bestS) { bestS = s; bestC = i; }
  }
  ai.tgt = bestC;
  if (bestC >= 0) {
    const path = []; let cur = bestC;
    while (cur >= 0 && cur !== start && path.length < 60) { path.push(cur); cur = ai.par[cur]; }
    if (path.length) {
      const wpI = path[Math.max(0, path.length - 3)];
      const c = nav.center(wpI);
      setDir(p, c[0], c[1], 0.1);
    } else { p.input.x = 0; p.input.y = 0; }
  }
  botAbility(room, p, itp, d, true, null);
}

module.exports = { thinkBot, getNav, lineClear, DIFFS };
