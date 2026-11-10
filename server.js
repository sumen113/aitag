'use strict';
/* Tag Rush server: static site + account API + WebSocket game server in one Node process.
   Matchmaking: everyone who hits "Play" joins one shared public pool. Rooms hold up to 15 players;
   when every room is full a new one opens. "Practice vs bots" opens a private solo room with bots. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const T = require('./public/shared.js');
const { Room } = require('./src/room');
const db = require('./src/db');
const authLib = require('./src/auth');
const adminLib = require('./src/admin');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_ROOMS = 150;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.webp': 'image/webp',
};
const CSP = "default-src 'self'; script-src 'self' https://cloud.umami.is; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss: https://cloud.umami.is https://gateway.umami.is https://api-gateway.umami.dev; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/* ------------------------------ static files ------------------------------ */
const files = new Map();
(function load(dir, prefix) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name), url = prefix + name;
    if (fs.statSync(full).isDirectory()) { load(full, url + '/'); continue; }
    const buf = fs.readFileSync(full), ext = path.extname(name).toLowerCase();
    const text = ['.html', '.js', '.css', '.svg', '.json', '.txt'].includes(ext);
    const immutable = /^(fonts|vendor)\//.test(url);
    files.set('/' + url, { buf, gz: text ? zlib.gzipSync(buf, { level: 9 }) : null, type: MIME[ext] || 'application/octet-stream', immutable });
  }
})(PUBLIC, '');

/* -------------------------------- accounts -------------------------------- */
let store = null, auth = null, admin = null;
const activeUsers = new Map();                                 // user id -> { ws }  (one live game connection per account)

/** Open the account store (Postgres when DATABASE_URL is set, a dev JSON file otherwise). Safe to call once. */
async function init(opts = {}) {
  try {
    store = await db.open(opts);
    admin = adminLib.create({ store, rooms, activeUsers, wss, opts: opts.admin });
    await admin.load();
    auth = authLib.create(store, Object.assign({}, opts.auth, { isAdmin: admin.isAdmin, isBanned: admin.banReason }));
    console.log(`Accounts: ${store.kind === 'postgres' ? 'Postgres' : 'LOCAL FILE (dev only - set DATABASE_URL in production, files are wiped on redeploy)'}`);
  } catch (e) {
    store = null; auth = null; admin = null;
    console.error('Accounts are unavailable (guests can still play):', e.message);
  }
  return !!store;
}

const rooms = new Map();
const board = { list: null, at: 0 };                            // leaderboard cache
function stats() {
  let players = 0, pub = 0;
  for (const r of rooms.values()) { players += r.humanCount(); if (!r.solo) pub++; }
  return { ok: true, players, rooms: pub, uptime: Math.round(process.uptime()), accounts: !!store, banner: admin ? admin.banner() : '' };
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (url === '/health' || url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(stats()));
  }
  if (url === '/api/servers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ servers: serverList(), limits: T.SERVER_LIMITS, maps: T.MAPS.map((m) => ({ id: m.id, name: m.name })) }));
  }
  if (url === '/api/leaderboard' && req.method === 'GET') {
    try {
      if (!store) throw new Error('no store');
      if (!board.list || Date.now() - board.at > 20000) { board.list = (await store.topWins(150)).map((r) => ({ username: r.username, wins: r.wins - (admin ? admin.lbBase(r.username) : 0) })).filter((r) => r.wins > 0 && !(admin && admin.banReason(r.username))).sort((a, b) => b.wins - a.wins).slice(0, 100); board.at = Date.now(); }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ top: board.list }));
    } catch (e) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end('{"top":[]}'); }
  }
  if (url.startsWith('/api/hq/')) url = '/api/admin/' + url.slice(8);          // same API, a name school web filters don't block
  if (url.startsWith('/api/admin/') && admin && auth) { if (await admin.handle(req, res, url, auth)) return; }
  if (url.startsWith('/api/')) {
    if (auth) { if (await auth.handle(req, res, url)) return; }
    else if (url === '/api/me') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ accounts: false, user: null, shop: T.SHOP })); }
    else { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end('{"error":"Accounts are unavailable right now."}'); }
    res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":"Not found"}');
  }
  if (url === '/') url = '/index.html';
  else if (url === '/hq' || url === '/admin') url = '/hq.html';
  const f = files.get(url);
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const headers = {
    'Content-Type': f.type, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin',
    'Cache-Control': f.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (url === '/index.html' || url === '/hq.html') headers['Content-Security-Policy'] = CSP;
  if (url === '/hq.html') headers['Cache-Control'] = 'no-store';
  if (f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers); return res.end(f.gz);
  }
  res.writeHead(200, headers); res.end(f.buf);
});
server.on('connection', (s) => s.setNoDelay(true));            // no Nagle batching: every small game packet leaves immediately

