'use strict';
/* Integration test: boots the real server, connects many ws clients, checks matchmaking, name rules,
   the 15-player rollover, bot rooms, garbage input handling, snapshot sanity and client-prediction drift.
   Usage: node tools/fuzz.js */
const WebSocket = require('ws');
const T = require('../public/shared.js');
process.env.PORT = process.env.PORT || '3077';
const srv = require('../server.js'); srv.server.listen(+process.env.PORT, '127.0.0.1');
const BASE = 'http://127.0.0.1:' + process.env.PORT;
const STI = T.STARTERS.map((id) => T.CHARS.findIndex((c) => c.id === id));      // starter character indexes
const URL = 'ws://127.0.0.1:' + process.env.PORT + '/ws';
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } else console.log('  ok  :', m); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(join, opts = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL, opts.cookie ? { headers: { cookie: opts.cookie } } : undefined), c = { ws, init: null, err: null, snaps: 0, last: null, ack: 0, seq: 0, closed: false, bad: 0, ev: [] };
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ t: 'join' }, join))));
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.t === 'init') { c.init = m; resolve(c); }
      else if (m.t === 'err') { c.err = m.m; resolve(c); }
      else if (m.t === 's') {
        c.snaps++; c.last = m;
        for (const p of m.p) for (let i = 1; i <= 4; i++) if (!Number.isFinite(p[i])) c.bad++;
        for (const v of m.me) if (!Number.isFinite(v)) c.bad++;
      } else if (m.t === 'ev') c.ev.push(...m.e);
    });
    ws.on('close', () => { c.closed = true; resolve(c); });
    c.input = (x, y, a) => ws.send(JSON.stringify({ t: 'in', i: [[++c.seq, x, y, a ? 1 : 0]] }));
  });
}

/** Register an account over HTTP and (optionally) give it wins + items straight in the store. Returns a cookie header. */
async function account(name, { wins = 0, items = [] } = {}) {
  const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'correct-horse-9' }) });
  if (r.status !== 200) throw new Error('register ' + name + ' -> ' + r.status + ' ' + (await r.text()));
  const cookie = r.headers.get('set-cookie').split(';')[0];
  const store = srv.getStore(), u = await store.userByName(name);
  for (let i = 0; i < wins; i++) await store.addWin(u.id);
  for (const it of items) { const x = await store.buy(u.id, 'char:' + it, T.SHOP_BY_ID['char:' + it].price); if (!x.ok) throw new Error('buy ' + it + ': ' + x.err); }
  return { cookie, id: u.id };
}
const post = (url, body, cookie) => fetch(BASE + url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}), body: JSON.stringify(body) });

