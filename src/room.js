'use strict';
/* A Room is one running game of tag: players (humans + bots), round state machine,
   tagging rules, abilities with world effects (stomp / goo / decoy) and snapshots. */
const T = require('../public/shared.js');
const { thinkBot, DIFFS } = require('./bots');

const { CHARS, DT, STATE } = T;
const IDX = {}; CHARS.forEach((c, i) => (IDX[c.id] = i));
const BOT_COUNT = 4;                   // practice rooms: you + 4 bots
const SNAP_HZ = Math.max(10, Math.min(60, +process.env.SNAP_HZ || 30));
const SNAP_EVERY = Math.max(1, Math.round(T.TICK / SNAP_HZ));   // 60 Hz sim -> 30 Hz snapshots by default
const MIN_WIN_PLAYERS = +process.env.MIN_WIN_PLAYERS || 3;      // humans needed in a public lobby for a win to count (anti-farming)
const CUSTOM_MIN_WIN_PLAYERS = Math.max(MIN_WIN_PLAYERS, +process.env.CUSTOM_MIN_WIN_PLAYERS || 3);   // custom servers need a few more humans (private rooms are easy to farm)
const MIN_WIN_SCORE = 30;                                       // and the winner must have actually survived this long
const HIST = 16;                                                // position history (ticks) for lag compensation
const BOT_NAMES = ['Pixel', 'Mochi', 'Zippy', 'Nova', 'Biscuit', 'Turbo', 'Waffles', 'Comet', 'Noodle', 'Blip', 'Gizmo', 'Pickle', 'Sprout', 'Ziggle', 'Tofu', 'Jelly'];
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

let nextPlayerId = 1;

class Room {
  constructor(code, opts = {}) {
    this.code = code;                                   // internal id only, never shown to players
    this.solo = opts.kind === 'bots';                   // practice room: one human + bots
    this.diff = DIFFS[opts.diff] ? opts.diff : 'normal';
    this.botSpeed = DIFFS[this.diff].sm;
    this.regular = opts.kind === 'public';              // the always-on Regular server
    this.name = opts.name || (this.regular ? T.REGULAR_NAME : 'Practice');
    this.roundTime = opts.roundTime || T.ROUND_TIME;    // seconds per game
    this.max = opts.max || T.MAX_PLAYERS;               // max players (bots use slots, humans push them out)
    this.botTarget = this.solo ? BOT_COUNT : Math.max(0, opts.bots | 0);
    this.lock = opts.lock || null;                      // { salt, hash } when the server has a password
    this.mapMode = opts.mapMode && T.MAP_BY_ID[opts.mapMode] ? opts.mapMode : 'rotate';
    this.map = this.mapMode !== 'rotate' ? T.MAP_BY_ID[this.mapMode] : T.MAPS[(Math.random() * T.MAPS.length) | 0];
    this.goos = [];
    this.ctx = { map: this.map, goos: this.goos };
    this.players = new Map();
    this.decoys = [];
    this.events = [];
    this.state = STATE.WAIT;
    this.timer = 0; this.tl = 0; this.round = 0; this.tickN = 0;
    this.itId = 0; this.results = null; this.entId = 1;
    this.rosterDirty = false;
  }