/* ------------------------------- matchmaking ------------------------------ */
let nextRoomId = 1;
function createRoom(opts) {
  const r = new Room('R' + nextRoomId++, opts); rooms.set(r.code, r);
  if (!r.solo) r.onWin = (p) => {
    if (!store || !p.uid) return;
    store.addWin(p.uid).then((u) => { if (u) r.send(p, { t: 'award', wins: u.wins, balance: u.wins - u.spent }); }).catch((e) => console.error('addWin failed', e.message));
  };
  return r;
}

function hasName(room, name) {
  const n = name.toLowerCase();
  for (const p of room.players.values()) if (p.name.toLowerCase() === n) return true;
  return false;
}

/** Regular server: fill the busiest regular lobby that has space (and no clashing name); if none, open another lobby. */
function findPublicRoom(name) {
  let best = null;
  for (const r of rooms.values()) {
    if (!r.regular || r.humanCount() >= r.max || hasName(r, name)) continue;
    if (!best || r.humanCount() > best.humanCount()) best = r;
  }
  return best || createRoom({ kind: 'public' });
}
/** The Regular server always exists, even when nobody is in it. */
function ensureRegular() { for (const r of rooms.values()) if (r.regular) return r; return createRoom({ kind: 'public' }); }

/** What the server browser shows: the Regular server (all its lobbies as one entry) first, then player-made servers. */
function serverList() {
  let reg = { id: 'regular', name: T.REGULAR_NAME, regular: true, players: 0, max: T.MAX_PLAYERS, lobbies: 0, time: T.ROUND_TIME, state: 0 };
  let bestState = -1;
  const custom = [];
  for (const r of rooms.values()) {
    if (r.solo) continue;
    const n = r.humanCount();
    if (r.regular) { reg.players += n; reg.lobbies++; if (n > bestState) { bestState = n; reg.state = r.state; } }
    else custom.push({ id: r.code, name: r.name, regular: false, players: n, max: r.max, time: r.roundTime, map: r.mapMode, state: r.state, full: n >= r.max, bots: r.botTarget, lock: !!r.lock });
  }
  custom.sort((a, b) => b.players - a.players || a.name.localeCompare(b.name));
  return [reg, ...custom];
}
const CUSTOM_CAP = 40;
const crypto = require('crypto');
function lockFor(pass) { if (!pass) return null; const salt = crypto.randomBytes(8); return { salt, hash: crypto.scryptSync(pass, salt, 32) }; }
function lockOk(lock, pass) { if (!lock) return true; try { return crypto.timingSafeEqual(crypto.scryptSync(String(pass || '').slice(0, 64), lock.salt, 32), lock.hash); } catch (e) { return false; } }
const passFails = new Map();                                    // ip -> [timestamps] of wrong password tries
function passBlocked(key) { const now = Date.now(), a = (passFails.get(key) || []).filter((t) => now - t < 60e3); passFails.set(key, a); return a.length >= 8; }
function passFail(key) { const a = passFails.get(key) || []; a.push(Date.now()); passFails.set(key, a); }
setInterval(() => { const now = Date.now(); for (const [k, v] of passFails) if (!v.some((t) => now - t < 60e3)) passFails.delete(k); }, 60e3).unref();
const createLog = new Map();                                    // ip -> timestamps of recent server creations
function mayCreate(key) {
  const now = Date.now(), arr = (createLog.get(key) || []).filter((t) => now - t < 600e3);
  if (arr.length >= 3) { createLog.set(key, arr); return false; }
  arr.push(now); createLog.set(key, arr); return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of createLog) if (!v.some((t) => now - t < 600e3)) createLog.delete(k); }, 600e3).unref();

