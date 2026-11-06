'use strict';
/* Bot AI: grid navigation (BFS flow fields) + simple steering.
   Chasers follow a path field toward their target; runners pick a "safe" cell
   they can reach before the tagger does. Bots use their characters' abilities. */
const T = require('../public/shared.js');

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
  let use = false;
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
    else if (id === 'bat') use = p.aux > 0 ? d < 130 : p.cd <= 0 && d > 240 && d < 520;     // drop a beacon while safe, snap back when IT closes in
  }
  if (use && Math.random() < DIFFS[room.diff || 'normal'].abil) p.input.a = 1;
}

function thinkBot(room, p) {
  if (room.state !== T.STATE.PLAY) { p.input.x = 0; p.input.y = 0; return; }
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
      if (q === p) continue;
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < fd) { fd = d; fallback = q; }
      if (q.imm > 0.25) continue;
      if (q.c === IDX.frog && q.abT > 0) continue;
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
  const itp = room.itPlayer();
  if (!itp) { p.input.x = 0; p.input.y = 0; return; }
  const d = Math.hypot(p.x - itp.x, p.y - itp.y);
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
  if (!room.itDist || room.itDist.length !== nav.n) { room.itDist = new Int16Array(nav.n); room.itPar = new Int32Array(nav.n); room.itFieldTick = -999; }
  if (room.itFieldTick + 8 <= room.tickN || room.itFieldFor !== itp.id) {
    nav.bfs(nav.idx(itp.x, itp.y), room.itDist, room.itPar, 9999);
    room.itFieldTick = room.tickN; room.itFieldFor = itp.id;
  }
  let bestC = -1, bestS = -1e9;
  for (let i = 0; i < nav.n; i++) {
    const dm = ai.dist[i]; if (dm < 0) continue;
    const di = room.itDist[i]; if (di < 0) continue;
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