(async () => {
  await srv.init({ file: null, auth: { registerPerHour: 500, loginPerIp: 500, loginPerUser: 500 } });
  console.log('name validation');
  for (const [n, good] of [['', false], ['a', false], ['Alex', true], ['<script>', false], ['x'.repeat(15), false], ['Ünï Cøde', true], ['José', true], ['fuck', false], ['grape', true], ['Hancock', true]]) {
    ok(T.validateName(n).ok === good, `"${n}" -> ${good ? 'accepted' : 'rejected'}`);
  }
  let c = await client({ name: '', mode: 'online', c: 0, k: 0 });
  ok(!!c.err, 'server rejects empty name: ' + c.err); c.ws.close();
  c = await client({ name: 'bad<>name', mode: 'online', c: 0, k: 0 });
  ok(!!c.err, 'server rejects symbols: ' + c.err); c.ws.close();

  console.log('15-player rollover');
  const humans = [];
  for (let i = 0; i < 16; i++) humans.push(await client({ name: 'P' + i, mode: 'online', c: STI[i % 3], k: i % 8 }));
  const roomsAfter = [...srv.rooms.values()].filter((r) => !r.solo);
  ok(roomsAfter.length === 2, 'public rooms after 16 joins = 2 (got ' + roomsAfter.length + ')');
  ok(roomsAfter.some((r) => r.humanCount() === 15) && roomsAfter.some((r) => r.humanCount() === 1), 'split is 15 + 1');
  ok(roomsAfter.every((r) => [...r.players.values()].every((p) => !p.bot)), 'public rooms contain no bots');
  const second = humans[15].init;
  ok(second.solo === false, 'overflow player is in a public room');

  console.log('name clash goes to another lobby');
  const dup = await client({ name: 'p3', mode: 'online', c: STI[1], k: 0 });
  const roomOf = (cl) => [...srv.rooms.values()].find((r) => [...r.players.values()].some((p) => p.ws && p.ws === [...r.players.values()].find((q) => q.id === cl.init.id)?.ws));
  const r3 = [...srv.rooms.values()].find((r) => [...r.players.values()].some((p) => p.name === 'P3'));
  const rd = [...srv.rooms.values()].find((r) => [...r.players.values()].some((p) => p.name === 'p3'));
  ok(r3 && rd && r3 !== rd, 'duplicate name (case-insens.) placed in a different room');

  console.log('someone leaves -> slot is reused');
  humans[0].ws.close(); await sleep(200);
  const refill = await client({ name: 'Newcomer', mode: 'online', c: STI[2], k: 0 });
  const full = [...srv.rooms.values()].filter((r) => !r.solo && r.humanCount() >= 15);
  ok(full.length === 1, 'busiest room is refilled to 15 again');

  console.log('bots mode');
  const solo = await client({ name: 'Solo', mode: 'bots', diff: 'hard', c: 7, k: 0 });
  ok(solo.init && solo.init.solo === true, 'bots room is solo');
  ok(solo.init.roster.filter((p) => p.b).length === 4, 'bots room has 4 bots');
  ok(solo.init.roster.every((p) => !p.b || /^[A-Za-z]/.test(p.n)), 'bots have names');

  console.log('accounts, ownership, shop');
  const lockedIdx = T.CHARS.findIndex((x) => x.id === 'frog');
  let gc = await client({ name: 'Sneaky', mode: 'online', c: lockedIdx, k: 0 });
  ok(/starter/i.test(gc.err || ''), 'guest cannot join with a locked character: ' + gc.err);
  const pr = await client({ name: 'TryIt', mode: 'bots', diff: 'easy', c: lockedIdx, k: 0 });
  ok(pr.init && pr.init.solo, 'practice mode lets anyone try a locked character'); pr.ws.close();
  const alex = await account('Alexa', { wins: 5 });
  gc = await client({ name: 'Alexa', mode: 'online', c: STI[0], k: 0 });
  ok(/registered/i.test(gc.err || ''), 'guest cannot take a registered name: ' + gc.err);
  let ac = await client({ name: 'IgnoredName', mode: 'online', c: lockedIdx, k: 0 }, { cookie: alex.cookie });
  ok(/shop|unlocked/i.test(ac.err || ''), 'account cannot use a character it has not bought: ' + ac.err);
  const b1 = await post('/api/shop/buy', { item: 'char:frog' }, alex.cookie), j1 = await b1.json();
  ok(b1.status === 200 && j1.user.balance === 2 && j1.user.owned.includes('char:frog'), 'buy frog for 3 wins -> balance 2');
  const b2 = await post('/api/shop/buy', { item: 'char:frog' }, alex.cookie);
  ok(b2.status === 400, 'cannot buy the same item twice');
  const b3 = await post('/api/shop/buy', { item: 'char:bat' }, alex.cookie);
  ok(b3.status === 400, 'cannot buy what you cannot afford');
  const race = await Promise.all([1, 2, 3, 4].map(() => post('/api/shop/buy', { item: 'char:cat' }, alex.cookie).then((r) => r.status)));
  ok(race.filter((x) => x === 200).length === 0 && (await (await fetch(BASE + '/api/me', { headers: { cookie: alex.cookie } })).json()).user.balance === 2, 'cat costs 3 > balance 2: all concurrent buys refused, balance intact');
  ac = await client({ name: 'IgnoredName', mode: 'online', c: lockedIdx, k: 2 }, { cookie: alex.cookie });
  ok(ac.init && ac.init.name === 'Alexa' && ac.init.acct === true, 'account joins as its own username with the bought frog');
  const ac2 = await client({ name: 'x', mode: 'online', c: STI[0], k: 0 }, { cookie: alex.cookie });
  await sleep(200);
  ok(ac.closed, 'second connection on the same account kicks the first');
  ac = ac2;
  const roomA = [...srv.rooms.values()].find((r) => [...r.players.values()].some((p) => p.name === 'Alexa' && p.ws));
  const pa = [...roomA.players.values()].find((p) => p.name === 'Alexa' && p.ws);
  let award = null; ac.ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'award') award = m; });
  roomA.onWin(pa); await sleep(250);
  ok(award && award.wins === 6 && award.balance === 3, 'win is saved and reported: ' + JSON.stringify(award));
  const badLogin = await post('/api/login', { username: 'Alexa', password: 'nope-nope-nope' });
  ok(badLogin.status === 401, 'wrong password rejected');
  const csrf = await fetch(BASE + '/api/logout', { method: 'POST', headers: { 'content-type': 'text/plain', origin: 'http://evil.example' }, body: '{}' });
  ok(csrf.status === 403, 'cross-site / non-JSON POST refused');

  console.log('chat');
  const cr = await client({ name: 'Chatty1', mode: 'online', c: STI[0], k: 0 }), cs = await client({ name: 'Chatty2', mode: 'online', c: STI[1], k: 0 });
  const rc = [...srv.rooms.values()].find((r) => [...r.players.values()].some((p) => p.name === 'Chatty1'));
  const rcs = [...srv.rooms.values()].find((r) => [...r.players.values()].some((p) => p.name === 'Chatty2'));
  if (rc !== rcs) { cs.ws.close(); }                       // (rooms fill by busiest first, so these normally share a room)
  cr.ws.send(JSON.stringify({ t: 'chat', m: 'hello   world visit http://evil.example now' })); await sleep(150);
  cr.ws.send(JSON.stringify({ t: 'chat', m: 'too fast' })); await sleep(100);
  await sleep(700);
  cr.ws.send(JSON.stringify({ t: 'chat', m: 'x\u0007y  fuck this' })); await sleep(200);
  const chats = cr.ev.filter((e) => e.k === 'chat');
  ok(chats.length === 2, 'chat broadcast, rate limiter dropped the 2nd message (got ' + chats.length + ')');
  ok(chats[0] && chats[0].m === 'hello world visit [link] now' && chats[0].n === 'Chatty1', 'whitespace collapsed + link masked: ' + (chats[0] && chats[0].m));
  ok(chats[1] && !/fuck/i.test(chats[1].m), 'bad word masked: ' + (chats[1] && chats[1].m));
  for (const x of [cr, cs, ac, ac2, alex]) try { x.ws && x.ws.close(); } catch (e) { /* noop */ }

  console.log('garbage + rate limit');
  const g = await client({ name: 'Garbage', mode: 'online', c: STI[0], k: 0 });
  for (const junk of ['not json', '{"t":1}', '{"t":"in","i":"x"}', '{"t":"in","i":[[1,"a",null,{}]]}', '{"t":"emote","e":"zz"}', '[]', 'null', '{"t":"in","i":[[1e999,1e999,1e999,1]]}', '{"t":"join","name":"again"}'])
    g.ws.send(junk);
  g.ws.send(Buffer.from([1, 2, 3]));
  for (let i = 0; i < 400; i++) g.ws.send('{"t":"p","ts":1}');
  g.ws.send('x'.repeat(5000));                              // > maxPayload: server should close this socket only
  await sleep(300);
  ok(g.closed, 'oversized frame closes only that socket');
  ok(srv.server.listening, 'server still up after garbage');

  console.log('simulation (8 s, random inputs on several clients)');
  const bots = [solo, ...humans.slice(1, 6)];
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    for (const b of bots) if (!b.closed) b.input(Math.round((Math.random() * 2 - 1) * 4) / 4, Math.round((Math.random() * 2 - 1) * 4) / 4, Math.random() < 0.1);
    await sleep(33);
  }
  ok(bots.every((b) => b.snaps > 150), 'snapshots flowing (~30 Hz): ' + bots.map((b) => b.snaps).join(','));
  ok(bots.every((b) => b.bad === 0), 'no NaN/Infinity in any snapshot');
  const sn = solo.last;
  ok(sn.p.every((p) => p[1] >= 0 && p[1] <= 2000 && p[2] >= 0 && p[2] <= 1300), 'all positions inside the arena');
  ok(sn.p.filter((p) => p[7] & 1).length <= 1, 'at most one IT');

  console.log('prediction drift: replay client inputs through the shared sim and compare with the server');
  for (const h of [...humans, dup, refill, solo]) try { h.ws.close(); } catch (e) { /* noop */ }   // a lone player: no tags/stomps to confuse the replay
  await sleep(400);
  const driftIds = ['fox', 'frog', 'ghost', 'bear', 'penguin', 'cat', 'bat'];
  for (const cid of driftIds) {                              // dash, leap, phase, stomp, slide, cloak+pounce, beacon+recall
    const ci = T.CHARS.findIndex((x) => x.id === cid);
    const acc = await account('Drift' + cid, { wins: 20, items: T.CHARS[ci].starter ? [] : [cid] });
    const d = await client({ name: 'x', mode: 'online', c: ci, k: 0 }, { cookie: acc.cookie });
    const map = T.MAP_BY_ID[d.init.map], ctx = { map, goos: [] };
    const inputs = new Map(); let first = null, mid = null;
    const t1 = Date.now();
    while (Date.now() - t1 < 9000) {
      const tt = Date.now() / 1000;
      const x = Math.round(Math.sin(tt * 1.3) * 4) / 4, y = Math.round(Math.cos(tt * 0.9) * 4) / 4, a = Math.random() < (cid === 'cat' || cid === 'bat' ? 0.07 : 0.03) ? 1 : 0;
      inputs.set(d.seq + 1, { s: d.seq + 1, x, y, a });
      d.input(x, y, a);
      if (d.last && !first) first = { me: d.last.me.slice(), ack: d.last.ack };
      await sleep(16);
    }
    await sleep(150);
    const last = { me: d.last.me.slice(), ack: d.last.ack };
    const sim = T.newSim(d.init.id, ci, 0, 0); T.unpackSim(sim, first.me);
    for (let s = first.ack + 1; s <= last.ack; s++) T.stepPlayer(sim, inputs.get(s), ctx, null);
    const exp = T.packSim(sim), err = Math.max(...exp.map((v, i) => Math.abs(v - last.me[i])));
    ok(err < 0.5, `${T.CHARS[ci].species}: replayed ${last.ack - first.ack} inputs, max field error vs server = ${err.toFixed(3)}`);
    d.ws.close(); await sleep(200);
  }

  for (const x of [...humans, dup, refill, solo]) try { x.ws.close(); } catch (e) { /* noop */ }
  await sleep(400);
  ok(srv.rooms.size === 0, 'all rooms are cleaned up after everyone leaves (left ' + srv.rooms.size + ')');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