/* ------------------------------- websocket -------------------------------- */
const wss = new WebSocketServer({
  server, path: '/ws', maxPayload: 4096, perMessageDeflate: false,
  verifyClient: (info) => {                                    // browsers always send Origin: it must be this site
    const o = info.origin; if (!o) return true;
    try { return new URL(o).host === info.req.headers.host; } catch (e) { return false; }
  },
});

wss.on('connection', (ws, req) => {
  ws.lastPong = Date.now(); ws.rtt = 0; ws.pingAt = 0;
  ws.on('pong', () => {
    const now = performance.now(); ws.lastPong = Date.now();
    if (ws.pingAt) { const rtt = now - ws.pingAt; ws.rtt = ws.rtt ? ws.rtt * 0.6 + rtt * 0.4 : rtt; if (c.player) c.player.rtt = ws.rtt; }
  });
  const c = { room: null, player: null, user: null, joining: false, tokens: 120, last: Date.now() };
  const fail = (m) => { try { ws.send(JSON.stringify({ t: 'err', m })); } catch (e) { /* closed */ } };

  const ipKeyOf = () => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '?';
  async function join(m) {
    const mode = m.mode === 'bots' ? 'bots' : 'online';
    let user = null;
    if (auth) { try { user = await auth.userFromCookie(req.headers.cookie); } catch (e) { return fail('Could not check your login. Try again in a moment.'); } }
    let name;
    if (user) name = user.username;
    else {
      const v = T.validateName(m.name); if (!v.ok) return fail(v.err);
      name = v.name;
      if (store) { try { if (await store.nameTaken(name)) return fail('That name belongs to a registered player. Log in to use it, or pick another.'); } catch (e) { /* db hiccup: let the guest in */ } }
    }
    const ci = T.clamp(m.c | 0, 0, T.CHARS.length - 1), col = T.cleanColor(m.k), hat = T.cleanHat(m.h);
    const ks = T.cleanColorList(m.ks, T.CHARS.length); ks[ci] = col;        // each character keeps its own colour
    const owns = T.ownsChar(user ? user.owned : [], T.CHARS[ci].id);
    if (!owns && mode !== 'bots') return fail(user ? 'You have not unlocked that character yet. Visit the shop.' : 'Guests can only play the starter characters. Log in to use more.');
    if (ws.readyState !== 1) return;
    let room;
    if (mode === 'bots') {
      if (rooms.size >= MAX_ROOMS) return fail('The server is busy right now. Try again in a moment.');
      room = createRoom({ kind: 'bots', diff: m.diff });
    } else if (typeof m.create === 'object' && m.create) {
      const v = T.validateServer(m.create); if (!v.ok) return fail(v.err);
      const ipKey = ipKeyOf();
      let customs = 0, taken = false;
      for (const r of rooms.values()) if (!r.solo && !r.regular) { customs++; if (r.name.toLowerCase() === v.name.toLowerCase()) taken = true; }
      if (taken) return fail('A server with that name already exists. Pick another name or join it.');
      if (customs >= CUSTOM_CAP || rooms.size >= MAX_ROOMS) return fail('There are too many servers open right now. Join an existing one.');
      if (!mayCreate(user ? 'u' + user.id : ipKey)) return fail('You can only create 3 servers every 10 minutes. Join one instead.');
      room = createRoom({ kind: 'custom', name: v.name, roundTime: v.time, max: v.max, bots: v.bots, diff: v.diff, lock: lockFor(v.pass), mapMode: v.map === 'random' ? 'rotate' : v.map });
    } else if (m.server && m.server !== 'regular') {
      room = rooms.get(String(m.server));
      if (!room || room.solo || room.regular) return fail('That server has closed. Pick another one.');
      if (room.humanCount() >= room.max) return fail('That server is full.');
      if (room.lock) {
        if (passBlocked(ipKeyOf())) return fail('Too many wrong passwords. Wait a minute and try again.');
        if (!lockOk(room.lock, m.pass)) { passFail(ipKeyOf()); return fail(m.pass ? 'Wrong password.' : 'This server needs a password.'); }
      }
      if (hasName(room, name)) return fail('Someone with that name is already in that server.');
    } else room = findPublicRoom(name);
    if (user) {
      const old = activeUsers.get(user.id);                    // same account in two tabs: the newest wins
      if (old && old.ws !== ws) { try { old.ws.send(JSON.stringify({ t: 'kick', m: 'You signed in somewhere else.' })); old.ws.close(); } catch (e) { /* gone */ } }
      activeUsers.set(user.id, { ws });
      if (owns) store.saveSettings(user.id, { c: T.CHARS[ci].id, k: col, h: hat, ks }).catch(() => {});
    }
    c.user = user; c.room = room; c.player = room.addHuman(ws, name, ci, col, user ? user.id : 0, hat);
    c.player.staff = !!(user && admin && admin.isAdmin(user.username));
    c.player.muted = !!(admin && admin.isMuted(name, !!user));
    c.player.rtt = ws.rtt;
    ws.send(JSON.stringify({ t: 'init', id: c.player.id, solo: room.solo, map: room.map.id, roster: room.roster(), name, acct: !!user, sv: { name: room.name, regular: room.regular, max: room.max, time: room.roundTime, bots: room.botTarget, lock: !!room.lock } }));
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now();                                   // token-bucket rate limit
    c.tokens = Math.min(120, c.tokens + (now - c.last) * 0.1); c.last = now;
    if (--c.tokens < 0) return;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'in') { if (c.player && Array.isArray(m.i)) c.room.queueInputs(c.player, m.i.slice(0, 12)); }
    else if (m.t === 'p') { ws.send(JSON.stringify({ t: 'pg', ts: m.ts, r: Math.round(ws.rtt) })); }
    else if (m.t === 'chat') {
      if (c.player && typeof m.m === 'string') {
        if (c.player.muted) { if (now - (c.mutedNote || 0) > 5000) { c.mutedNote = now; ws.send(JSON.stringify({ t: 'announce', m: 'You are muted by an admin.', p: 1 })); } }
        else c.room.chat(c.player, m.m.slice(0, 200));
      }
    }
    else if (m.t === 'typing') { if (c.player) c.player.lastActiveAt = now; }
    else if (m.t === 'join' && !c.player && !c.joining) {
      c.joining = true;
      join(m).catch((e) => { console.error('join error', e); fail('Could not join. Please try again.'); }).finally(() => { c.joining = false; });
    }
  });

  ws.on('close', () => {
    if (c.user) { const a = activeUsers.get(c.user.id); if (a && a.ws === ws) activeUsers.delete(c.user.id); }
    if (!c.player) return;
    const room = c.room; room.removePlayer(c.player); c.player.ws = null;
    if (room.humanCount() === 0) {
      rooms.delete(room.code);
      if (room.regular) ensureRegular();                       // the Regular server never disappears: a fresh empty lobby takes its place
    }
  });
  ws.on('error', () => {});
});

