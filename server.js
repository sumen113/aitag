'use strict';
/* Tag Rush server: static site + WebSocket game server in one Node process.
   Matchmaking: everyone who hits "Play" joins one shared public pool. Rooms hold up to 15 players;
   when every room is full a new one opens. "Practice vs bots" opens a private solo room with bots. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const T = require('./public/shared.js');
const { Room } = require('./src/room');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_ROOMS = 150;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.webp': 'image/webp',
};

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

const rooms = new Map();
function stats() {
  let players = 0, pub = 0;
  for (const r of rooms.values()) { players += r.humanCount(); if (!r.solo) pub++; }
  return { ok: true, players, rooms: pub, uptime: Math.round(process.uptime()) };
}

const server = http.createServer((req, res) => {
  let url;
  try { url = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (url === '/health' || url === '/api/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(stats()));
  }
  if (url === '/') url = '/index.html';
  const f = files.get(url);
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  const headers = {
    'Content-Type': f.type, 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': f.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (f.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
    res.writeHead(200, headers); return res.end(f.gz);
  }
  res.writeHead(200, headers); res.end(f.buf);
});

/* ------------------------------- matchmaking ------------------------------ */
let nextRoomId = 1;
function createRoom(opts) { const r = new Room('R' + nextRoomId++, opts); rooms.set(r.code, r); return r; }

function hasName(room, name) {
  const n = name.toLowerCase();
  for (const p of room.players.values()) if (p.name.toLowerCase() === n) return true;
  return false;
}

/** Fill the busiest public room that has space (and no clashing name); if none, open a new one. */
function findPublicRoom(name) {
  let best = null;
  for (const r of rooms.values()) {
    if (r.solo || r.humanCount() >= T.MAX_PLAYERS || hasName(r, name)) continue;
    if (!best || r.humanCount() > best.humanCount()) best = r;
  }
  return best || createRoom({ kind: 'public' });
}

/* ------------------------------- websocket -------------------------------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096, perMessageDeflate: false });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const c = { room: null, player: null, tokens: 120, last: Date.now() };
  const fail = (m) => { try { ws.send(JSON.stringify({ t: 'err', m })); } catch (e) { /* closed */ } };

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const now = Date.now();                                   // token-bucket rate limit
    c.tokens = Math.min(120, c.tokens + (now - c.last) * 0.1); c.last = now;
    if (--c.tokens < 0) return;
    let m; try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'in') { if (c.player && Array.isArray(m.i)) c.room.queueInputs(c.player, m.i.slice(0, 12)); }
    else if (m.t === 'p') { ws.send(JSON.stringify({ t: 'pg', ts: m.ts })); }
    else if (m.t === 'emote') { if (c.player) c.room.emote(c.player, T.clamp(m.e | 0, 0, 4)); }
    else if (m.t === 'join' && !c.player) {
      const v = T.validateName(m.name);
      if (!v.ok) return fail(v.err);
      const ch = T.clamp(m.c | 0, 0, T.CHARS.length - 1), col = T.clamp(m.k | 0, 0, T.COLORS.length - 1);
      let room;
      if (m.mode === 'bots') {
        if (rooms.size >= MAX_ROOMS) return fail('The server is busy right now. Try again in a moment.');
        room = createRoom({ kind: 'bots', diff: m.diff });
      } else room = findPublicRoom(v.name);
      c.room = room; c.player = room.addHuman(ws, v.name, ch, col);
      ws.send(JSON.stringify({ t: 'init', id: c.player.id, solo: room.solo, map: room.map.id, roster: room.roster() }));
    }
  });

  ws.on('close', () => {
    if (!c.player) return;
    const room = c.room; room.removePlayer(c.player); c.player.ws = null;
    if (room.humanCount() === 0) rooms.delete(room.code);
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
    for (const r of rooms.values()) { try { r.tick(); } catch (e) { console.error('room tick error', e); } }
    acc -= STEP_MS; n++;
  }
  if (n === 4) acc = 0;                                       // fell far behind: drop the backlog
}, 6);

// drop dead sockets (also keeps idle connections alive behind Render's proxy)
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); }
}, 15000);

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log(`Tag Rush listening on :${PORT}`));
  process.on('SIGTERM', () => { server.close(); process.exit(0); });
}
module.exports = { server, rooms, createRoom, findPublicRoom };