  /* ----------------------------- membership ----------------------------- */
  humanCount() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }
  itPlayer() { const p = this.players.get(this.itId); return p && p.it ? p : null; }

  makePlayer(name, c, col, bot) {
    const p = T.newSim(nextPlayerId++, c, 0, 0);
    Object.assign(p, {
      name, col, bot, hat: bot && Math.random() < 0.5 ? 1 + ((Math.random() * (T.HATS.length - 1)) | 0) : 0, ws: null, score: 0, tags: 0, queue: [], ack: 0, lastSeq: 0, lastInputAt: Date.now(), lastActiveAt: Date.now(),
      lastChat: 0, chatLog: [], lastMsg: '', rtt: 0, uid: 0, bowled: null,
      hx: new Float32Array(HIST), hy: new Float32Array(HIST),
      input: { x: 0, y: 0, a: 0 }, sm: bot ? this.botSpeed : 1,
    });
    return p;
  }

  resetHist(p) { p.hx.fill(p.x); p.hy.fill(p.y); }

  spawnFor(p) {
    const it = this.itPlayer(); const sp = this.map.spawns;
    let best = sp[(Math.random() * sp.length) | 0];
    if (it) { let bd = -1; for (const s of sp) { const d = Math.hypot(s[0] - it.x, s[1] - it.y) + Math.random() * 300; if (d > bd) { bd = d; best = s; } } }
    p.x = best[0]; p.y = best[1]; this.resetHist(p);
  }

  addHuman(ws, name, c, col, uid, hat) {
    const p = this.makePlayer(name, c, col, false);
    p.ws = ws; p.uid = uid || 0; p.hat = hat | 0;
    this.spawnFor(p);
    if (this.state === STATE.PLAY) p.imm = 2;
    this.players.set(p.id, p);
    this.emit({ k: 'join', n: p.name });
    this.rebalanceBots();
    this.rosterDirty = true;
    if (this.state === STATE.WAIT && this.players.size >= 2) this.startCountdown();
    return p;
  }

  addBot() {
    const used = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
    const name = free.length ? free[(Math.random() * free.length) | 0] : 'Bot' + ((Math.random() * 99) | 0);
    const p = this.makePlayer(name, (Math.random() * CHARS.length) | 0, Math.random() < 0.5 ? 0 : 1 + ((Math.random() * 7) | 0), true);
    this.spawnFor(p);
    if (this.state === STATE.PLAY) p.imm = 2;
    this.players.set(p.id, p);
  }

  rebalanceBots() {
    const humans = this.humanCount();
    const want = humans > 0 ? Math.min(this.botTarget, Math.max(0, this.max - humans)) : 0;
    let bots = [...this.players.values()].filter((p) => p.bot);
    while (bots.length > want) {
      bots.sort((a, b) => (a.it ? 1 : 0) - (b.it ? 1 : 0));
      this.removePlayer(bots.shift(), true);
    }
    while (bots.length < want && this.players.size < this.max) { this.addBot(); bots = [...this.players.values()].filter((p) => p.bot); }
    this.rosterDirty = true;
  }

  removePlayer(p, silent) {
    if (!this.players.delete(p.id)) return;
    for (const g of this.goos.slice()) if (g.o === p.id) this.goos.splice(this.goos.indexOf(g), 1);
    for (const d of this.decoys.slice()) if (d.o === p.id) this.decoys.splice(this.decoys.indexOf(d), 1);
    if (!silent && !p.bot) this.emit({ k: 'leave', n: p.name });
    this.rosterDirty = true;
    if (p.it) this.reassignIt();
    if (!p.bot) { if (this.humanCount() > 0) this.rebalanceBots(); }
    if (this.players.size < 2 && (this.state === STATE.COUNT || this.state === STATE.PLAY)) this.toWait();
  }

  reassignIt() {
    const arr = [...this.players.values()];
    if (this.state !== STATE.PLAY || arr.length < 2) { this.itId = 0; return; }
    const n = arr[(Math.random() * arr.length) | 0];
    n.it = 1; n.lock = 1; this.itId = n.id;
    this.emit({ k: 'tag', a: 0, b: n.id, x: n.x, y: n.y });
  }

  /* ------------------------------ round flow ---------------------------- */
  pickMap() {
    if (this.mapMode !== 'rotate') return T.MAP_BY_ID[this.mapMode];
    const others = T.MAPS.filter((m) => m !== this.map);
    return others[(Math.random() * others.length) | 0];
  }

  resetPlayer(p, s) {
    p.x = s[0]; p.y = s[1]; p.vx = p.vy = 0; p.cd = 0; p.abT = 0; p.stun = 0; p.boostT = 0; p.tp = 0; p.imm = 0; p.lock = 0; p.it = 0;
    p.score = 0; p.tags = 0; p.aux = 0; p.bowled = null; p.lastActiveAt = Date.now(); this.resetHist(p);
    if (p.ai) { p.ai.tgt = -1; p.ai.wp = null; }
  }

  startCountdown() {
    if (this.round > 0) {
      const m = this.pickMap();
      if (m !== this.map) { this.map = m; this.ctx.map = m; this.itDist = null; for (const p of this.players.values()) p.ai = null; }
    }
    this.round++;
    this.goos.length = 0; this.decoys.length = 0; this.results = null;
    const sp = shuffle(this.map.spawns.slice()); let i = 0;
    for (const p of this.players.values()) this.resetPlayer(p, sp[i++ % sp.length]);
    this.itId = 0; this.state = STATE.COUNT; this.timer = T.COUNTDOWN; this.tl = T.COUNTDOWN;
    this.emit({ k: 'st', s: STATE.COUNT, m: this.map.id, rd: this.round });
  }

  startPlay() {
    const arr = [...this.players.values()];
    const it = arr[(Math.random() * arr.length) | 0];
    it.it = 1; it.stun = T.HEAD_START; this.itId = it.id;
    this.state = STATE.PLAY; this.tl = this.roundTime;
    this.emit({ k: 'st', s: STATE.PLAY, it: it.id });
  }

  endRound() {
    const list = [...this.players.values()].map((p) => ({ id: p.id, s: p.score, t: p.tags })).map((r) => ({ ...r, tie: Math.random() })).sort((a, b) => b.s - a.s || b.t - a.t || a.tie - b.tie);   // display order inside a tie: more tags, then a coin flip (never "whoever joined first"); the win itself is shared, see below
    this.results = list.map((r) => [r.id, Math.floor(r.s), r.t]);
    // wins are paid out in online servers with enough real players and no bots (custom servers: a few more players), to registered accounts that were actually playing
    const need = this.regular ? MIN_WIN_PLAYERS : this.botTarget === 0 ? CUSTOM_MIN_WIN_PLAYERS : Infinity;
    if (this.onWin && !this.solo && list.length && this.humanCount() >= need) {
      const best = Math.floor(list[0].s);                // the displayed top score: everyone who finished on it shares the win
      if (list[0].s >= MIN_WIN_SCORE) for (const r of list) {
        if (Math.floor(r.s) !== best) break;
        const w = this.players.get(r.id);
        if (w && w.uid && !w.bot && !w.afk) this.onWin(w);
      }
    }
    for (const p of this.players.values()) p.it = 0;
    this.itId = 0; this.state = STATE.RESULTS; this.timer = T.RESULTS_TIME; this.tl = T.RESULTS_TIME;
    this.emit({ k: 'st', s: STATE.RESULTS });
  }

  toWait() {
    for (const p of this.players.values()) p.it = 0;
    this.itId = 0; this.state = STATE.WAIT; this.tl = 0; this.results = null;
    this.emit({ k: 'st', s: STATE.WAIT });
  }

  tag(it, victim) {
    it.it = 0; it.imm = T.TAG_IMMUNITY; it.tags++;
    victim.it = 1; victim.lock = T.TAG_LOCK; victim.stun = 0;
    this.itId = victim.id;
    this.emit({ k: 'tag', a: it.id, b: victim.id, x: victim.x, y: victim.y });
  }

  /* ------------------------------- inputs ------------------------------- */
  queueInputs(p, arr) {
    const now = Date.now(); p.lastInputAt = now;
    for (const e of arr) {
      if (!Array.isArray(e) || e.length < 4) continue;
      const s = e[0] | 0;
      if (s <= p.lastSeq) continue;
      p.lastSeq = s;
      let x = +e[1], y = +e[2];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      x = Math.round(T.clamp(x, -1, 1) * 100) / 100; y = Math.round(T.clamp(y, -1, 1) * 100) / 100;
      p.queue.push({ s, x, y, a: e[3] ? 1 : 0 });
      if (e[3] || Math.abs(x) + Math.abs(y) > 0.2) p.lastActiveAt = now;   // idle = not actually moving (the client sends zeros constantly)
    }
    if (p.queue.length > 24) p.queue.splice(0, p.queue.length - 8);
  }

  /** Player chat: sanitised, rate limited (1 per 0.6 s, 5 per 8 s) and broadcast to the room as an event. */
  chat(p, raw) {
    const now = Date.now();
    if (now - p.lastChat < 600) return;
    p.chatLog = p.chatLog.filter((t) => now - t < 8000);
    if (p.chatLog.length >= 5) return;
    const m = T.cleanChat(raw);
    if (!m || (m === p.lastMsg && now - p.lastChat < 6000)) return;
    p.lastChat = now; p.lastMsg = m; p.chatLog.push(now); p.lastActiveAt = now;
    this.emit({ k: 'chat', id: p.id, n: p.name, m, a: p.uid ? 1 : 0, s: p.staff ? 1 : 0 });
  }

  emit(e) { this.events.push(e); }

  /* ------------------------------- the tick ----------------------------- */
  runStep(p, inp) {
    let i = inp;
    if (this.state === STATE.COUNT) i = { s: inp.s, x: 0, y: 0, a: 0 };
    const ev = [], wasLeap = p.c === IDX.frog && p.abT > 0;
    T.stepPlayer(p, i, this.ctx, ev);
    if (!p.bot) p.ack = inp.s;
    for (const e of ev) this.abilityEvent(p, e);
    if (wasLeap && p.abT <= 0) {                        // frog landing: sticky splash that slows everyone but the frog
      const mine = this.goos.filter((g) => g.o === p.id && g.splash);
      if (mine.length >= 2) this.goos.splice(this.goos.indexOf(mine[0]), 1);
      this.goos.push({ id: this.entId++, x: p.x, y: p.y, r: 54, o: p.id, ttl: 2.2, splash: 1 });
      this.emit({ k: 'ab', n: 'splash', id: p.id, x: r1(p.x), y: r1(p.y), dx: 0, dy: 0 });
    }
  }

  abilityEvent(p, e) {
    if (e.n === 'stomp') {
      const R = 175;
      for (const q of this.players.values()) {
        if (q === p) continue;
        if (q.c === IDX.frog && q.abT > 0) continue;
        let dx = q.x - p.x, dy = q.y - p.y; const d = Math.hypot(dx, dy);
        if (d > R) continue;
        if (d < 1) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
        const f = 1 - d / R * 0.4;
        q.vx += dx * 760 * f; q.vy += dy * 760 * f;
        q.stun = Math.max(q.stun, 0.5);
        if (q.c === IDX.fox) q.abT = 0;
      }
      for (const dd of this.decoys.slice()) if (Math.hypot(dd.x - p.x, dd.y - p.y) < R) this.popDecoy(dd);
    } else if (e.n === 'gust') {
      const R = 270;                                          // a wide, stun-free blast: it buys distance, not a free tag
      for (const q of this.players.values()) {
        if (q === p) continue;
        if (q.c === IDX.frog && q.abT > 0) continue;
        let dx = q.x - p.x, dy = q.y - p.y; const d = Math.hypot(dx, dy);
        if (d > R) continue;
        if (d < 1) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
        const f = 1 - d / R * 0.5;
        q.vx += dx * 640 * f; q.vy += dy * 640 * f;
        if (q.c === IDX.fox) q.abT = 0;
      }
      for (const dd of this.decoys.slice()) if (Math.hypot(dd.x - p.x, dd.y - p.y) < R) this.popDecoy(dd);
    } else if (e.n === 'goo') {
      const mine = this.goos.filter((g) => g.o === p.id);
      if (mine.length >= 3) this.goos.splice(this.goos.indexOf(mine[0]), 1);
      this.goos.push({ id: this.entId++, x: p.x, y: p.y, r: 80, o: p.id, ttl: 8 });
    } else if (e.n === 'decoy') {
      const mine = this.decoys.filter((d) => d.o === p.id);
      if (mine.length >= 2) this.decoys.splice(this.decoys.indexOf(mine[0]), 1);
      this.decoys.push({ id: this.entId++, x: p.x + e.dx * 30, y: p.y + e.dy * 30, vx: e.dx * 235, vy: e.dy * 235, c: p.c, k: p.col, o: p.id, ttl: 5.5 });
    }
    else if (e.n === 'swap') {
      let best = null, bd = 380;
      for (const q of this.players.values()) {
        if (q === p || (q.c === IDX.frog && q.abT > 0)) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bd) { bd = d; best = q; }
      }
      if (!best) { p.cd = 1.2; return; }                      // nobody in range: no cooldown wasted
      const ox = p.x, oy = p.y;
      p.x = best.x; p.y = best.y; best.x = ox; best.y = oy;
      p.tp = 1; best.tp = 1;
      best.stun = Math.max(best.stun, 0.55);
      this.resetHist(p); this.resetHist(best);
      this.emit({ k: 'ab', n: 'swap', id: p.id, x: r1(ox), y: r1(oy), x1: r1(p.x), y1: r1(p.y), dx: 0, dy: 0 });
      return;
    }
    this.emit({ k: 'ab', n: e.n, id: p.id, x: r1(e.x), y: r1(e.y), dx: r2(e.dx || 0), dy: r2(e.dy || 0), x1: e.x1 !== undefined ? r1(e.x1) : undefined, y1: e.y1 !== undefined ? r1(e.y1) : undefined });
  }

  popDecoy(d) {
    const i = this.decoys.indexOf(d); if (i < 0) return;
    this.decoys.splice(i, 1);
    this.emit({ k: 'pop', x: r1(d.x), y: r1(d.y), c: d.c });
  }

  tick() {
    this.tickN++;
    // ---- state timers
    if (this.state === STATE.COUNT) { this.timer -= DT; this.tl = Math.max(0, this.timer); if (this.timer <= 0) this.startPlay(); }
    else if (this.state === STATE.PLAY) { this.tl -= DT; if (this.tl <= 0) this.endRound(); }
    else if (this.state === STATE.RESULTS) {
      this.timer -= DT; this.tl = Math.max(0, this.timer);
      if (this.timer <= 0) { if (this.players.size >= 2) this.startCountdown(); else this.toWait(); }
    }

    // ---- players
    for (const p of this.players.values()) {
      if (p.bot) {
        thinkBot(this, p);
        this.runStep(p, p.input); p.input.a = 0;
        continue;
      }
      const ql = p.queue.length;
      if (!ql) continue;
      const n = ql > 8 ? 3 : ql > 4 ? 2 : 1;
      for (let k = 0; k < n && p.queue.length; k++) this.runStep(p, p.queue.shift());
    }

    // ---- position history (lag compensation) + penguin bowling
    const hi = this.tickN % HIST;
    for (const p of this.players.values()) { p.hx[hi] = p.x; p.hy[hi] = p.y; }
    for (const p of this.players.values()) {
      if (p.c !== IDX.penguin) continue;
      if (p.abT <= 0) { p.bowled = null; continue; }
      if (Math.hypot(p.vx, p.vy) < 170) continue;
      const rp = CHARS[p.c].radius;
      for (const q of this.players.values()) {
        if (q === p || (q.c === IDX.frog && q.abT > 0) || (p.bowled && p.bowled.has(q.id))) continue;
        const dx = q.x - p.x, dy = q.y - p.y, rr = rp + CHARS[q.c].radius + 6;
        if (dx * dx + dy * dy >= rr * rr) continue;
        const d = Math.hypot(dx, dy) || 1;
        (p.bowled || (p.bowled = new Set())).add(q.id);
        q.stun = Math.max(q.stun, 0.6); q.vx += (dx / d) * 520; q.vy += (dy / d) * 520;
        if (q.c === IDX.fox) q.abT = 0;
        this.emit({ k: 'ab', n: 'bowl', id: p.id, x: r1(q.x), y: r1(q.y), dx: r2(dx / d), dy: r2(dy / d) });
      }
    }

    // ---- decoys & goos
    for (const d of this.decoys.slice()) {
      d.ttl -= DT;
      if (d.ttl <= 0) { this.popDecoy(d); continue; }
      const sim = { x: d.x + d.vx * DT, y: d.y + d.vy * DT, vx: d.vx, vy: d.vy };
      const ovx = sim.vx, ovy = sim.vy;
      const hit = T.collide(this.map, sim, 16);
      T.clampBounds(this.map, sim, 16);
      if (hit || sim.vx !== ovx || sim.vy !== ovy) {
        if (Math.abs(sim.vx - ovx) > 1e-3) sim.vx = -ovx; else sim.vx = ovx;
        if (Math.abs(sim.vy - ovy) > 1e-3) sim.vy = -ovy; else sim.vy = ovy;
      }
      d.x = sim.x; d.y = sim.y; d.vx = sim.vx; d.vy = sim.vy;
    }
    for (let i = this.goos.length - 1; i >= 0; i--) { this.goos[i].ttl -= DT; if (this.goos[i].ttl <= 0) this.goos.splice(i, 1); }

    // ---- tagging & scoring
    if (this.state === STATE.PLAY) {
      const it = this.itPlayer();
      for (const p of this.players.values()) if (!p.it && !p.afk) p.score += DT;
      if (it) {
        const ri = CHARS[it.c].radius;
        for (const d of this.decoys.slice()) {
          if (d.o !== it.id && Math.hypot(d.x - it.x, d.y - it.y) < ri + 16) { this.popDecoy(d); it.stun = Math.max(it.stun, 1.0); }
        }
        if (it.stun <= 0 && it.lock <= 0) {
          // Generous reach (TAG_REACH) plus a little rewind for laggy taggers: they saw their target a moment in the past,
          // so a tag also counts if the target WAS in reach shortly before. Capped at LAG_COMP_MAX so dodging still works.
          const comp = it.bot ? 0 : T.clamp((it.rtt + 90) / 1000 * 0.8, 0, T.LAG_COMP_MAX), kmax = Math.min(HIST - 2, Math.round(comp * T.TICK));
          for (const q of this.players.values()) {
            if (q === it || q.imm > 0 || (q.c === IDX.frog && q.abT > 0)) continue;
            const rr = ri + CHARS[q.c].radius + T.TAG_REACH;
            let dx = q.x - it.x, dy = q.y - it.y, hit = dx * dx + dy * dy < rr * rr;
            if (!hit && kmax >= 2) {
              for (const k of [kmax >> 1, kmax]) {
                const j = (this.tickN - k + HIST * 4) % HIST, hx = q.hx[j] - it.x, hy = q.hy[j] - it.y;
                if (hx * hx + hy * hy < rr * rr) { hit = true; dx = hx; dy = hy; break; }
              }
            }
            if (!hit) continue;
            if (q.c === IDX.robot && q.abT > 0) {            // shield: block the tag, stun + shove the tagger, shield pops
              const d = Math.sqrt(dx * dx + dy * dy) || 1;
              q.abT = 0; it.stun = Math.max(it.stun, 0.8); it.vx = (-dx / d) * 520; it.vy = (-dy / d) * 520;
              this.emit({ k: 'ab', n: 'shieldhit', id: q.id, x: r1(q.x), y: r1(q.y), dx: r2(-dx / d), dy: r2(-dy / d) });
              break;
            }
            this.tag(it, q); break;
          }
        }
      } else if (this.players.size >= 2) this.reassignIt();
    }

    // ---- afk handling (once per second). Only counts while a round is being played: waiting in an empty lobby is fine.
    if (this.tickN % 60 === 0) {
      const now = Date.now();
      for (const p of [...this.players.values()]) {
        if (p.bot) continue;
        if (this.state !== STATE.PLAY) { p.lastActiveAt = now; p.afk = false; continue; }
        const idle = now - p.lastActiveAt;
        p.afk = idle > 6000;
        if (p.afk && p.it) { p.it = 0; this.reassignIt(); }
        if (idle > 25000 && p.ws) { this.send(p, { t: 'kick', m: 'You were removed for being inactive.' }); try { p.ws.close(); } catch (e) { /* noop */ } }
      }
    }

    // ---- network
    if (this.rosterDirty) { this.rosterDirty = false; this.broadcast({ t: 'roster', ps: this.roster() }); }
    if (this.tickN % SNAP_EVERY === 0) this.sendSnapshots();
    if (this.events.length) { this.broadcast({ t: 'ev', e: this.events }); this.events = []; }
  }

  /* ------------------------------ networking ---------------------------- */
  roster() { return [...this.players.values()].map((p) => ({ id: p.id, n: p.name, c: p.c, k: p.col, h: p.hat || 0, b: p.bot ? 1 : 0, a: p.uid ? 1 : 0 })); }

  send(p, obj) { if (p.ws && p.ws.readyState === 1) p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (!p.bot) this.send(p, s);
  }

  sendSnapshots() {
    const ps = [];
    for (const p of this.players.values()) {
      const flags = (p.it ? 1 : 0) | (p.stun > 0 ? 2 : 0) | (p.imm > 0 ? 4 : 0) | (p.afk ? 8 : 0);
      ps.push([p.id, r1(p.x), r1(p.y), r1(p.vx), r1(p.vy), r2(p.fx), r2(p.fy), flags, r2(p.abT), Math.floor(p.score), p.tags]);
    }
    const head = {
      t: 's', n: this.tickN, ts: performance.now(), s: this.state, tl: r1(this.tl), m: this.map.id, rd: this.round, it: this.itId, p: ps,
      g: this.goos.map((g) => [g.id, r1(g.x), r1(g.y), g.r, g.o, r1(g.ttl), g.splash ? 1 : 0]),
      d: this.decoys.map((d) => [d.id, r1(d.x), r1(d.y), r1(d.vx), r1(d.vy), d.c, d.k, d.o, r1(d.ttl)]),
    };
    if (this.state === STATE.RESULTS) head.res = this.results;
    const base = JSON.stringify(head).slice(0, -1);
    for (const p of this.players.values()) {
      if (p.bot || !p.ws || p.ws.readyState !== 1) continue;
      if (p.ws.bufferedAmount > 512 * 1024) continue;       // slow client: skip this frame
      p.ws.send(base + ',"me":' + JSON.stringify(T.packSim(p)) + ',"ack":' + p.ack + '}');
    }
  }
}

module.exports = { Room };