/* ------------------------------- main loop -------------------------------- */
const STEP_MS = 1000 / T.TICK;
let last = performance.now(), acc = 0;
setInterval(() => {
  const now = performance.now(); acc += now - last; last = now;
  let n = 0;
  while (acc >= STEP_MS && n < 4) {
    for (const r of rooms.values()) { if (!r.solo && r.humanCount() === 0) continue; try { r.tick(); } catch (e) { console.error('room tick error', e); } }
    acc -= STEP_MS; n++;
  }
  if (n === 4) acc = 0;                                       // fell far behind: drop the backlog
}, 6);

// latency probe every 2 s (also keeps idle connections alive behind Render's proxy); drop sockets that stopped answering
setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    if (now - ws.lastPong > 30000) { ws.terminate(); continue; }
    ws.pingAt = performance.now(); try { ws.ping(); } catch (e) { /* closing */ }
  }
}, 2000);

if (require.main === module) {
  ensureRegular();
  server.listen(PORT, '0.0.0.0', () => console.log(`Tag Rush listening on :${PORT}`));
  init();
  process.on('SIGTERM', () => { server.close(); if (store) store.close().catch(() => {}); process.exit(0); });
}
module.exports = { resetLimits: () => createLog.clear(), resetBoard: () => { board.list = null; }, server, rooms, createRoom, findPublicRoom, ensureRegular, serverList, init, getStore: () => store };
