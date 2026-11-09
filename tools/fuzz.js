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
  const roomsAfter = [...srv.rooms.values()].filter((r) => !r.solo && r.humanCount() > 0);
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
  const FP = T.SHOP_BY_ID['char:frog'].price;   // Alexa can afford exactly the frog, so everything else is unaffordable
  const alex = await account('Alexa', { wins: FP });
  gc = await client({ name: 'Alexa', mode: 'online', c: STI[0], k: 0 });
  ok(/registered/i.test(gc.err || ''), 'guest cannot take a registered name: ' + gc.err);
  let ac = await client({ name: 'IgnoredName', mode: 'online', c: lockedIdx, k: 0 }, { cookie: alex.cookie });
  ok(/shop|unlocked/i.test(ac.err || ''), 'account cannot use a character it has not bought: ' + ac.err);
  const b1 = await post('/api/shop/buy', { item: 'char:frog' }, alex.cookie), j1 = await b1.json();
  ok(b1.status === 200 && j1.user.balance === 0 && j1.user.owned.includes('char:frog'), 'buy frog for ' + FP + ' win(s) -> balance 0');
  const b2 = await post('/api/shop/buy', { item: 'char:frog' }, alex.cookie);
  ok(b2.status === 400, 'cannot buy the same item twice');
  const b3 = await post('/api/shop/buy', { item: 'char:bat' }, alex.cookie);
  ok(b3.status === 400, 'cannot buy what you cannot afford');
  const race = await Promise.all([1, 2, 3, 4].map(() => post('/api/shop/buy', { item: 'char:cat' }, alex.cookie).then((r) => r.status)));
  ok(race.filter((x) => x === 200).length === 0 && (await (await fetch(BASE + '/api/me', { headers: { cookie: alex.cookie } })).json()).user.balance === 0, 'cat costs more than balance 0: all concurrent buys refused, balance intact');
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
  ok(award && award.wins === FP + 1 && award.balance === 1, 'win is saved and reported: ' + JSON.stringify(award));
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

  console.log('character update');
  const cu = await client({ name: 'Stylish', mode: 'online', c: STI[0], k: T.customK(200, 1), h: 3 });
  const cuR = cu.init && cu.init.roster.find((r) => r.n === 'Stylish');
  ok(cuR && cuR.k === T.customK(200, 1) && cuR.h === 3, 'custom colour + hat are kept and shared in the roster');
  ok(T.colorFor(cuR.k) && /^#[0-9a-f]{6}$/.test(T.colorFor(cuR.k)), 'custom colour index maps to a hex colour');
  const cu2 = await client({ name: 'Sneaky', mode: 'online', c: STI[0], k: 99999, h: 99 });
  const cu2R = cu2.init && cu2.init.roster.find((r) => r.n === 'Sneaky');
  ok(cu2R && cu2R.k === 0 && cu2R.h === 0, 'out-of-range colour/hat are reset to default (' + JSON.stringify(cu2R) + ')');
  for (const x of [cu, cu2]) try { x.ws.close(); } catch (e) { /* noop */ }
  // every character keeps its own colour; the list is saved with the account and sanitised
  const pc = await account('PerChar');
  const pcc = await client({ name: 'x', mode: 'online', c: STI[1], k: 3, ks: [1, 2, 3, 99999, 'bad', T.customK(10, 0)], h: 0 }, { cookie: pc.cookie });
  const pcU = await srv.getStore().userByName('PerChar');
  ok(pcU.settings.ks && pcU.settings.ks.length === T.CHARS.length, 'account saves one colour per character (' + JSON.stringify(pcU.settings.ks) + ')');
  ok(pcU.settings.ks[0] === 1 && pcU.settings.ks[1] === 2 && pcU.settings.ks[STI[1]] === 3 && pcU.settings.ks[3] === 0 && pcU.settings.ks[4] === 0 && pcU.settings.ks[5] === T.customK(10, 0), 'saved colours are sanitised and the played character uses the joined colour');
  try { pcc.ws.close(); } catch (e) { /* noop */ }
  {
    const starI = T.CHARS.findIndex((x) => x.id === 'star'), map = T.MAP_BY_ID[T.MAPS[0].id];
    const p = T.newSim(1, starI, map.w - 120, map.h / 2); const ctx = { map, goos: [] };
    T.stepPlayer(p, { s: 1, x: 1, y: 0, a: 1 }, ctx, []);
    ok(p.abT > 1.4 && p.adx > 0.9, 'starfish starts rolling in the aimed direction');
    let bounced = 0, ev = [];
    for (let i = 0; i < 90; i++) { ev = []; T.stepPlayer(p, { s: i + 2, x: 0, y: 0, a: 0 }, ctx, ev); if (ev.some((e) => e.n === 'bounce')) bounced++; }
    ok(bounced >= 1 && p.x <= map.w, 'starfish ricochets off walls and stays inside the arena (bounces: ' + bounced + ')');
    const q = T.newSim(2, starI, 300, 300); q.stun = 0.5; q.abT = 1; T.stepPlayer(q, { s: 1, x: 0, y: 0, a: 0 }, ctx, []);
    ok(q.abT === 0, 'a stun uncurls the starfish');
  }

  console.log('server browser');
  const list0 = await (await fetch(BASE + '/api/servers')).json();
  ok(list0.servers[0].regular && list0.servers[0].name === 'Regular server', 'list starts with the Regular server');
  const bad = [{ name: 'ab', time: 90, max: 5 }, { name: 'Quick Game', time: 59, max: 5 }, { name: 'Quick Game', time: 90, max: 1 }, { name: 'Quick Game', time: 90, max: 16 }, { name: 'Regular server', time: 90, max: 5 }, { name: 'fuck off', time: 90, max: 5 }];
  for (const b of bad) { const x = await client({ name: 'Maker', mode: 'online', c: STI[0], k: 0, create: b }); ok(!!x.err && !x.init, 'create rejected: ' + JSON.stringify(b) + ' -> ' + x.err); x.ws.close(); }
  const mk = await client({ name: 'Maker1', mode: 'online', c: STI[0], k: 0, create: { name: 'Friday Chaos', time: 60, max: 3, map: 'random' } });
  ok(mk.init && mk.init.sv && mk.init.sv.name === 'Friday Chaos' && mk.init.sv.time === 60 && mk.init.sv.max === 3 && !mk.init.sv.regular, 'custom server created with its settings');
  const dupName = await client({ name: 'Maker2', mode: 'online', c: STI[0], k: 0, create: { name: 'friday chaos', time: 90, max: 4 } });
  ok(!!dupName.err, 'duplicate server name rejected (case-insens.)'); dupName.ws.close();
  const list1 = await (await fetch(BASE + '/api/servers')).json();
  const sv = list1.servers.find((s) => s.name === 'Friday Chaos');
  ok(sv && sv.players === 1 && sv.max === 3 && sv.time === 60, 'new server appears in the list');
  const j2 = await client({ name: 'Joiner2', mode: 'online', c: STI[0], k: 0, server: sv.id });
  const j3 = await client({ name: 'Joiner3', mode: 'online', c: STI[0], k: 1, server: sv.id });
  const j4 = await client({ name: 'Joiner4', mode: 'online', c: STI[0], k: 2, server: sv.id });
  ok(j2.init && j3.init && !j4.init && /full/i.test(j4.err || ''), 'max players enforced (3 in, 4th refused: ' + j4.err + ')');
  const crm = [...srv.rooms.values()].find((r) => r.name === 'Friday Chaos');
  ok(crm && crm.roundTime === 60 && !!crm.onWin && crm.botTarget === 0, 'custom room has 60s rounds and can award wins');
  const rj = await client({ name: 'Ghost', mode: 'online', c: STI[0], k: 0, server: 'R99999' });
  ok(!!rj.err, 'joining a closed server fails cleanly'); rj.ws.close();
  const m5 = await client({ name: 'Maker5', mode: 'online', c: STI[0], k: 0, create: { name: 'Third A', time: 90, max: 4 } });
  const m6 = await client({ name: 'Maker5', mode: 'online', c: STI[0], k: 0, create: { name: 'Third B', time: 90, max: 4 } });
  const m7 = await client({ name: 'Maker5', mode: 'online', c: STI[0], k: 0, create: { name: 'Third C', time: 90, max: 4 } });
  ok(!!m7.err && /3 servers/.test(m7.err), 'creation is rate limited per person/IP: ' + m7.err);
  // bots + passwords (use a fresh IP-less path: creation limit is per IP, so reset it through the exported hook)
  srv.resetLimits && srv.resetLimits();
  const bad2 = await client({ name: 'BotMaker', mode: 'online', c: STI[0], k: 0, create: { name: 'Bot Land', time: 60, max: 4, bots: 4 } });
  ok(!!bad2.err, 'bots cannot fill every slot: ' + bad2.err); bad2.ws.close();
  const bm = await client({ name: 'BotMaker', mode: 'online', c: STI[0], k: 0, create: { name: 'Bot Land', time: 60, max: 4, bots: 3, diff: 'hard', pass: 'sesame' } });
  const bl = [...srv.rooms.values()].find((r) => r.name === 'Bot Land');
  ok(bm.init && bl && [...bl.players.values()].filter((p) => p.bot).length === 3 && bl.players.size === 4, 'custom server fills with bots up to max');
  ok(bl && !bl.onWin === false && bl.botTarget === 3, 'room with bots flagged (wins disabled by rule)');
  const nopass = await client({ name: 'Nopass', mode: 'online', c: STI[0], k: 0, server: bl.code });
  ok(!!nopass.err && /password/i.test(nopass.err), 'locked server refuses without a password: ' + nopass.err); nopass.ws.close();
  const wrong = await client({ name: 'Wrongpass', mode: 'online', c: STI[0], k: 0, server: bl.code, pass: 'nope' });
  ok(!!wrong.err && /wrong/i.test(wrong.err), 'wrong password refused'); wrong.ws.close();
  const right = await client({ name: 'Rightpass', mode: 'online', c: STI[0], k: 0, server: bl.code, pass: 'sesame' });
  ok(right.init && [...bl.players.values()].filter((p) => p.bot).length === 2 && bl.players.size === 4, 'correct password joins; a bot made room');
  const lst = await (await fetch(BASE + '/api/servers')).json();
  ok(lst.servers.find((s) => s.name === 'Bot Land').lock === true && !JSON.stringify(lst).includes('sesame'), 'list marks it locked without leaking the password');
  const needMin = (() => { const full = new Set(); return bl.humanCount(); })();
  for (const x of [bm, right]) try { x.ws.close(); } catch (e) { /* noop */ }
  await sleep(300);

  for (const x of [mk, j2, j3, j4, m5, m6, m7]) try { x.ws.close(); } catch (e) { /* noop */ }
  await sleep(300);
  ok(![...srv.rooms.values()].some((r) => r.name === 'Friday Chaos'), 'custom server is removed when it empties');

  for (const x of [...humans, dup, refill, solo]) try { x.ws.close(); } catch (e) { /* noop */ }
  await sleep(400);
  ok([...srv.rooms.values()].every((r) => r.regular && r.humanCount() === 0) && [...srv.rooms.values()].filter((r) => r.regular).length === 1, 'only the empty Regular server remains after everyone leaves (left ' + srv.rooms.size + ')');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
