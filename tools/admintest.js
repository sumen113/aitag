'use strict';
process.env.VOTE_TIME = process.env.VOTE_TIME || '0.4'; process.env.PICK_TIME = process.env.PICK_TIME || '0';   // regular/solo rooms vote before each round and have a change-character window: keep both short in tests
/* Admin API integration test: access control, passcode, moderation, wins/items, password reset, announce, banner, leaderboard. */
process.env.PORT = '3120';
const srv = require('../server.js');
const T = require('../public/shared.js');
const WebSocket = require('ws');
const BASE = 'http://127.0.0.1:3120', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) fails++; };
const post = (url, body, cookie, code) => fetch(BASE + url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}, code ? { 'x-admin-code': code } : {}), body: JSON.stringify(body || {}) });
async function reg(name) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'correct-horse-9', email: name.toLowerCase() + '@example.com' }) }); return r.headers.get('set-cookie').split(';')[0]; }
function join(name, cookie, c = 0) {
  return new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:3120/ws', cookie ? { headers: { cookie } } : undefined); const o = { ws, msgs: [], ev: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, mode: 'online', c, k: 0 })));
    ws.on('message', (d) => { const m = JSON.parse(d); o.msgs.push(m); if (m.t === 'init') { o.init = m; res(o); } if (m.t === 'err') res(o); if (m.t === 's' && m.ev) o.ev.push(...m.ev); });
    ws.on('close', () => { o.closed = true; }); }); }
(async () => {
  await srv.server.listen(3120, '127.0.0.1');
  await srv.init({ file: null, auth: { registerPerHour: 500 }, admin: { admins: 'Boss', passcode: 'sesame' } });
  const boss = await reg('Boss'), pleb = await reg('Pleb'), vic = await reg('Victim');
  let r = await post('/api/admin/state', {}, pleb, 'sesame'); ok(r.status === 403, 'non-admin account refused');
  r = await post('/api/admin/state', {}); ok(r.status === 403, 'logged-out refused');
  r = await post('/api/admin/state', {}, boss); ok(r.status === 401 && (await r.json()).needCode, 'admin without passcode asked for it');
  r = await post('/api/admin/state', {}, boss, 'wrong'); ok(r.status === 401, 'wrong passcode refused');
  r = await post('/api/admin/state', {}, boss, 'sesame'); let j = await r.json(); ok(r.status === 200 && j.me === 'Boss' && j.accounts === 3, 'admin state ok');
  r = await post('/api/hq/state', {}, boss, 'sesame'); ok(r.status === 200 && (await r.json()).me === 'Boss', 'the /api/hq alias (not blocked by school filters) works');
  r = await fetch(BASE + '/hq'); const pg = await r.text(); ok(r.status === 200 && /hq\.js/.test(pg), '/hq serves the panel'); r = await fetch(BASE + '/admin'); ok(r.status === 200, '/admin still works');
  const me = await (await fetch(BASE + '/api/me', { headers: { cookie: boss } })).json(); ok(me.user.admin === true, '/api/me flags admin');
  const me2 = await (await fetch(BASE + '/api/me', { headers: { cookie: pleb } })).json(); ok(!me2.user.admin, '/api/me does not flag others');
  const csrf = await fetch(BASE + '/api/admin/state', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: boss, 'x-admin-code': 'sesame', origin: 'http://evil.example' }, body: '{}' }); ok(csrf.status === 403, 'cross-site refused');
  const a = await join('x', boss), b = await join('x', vic), g = await join('Guesty', null, 0);
  await sleep(300);
  j = await (await post('/api/admin/state', {}, boss, 'sesame')).json(); ok(j.players.length === 3 && j.players.find((p) => p.name === 'Boss').staff, 'players listed, Boss is staff');
  const vp = j.players.find((p) => p.name === 'Victim');
  // chat staff flag
  a.ws.send(JSON.stringify({ t: 'chat', m: 'hi all' })); await sleep(400);
  const chat = b.msgs.flatMap((m) => m.e || []).find((e) => e.k === 'chat'); ok(chat && chat.s === undefined && chat.tt === undefined && chat.n === 'Boss', 'staff get no badge and no title by default');
  // titles: nobody has one until given; colour required; shows live in roster + chat + leaderboard
  r = await post('/api/admin/title', { username: 'Boss', title: 'Founder', color: 'red' }, boss, 'sesame'); ok(r.status === 400, 'a title needs a #rrggbb colour');
  r = await post('/api/admin/title', { username: 'Nobody', title: 'X', color: '#ff0000' }, boss, 'sesame'); ok(r.status === 404, 'title for an unknown account is refused');
  r = await post('/api/admin/title', { username: 'Boss', title: '  Founder of the very long title  ', color: '#FF8A3D' }, pleb, 'sesame'); ok(r.status === 403, 'a normal account cannot hand out titles');
  r = await post('/api/admin/title', { username: 'Boss', title: '  Founder of the very long title  ', color: '#FF8A3D' }, boss, 'sesame'); j = await r.json();
  ok(r.status === 200 && j.title && j.title.t === 'Founder of the v' && j.title.c === '#ff8a3d', 'title saved (trimmed to 16 chars, colour normalised): ' + JSON.stringify(j.title));
  await sleep(250);
  const rosterBoss = b.msgs.filter((m) => m.t === 'roster').pop();
  ok(rosterBoss && rosterBoss.ps.find((p) => p.n === 'Boss' && p.tt && p.tc === '#ff8a3d') && !rosterBoss.ps.find((p) => p.n === 'Victim' && p.tt), 'live roster carries the title for Boss only');
  a.ws.send(JSON.stringify({ t: 'chat', m: 'titled hi' })); await sleep(400);
  const chat2 = b.msgs.flatMap((m) => m.e || []).filter((e) => e.k === 'chat' && e.m === 'titled hi')[0]; ok(chat2 && chat2.tt && chat2.tc === '#ff8a3d', 'chat messages carry the title');
  j = await (await post('/api/admin/users', { q: 'boss' }, boss, 'sesame')).json(); ok(j.users[0].title && j.users[0].title.c === '#ff8a3d', 'account list shows the title');
  j = await (await post('/api/admin/state', {}, boss, 'sesame')).json(); ok(j.titles.length === 1 && j.titles[0].name === 'Boss', 'state lists titles');
  // mute
  r = await post('/api/admin/mute', { room: vp.room, id: vp.id, on: true }, boss, 'sesame'); ok(r.status === 200, 'mute');
  const before = a.msgs.flatMap((m) => m.e || []).filter((e) => e.k === 'chat').length;
  b.ws.send(JSON.stringify({ t: 'chat', m: 'muted msg' })); await sleep(400);
  ok(a.msgs.flatMap((m) => m.e || []).filter((e) => e.k === 'chat').length === before, 'muted player chat dropped');
  ok(b.msgs.some((m) => m.t === 'announce' && m.p), 'muted player told');
  // announce
  r = await post('/api/admin/announce', { m: 'Server restart in 5 minutes' }, boss, 'sesame'); await sleep(200);
  ok(a.msgs.some((m) => m.t === 'announce' && /restart/.test(m.m)) && g.msgs.some((m) => m.t === 'announce'), 'announce reaches everyone');
  // banner on stats
  await post('/api/admin/banner', { m: 'Maintenance at 5pm' }, boss, 'sesame');
  ok((await (await fetch(BASE + '/api/stats')).json()).banner === 'Maintenance at 5pm', 'banner appears in /api/stats');
  // wins + items
  r = await post('/api/admin/wins', { username: 'Victim', delta: 8 }, boss, 'sesame'); j = await r.json(); ok(j.user.wins === 8 && j.user.balance === 8, 'gift wins');
  r = await post('/api/admin/item', { username: 'Victim', item: 'char:bat', on: true }, boss, 'sesame'); j = await r.json(); ok(j.user.owned.includes('char:bat'), 'grant item');
  r = await post('/api/admin/wins', { username: 'Victim', delta: -100 }, boss, 'sesame'); j = await r.json(); ok(j.user.wins === 0 && j.user.balance === 0, 'removing wins never goes below zero');
  r = await post('/api/admin/item', { username: 'Victim', item: 'char:bat', on: false }, boss, 'sesame'); j = await r.json(); ok(!j.user.owned.includes('char:bat'), 'revoke item');
  r = await post('/api/admin/users', { q: 'vic' }, boss, 'sesame'); j = await r.json(); ok(j.users.length === 1 && j.users[0].online, 'user search finds Victim (online)');
  // kick
  r = await post('/api/admin/kick', { room: vp.room, id: vp.id }, boss, 'sesame'); await sleep(300); ok(b.closed && b.msgs.some((m) => m.t === 'kick'), 'kick closes the socket');
  // ban
  const v2 = await join('x', vic); r = await post('/api/admin/ban', { username: 'Victim', reason: 'testing' }, boss, 'sesame'); await sleep(300);
  ok(r.status === 200 && v2.closed, 'ban kicks live connection');
  r = await post('/api/login', { username: 'Victim', password: 'correct-horse-9' }); ok(r.status === 403 && /suspended/.test((await r.json()).error), 'banned account cannot log in');
  const me3 = await (await fetch(BASE + '/api/me', { headers: { cookie: vic } })).json(); ok(!me3.user, 'old session no longer works');
  r = await post('/api/admin/ban', { username: 'Boss', reason: 'x' }, boss, 'sesame'); ok(r.status === 400, 'cannot ban an admin');
  r = await post('/api/admin/ban', { username: 'Victim', on: false }, boss, 'sesame'); ok(r.status === 200, 'unban');
  // password reset
  r = await post('/api/admin/password', { username: 'Victim', password: 'brand-new-pass-1' }, boss, 'sesame'); ok(r.status === 200, 'password reset');
  r = await post('/api/login', { username: 'Victim', password: 'brand-new-pass-1' }); ok(r.status === 200, 'login with the new password works');
  r = await post('/api/login', { username: 'Victim', password: 'correct-horse-9' }); ok(r.status === 401, 'old password dead');
  // leaderboard
  await post('/api/admin/wins', { username: 'Pleb', delta: 5 }, boss, 'sesame'); await post('/api/admin/wins', { username: 'Boss', delta: 2 }, boss, 'sesame');
  j = await (await fetch(BASE + '/api/leaderboard')).json(); ok(j.top.length === 2 && j.top[0].username === 'Pleb' && j.top[0].wins === 5, 'leaderboard ordered: ' + JSON.stringify(j.top));
  for (let i = 0; i < 14; i++) { await reg('Lb' + i); await post('/api/admin/wins', { username: 'Lb' + i, delta: 1 + i }, boss, 'sesame'); }
  srv.resetBoard(); j = await (await fetch(BASE + '/api/leaderboard')).json(); ok(j.top.length === 16 && j.top[0].wins === 14 && j.top.every((t, i) => !i || j.top[i - 1].wins >= t.wins), 'leaderboard goes beyond 10 rows (got ' + j.top.length + ')');
  j = await (await post('/api/admin/state', {}, boss, 'sesame')).json(); ok(j.log.length > 8, 'audit log has entries');
  await post('/api/admin/wins', { username: 'Boss', delta: 30 }, boss, 'sesame'); srv.resetBoard();
  j = await (await fetch(BASE + '/api/leaderboard')).json(); ok(j.top.find((t) => t.username === 'Boss' && t.title && t.title.c === '#ff8a3d'), 'leaderboard rows carry titles');
  const a2 = await join('x', boss); ok(a2.init.roster.find((p) => p.n === 'Boss' && p.tt), 'a title is kept for the next join');
  r = await post('/api/admin/title', { username: 'Boss', title: '' }, boss, 'sesame'); ok(r.status === 200, 'title removed'); await sleep(250);
  ok(!a2.msgs.filter((m) => m.t === 'roster').pop().ps.find((p) => p.n === 'Boss').tt, 'removed title disappears live');
  // skins, glitter, gifted chests, bonus event, gift-all, sign-out
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'fox', theme: 'lava', on: true }, pleb, 'sesame'); ok(r.status === 403, 'a normal account cannot give skins');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'fox', theme: 'lava', on: true }, boss, 'sesame'); j = await r.json();
  ok(r.status === 200 && j.changed === 1 && j.user.skins.includes('skin:fox:lava'), 'give one skin');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'fox', theme: 'lava', on: true }, boss, 'sesame'); j = await r.json(); ok(j.changed === 0, 'giving it again changes nothing');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'fox', theme: '', on: true }, boss, 'sesame'); j = await r.json(); ok(j.user.skins.length === 12 && j.changed === 11, 'give a whole character set (11 new)');
  r = await post('/api/admin/skin', { username: 'Pleb', char: '', theme: 'gold', on: true }, boss, 'sesame'); j = await r.json(); ok(j.user.skins.length === 12 + 17 && j.user.skins.filter((x) => x.endsWith(':gold')).length === 18, 'give one theme on every character');
  r = await post('/api/admin/skin', { username: 'Pleb', char: '', theme: '', on: true }, boss, 'sesame'); j = await r.json(); ok(j.user.skins.length === 216, 'give every skin');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'fox', theme: '', on: false }, boss, 'sesame'); j = await r.json(); ok(j.user.skins.length === 204, 'take a whole character set away');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'nope', theme: '', on: true }, boss, 'sesame'); ok(r.status === 400, 'unknown character refused');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'fox', theme: '__proto__', on: true }, boss, 'sesame'); ok(r.status === 400, 'unknown theme refused');
  r = await post('/api/admin/skin', { username: 'Ghosty', char: 'fox', theme: 'lava', on: true }, boss, 'sesame'); ok(r.status === 404, 'skins for an unknown account refused');
  j = await (await post('/api/admin/users', { q: 'pleb' }, boss, 'sesame')).json(); ok(j.users[0].skins.length === 204 && !j.users[0].owned.some((x) => x.startsWith('skin:')) && j.users[0].chest, 'player card lists skins separately and the chest ledger');
  r = await post('/api/admin/glitter', { username: 'Pleb', delta: 120 }, boss, 'sesame'); j = await r.json(); ok(j.glitter === 120, 'give glitter');
  r = await post('/api/admin/gift', { username: 'Pleb', tier: 'gold', n: 2 }, boss, 'sesame'); j = await r.json(); ok(j.gifts.gold === 2, 'gift two golden chests');
  r = await post('/api/admin/gift', { username: 'Pleb', tier: 'diamond', n: 1 }, boss, 'sesame'); ok(r.status === 400, 'unknown chest tier refused');
  let me4 = await (await fetch(BASE + '/api/me', { headers: { cookie: pleb } })).json(); ok(me4.user.chest.gifts.gold === 2 && me4.user.chest.glitter === 120, 'the player sees the gifts and glitter');
  r = await post('/api/chest/open', { tier: 'gold', gift: true }, pleb); j = await r.json(); ok(r.status === 200 && j.result.tier === 'gold' && j.user.chest.gifts.gold === 1 && j.user.balance === me4.user.balance, 'opening a gifted chest costs no wins and uses one gift');
  r = await post('/api/chest/open', { tier: 'wood', gift: true }, pleb); ok(r.status === 400, 'cannot open a gift you do not have');
  r = await post('/api/admin/bonus', { m: 3, hours: 2 }, boss, 'sesame'); j = await r.json(); ok(j.bonus && j.bonus.m === 3, 'start a win bonus');
  j = await (await fetch(BASE + '/api/stats')).json(); ok(j.bonus && j.bonus.m === 3 && j.bonus.left > 7000e3 && j.bonus.left <= 7200e3, 'the status shows the bonus to everyone, with the time left (independent of the viewer\'s clock)');
  // the two bonus types: 'wins' moves the leaderboard too, 'points' only adds spendable balance
  {
    const st2 = srv.getStore(), rm = srv.createRoom({ kind: 'public' }), lb = async () => ((await (await fetch(BASE + '/api/leaderboard')).json()).top.find((x) => x.username === 'Pleb') || { wins: 0 }).wins;
    const win = async () => { const u = await st2.userByName('Pleb'); rm.onWin({ uid: u.id, name: 'Pleb' }); await new Promise((r2) => setTimeout(r2, 400)); return st2.userByName('Pleb'); };
    srv.resetBoard();
    let w0 = (await st2.userByName('Pleb')).wins, l0 = await lb();
    r = await post('/api/admin/bonus', { m: 3, hours: 2, kind: 'points' }, boss, 'sesame'); j = await r.json(); ok(j.bonus && j.bonus.kind === 'points', 'a points-only bonus can be started');
    j = await (await fetch(BASE + '/api/stats')).json(); ok(j.bonus.kind === 'points', 'everyone sees that it is a points bonus');
    let u2 = await win(); srv.resetBoard();
    ok(u2.wins - w0 === 3, 'points bonus: the win pays x3 spendable (' + (u2.wins - w0) + ')');
    ok((await lb()) - l0 === 1, 'points bonus: the leaderboard only moves by 1 (' + ((await lb()) - l0) + ')');
    w0 = u2.wins; l0 = await lb();
    r = await post('/api/admin/bonus', { m: 2, hours: 2 }, boss, 'sesame'); j = await r.json(); ok(j.bonus.kind === 'wins', 'the default bonus type is wins');
    u2 = await win(); srv.resetBoard();
    ok(u2.wins - w0 === 2 && (await lb()) - l0 === 2, 'wins bonus: spendable and leaderboard both move by 2');
    r = await post('/api/admin/bonus', { m: 1, hours: 0 }, boss, 'sesame');
  }
  r = await post('/api/admin/bonus', { m: 9, hours: 500 }, boss, 'sesame'); j = await r.json(); ok(j.bonus.m === 5 && j.bonus.until - Date.now() <= 72 * 3600e3 + 1000, 'bonus limits are clamped');
  r = await post('/api/admin/bonus', { m: 1, hours: 0 }, boss, 'sesame'); j = await r.json(); ok(j.bonus === null, 'end the bonus');
  const pj = await join('x', pleb); await sleep(200);
  r = await post('/api/admin/giftall', { wins: 2, tier: 'silver', n: 1 }, boss, 'sesame'); j = await r.json(); await sleep(300);
  ok(j.count >= 1 && pj.msgs.some((m) => m.t === 'award') && pj.msgs.some((m) => m.t === 'announce'), 'gift everyone online reaches players in game');
  me4 = await (await fetch(BASE + '/api/me', { headers: { cookie: pleb } })).json(); ok(me4.user.chest.gifts.silver === 1, 'the online player got the silver chest');
  r = await post('/api/admin/giftall', { wins: 0 }, boss, 'sesame'); ok(r.status === 400, 'gift-all needs something to give');
  r = await post('/api/admin/logout', { username: 'Pleb' }, boss, 'sesame'); await sleep(300); ok(r.status === 200 && pj.closed, 'sign out kicks the player and ends the session');
  me4 = await (await fetch(BASE + '/api/me', { headers: { cookie: pleb } })).json(); ok(!me4.user, 'the old session is dead after sign out');
  // emails
  r = await post('/api/admin/emails', {}, boss, 'sesame'); j = await r.json();
  ok(r.status === 200 && j.have >= 2 && j.emails.some((x) => x.email === 'pleb@example.com') && j.total >= j.have, 'staff can list every email');
  const plain = await reg('Plain'); r = await post('/api/admin/emails', {}, plain, 'sesame'); ok(r.status === 403, 'players cannot list emails');
  r = await post('/api/admin/email', { username: 'Pleb', email: 'nope' }, boss, 'sesame'); ok(r.status === 400, 'staff email edit validates');
  r = await post('/api/admin/email', { username: 'Pleb', email: ' New@Example.com ' }, boss, 'sesame'); j = await r.json(); ok(r.status === 200 && j.user.email === 'new@example.com', 'staff can set an email (trimmed, lowercased)');
  r = await post('/api/admin/users', { q: 'Pleb' }, boss, 'sesame'); j = await r.json(); ok(j.users[0].email === 'new@example.com', 'staff see the email on the account card');
  j = await (await fetch(BASE + '/api/stats')).json(); ok(!JSON.stringify(j).includes('@example.com'), 'public stats never contain emails');
  // God: the secret character. Staff-only, unlocked from the staff page, never joinable by anyone else (not even in practice)
  const GODI = T.CHARS.findIndex((c) => c.id === 'god');
  let gj = await join('x', boss, GODI); ok(gj.msgs.some((m) => m.t === 'err') && !gj.init, 'staff cannot join as God before unlocking it');
  r = await post('/api/admin/item', { username: 'Pleb', item: 'char:god', on: true }, boss, 'sesame'); ok(r.status === 400, 'a non-staff account cannot be given God');
  r = await post('/api/admin/item', { username: 'Boss', item: 'char:god', on: true }, boss, 'sesame'); j = await r.json(); ok(r.status === 200 && j.user.owned.includes('char:god'), 'staff can unlock God for themselves');
  gj = await join('x', boss, GODI); ok(!!gj.init, 'staff with the unlock can join as God: ' + JSON.stringify(gj.msgs.filter((m) => m.t === 'err')));
  gj.ws.send(JSON.stringify({ t: 'god', a: 'tp', to: -5 })); await sleep(100); ok(!gj.closed, 'a teleport request for nobody is ignored');
  const pg2 = await join('x', pleb, GODI); ok(pg2.msgs.some((m) => m.t === 'err') && !pg2.init, 'players cannot join as God');
  const prac = await new Promise((res) => { const ws = new WebSocket('ws://127.0.0.1:3120/ws', { headers: { cookie: pleb } }); const o = { msgs: [] }; ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'x', mode: 'bots', c: GODI, k: 0 }))); ws.on('message', (d) => { const m = JSON.parse(d); o.msgs.push(m); if (m.t === 'init' || m.t === 'err') { o.ws = ws; res(o); } }); });
  ok(prac.msgs.some((m) => m.t === 'err'), 'not even practice mode lets players pick God');
  try { prac.ws.close(); gj.ws.close(); } catch (e) { /* ignore */ }
  // God skins: only by hand, never swept up by "all", never craftable
  r = await post('/api/admin/skin', { username: 'Pleb', char: '', theme: '', on: true }, boss, 'sesame'); j = await r.json(); ok(r.status === 200 && !j.user.skins.some((x) => x.startsWith('skin:god:')) && j.user.skins.length === T.SKINS.length, 'giving "all skins" skips the God skins');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'god', theme: 'gold', on: true }, boss, 'sesame'); j = await r.json(); ok(r.status === 200 && j.user.skins.includes('skin:god:gold'), 'staff can give one God skin');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'god', theme: '', on: true }, boss, 'sesame'); j = await r.json(); ok(j.user.skins.filter((x) => x.startsWith('skin:god:')).length === T.SKIN_THEMES.length, 'staff can give every God skin');
  r = await post('/api/admin/skin', { username: 'Pleb', char: 'god', theme: '', on: false }, boss, 'sesame'); j = await r.json(); ok(!j.user.skins.some((x) => x.startsWith('skin:god:')), 'and take them away again');
  r = await post('/api/chest/craft', { skin: 'skin:god:lava' }, plain); j = await r.json(); ok(r.status === 400 && /staff/.test(j.error || j.err || ''), 'God skins cannot be crafted with glitter: ' + JSON.stringify(j).slice(0, 80));
  r = await post('/api/admin/skin', { username: 'Pleb', char: '', theme: '', on: false }, boss, 'sesame');
  r = await post('/api/admin/item', { username: 'Boss', item: 'char:god', on: false }, boss, 'sesame'); j = await r.json(); ok(r.status === 200 && !j.user.owned.includes('char:god'), 'staff can lock God again');
  // the login cookie works inside an iframe on https (SameSite=None; Secure; Partitioned), and stays Lax on plain http
  r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' }, body: JSON.stringify({ username: 'Boss', password: 'correct-horse-9' }) });
  let ck = r.headers.get('set-cookie') || ''; ok(/SameSite=None/.test(ck) && /Secure/.test(ck) && /Partitioned/.test(ck) && /HttpOnly/.test(ck), 'https cookie is iframe-ready: ' + ck.replace(/=[^;]{10,};/, '=…;'));
  r = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Boss', password: 'correct-horse-9' }) });
  ck = r.headers.get('set-cookie') || ''; ok(/SameSite=Lax/.test(ck) && !/Secure/.test(ck), 'plain http cookie stays Lax');
  r = await fetch(BASE + '/'); ok(!r.headers.get('x-frame-options') && /frame-ancestors \*/.test(r.headers.get('content-security-policy')), 'the game page may be embedded');
  r = await fetch(BASE + '/hq'); ok(!r.headers.get('x-frame-options') && /frame-ancestors \*/.test(r.headers.get('content-security-policy')), 'the staff page opens inside the embedded game too (it was refused to connect in a frame)');
  // front page: staff rewrite the text and add links; everyone reads it; bad input is refused
  { const A = require('../src/admin.js'); const html = require('fs').readFileSync(require('path').join(__dirname, '../public/index.html'), 'utf8');
    const tagged = [...html.matchAll(/data-ct="(\w+)"/g)].map((m) => m[1]);
    ok(A.SITE_FIELDS.every((f) => tagged.filter((k) => k === f.k).length === 1) && tagged.length === A.SITE_FIELDS.length, 'every editable field has exactly one matching element on the front page');
    ok(!/admin/i.test(A.SITE_FIELDS.map((f) => f.label + f.g).join(' ')), 'editor labels never say "admin"'); }
  j = await (await fetch(BASE + '/api/site')).json(); ok(j && !Object.keys(j.text).length && j.links.length === 0, 'front page starts untouched');
  r = await post('/api/admin/site', { text: { lede: 'hi' } }, pleb, 'sesame'); ok(r.status === 403, 'a normal account cannot edit the front page');
  r = await post('/api/hq/site', { text: { lede: 'hi' } }, boss); ok(r.status === 401, 'editing needs the passcode too');
  r = await post('/api/hq/site', { text: { lede: '  hello   there\nsecond [Docs](https://example.com/a) line  ', h1a: 'cool', castTitle: 'One\nTwo', nope: 'x', step1t: '   ' }, links: [{ t: 'Discord', u: 'https://discord.gg/abc' }, { t: '', u: '' }, { t: 'Mail', u: 'mailto:me@example.com' }] }, boss, 'sesame');
  j = await r.json(); ok(r.status === 200 && j.site.text.lede === 'hello there\nsecond [Docs](https://example.com/a) line' && j.site.text.h1a === 'cool' && j.site.text.castTitle === 'One\nTwo', 'text is saved tidy, line breaks kept');
  ok(!('nope' in j.site.text) && !('step1t' in j.site.text), 'unknown keys and blank text are dropped');
  ok(j.site.links.length === 2 && j.site.links[0].u === 'https://discord.gg/abc' && j.site.links[1].t === 'Mail', 'links are saved (empty rows skipped)');
  j = await (await fetch(BASE + '/api/site')).json(); ok(j.text.h1a === 'cool' && j.links.length === 2, 'everybody can read the edited front page without logging in');
  r = await post('/api/hq/site', { text: {}, links: [{ t: 'Bad', u: 'javascript:alert(1)' }] }, boss, 'sesame'); ok(r.status === 400, 'javascript: links are refused');
  r = await post('/api/hq/site', { text: {}, links: [{ t: '', u: 'https://x.com' }] }, boss, 'sesame'); ok(r.status === 400, 'a link needs a label');
  j = await (await fetch(BASE + '/api/site')).json(); ok(j.links.length === 2, 'a refused save changes nothing');
  r = await post('/api/hq/site', { text: { lede: 'x'.repeat(900) }, links: Array.from({ length: 12 }, (_, i) => ({ t: 'L' + i, u: 'https://e.com/' + i })) }, boss, 'sesame'); j = await r.json();
  ok(r.status === 200 && j.site.text.lede.length === 500 && j.site.links.length === 8, 'text is cut to its limit and links to 8');
  j = await (await post('/api/hq/state', {}, boss, 'sesame')).json(); ok(j.site.links.length === 8 && Array.isArray(j.siteFields) && j.siteFields.length > 10, 'the staff state carries the current edits and the field list');
  r = await post('/api/hq/site', { text: {}, links: [] }, boss, 'sesame'); j = await (await fetch(BASE + '/api/site')).json(); ok(r.status === 200 && !Object.keys(j.text).length && !j.links.length, 'saving it empty puts the original page back');
  // staff in a live game: switch a room's mode, end its match, and kick with the F menu (the 'staffkick' message)
  { const pl2 = await reg('Plebtwo'), kk = await join('Kicky', null), bj = await join('x', boss), pj2 = await join('x', pl2); await sleep(300);
    ok(bj.init && bj.init.staff === true && pj2.init && !pj2.init.staff && !kk.init.staff, 'only a staff account is told it may use the kick menu');
    pj2.ws.send(JSON.stringify({ t: 'staffkick', id: kk.init.id })); await sleep(300); ok(!kk.closed, 'a normal player cannot kick with F');
    bj.ws.send(JSON.stringify({ t: 'staffkick', id: bj.init.id })); await sleep(300); ok(!bj.closed && bj.msgs.some((m) => m.t === 'announce' && /yourself/.test(m.m)), 'staff cannot kick themselves');
    bj.ws.send(JSON.stringify({ t: 'staffkick', id: 99999 })); await sleep(200); ok(bj.msgs.some((m) => m.t === 'announce' && /already left/.test(m.m)), 'kicking someone who is gone says so');
    bj.ws.send(JSON.stringify({ t: 'staffkick', id: kk.init.id })); await sleep(400); ok(kk.closed && kk.msgs.some((m) => m.t === 'kick' && /Staff/.test(m.m)), 'staff kick a player mid game with F');
    j = await (await post('/api/hq/state', {}, boss, 'sesame')).json(); ok(j.log.some((l) => l.a === 'kick' && /Kicky \(in game\)/.test(l.d)), 'the in-game kick is written to the staff log');
    const room = (await (await post('/api/hq/state', {}, boss, 'sesame')).json()).players.find((p) => p.name === 'Boss').room;
    r = await post('/api/hq/roommode', { room, mode: 'infection' }, pl2, 'sesame'); ok(r.status === 403, 'a normal account cannot switch modes');
    r = await post('/api/hq/endmatch', { room }, pl2, 'sesame'); ok(r.status === 403, 'a normal account cannot end matches');
    r = await post('/api/hq/roommode', { room, mode: 'banana' }, boss, 'sesame'); ok(r.status === 400, 'an unknown mode is refused');
    r = await post('/api/hq/roommode', { room: 'nope', mode: 'infection' }, boss, 'sesame'); ok(r.status === 404, 'an unknown room is refused');
    r = await post('/api/hq/roommode', { room, mode: 'potato' }, boss, 'sesame'); ok(r.status === 200, 'staff switch the room to Hot Potato');
    j = await (await post('/api/hq/state', {}, boss, 'sesame')).json(); const rm = j.rooms.find((x) => x.id === room); ok(rm && rm.mode === 'potato' && rm.state === T.STATE.COUNT, 'the live room now runs Hot Potato in a fresh countdown');
    await sleep(300); ok(bj.msgs.some((m) => m.t === 'ev' && m.e.some((e) => e.k === 'redo' && /Hot Potato/.test(e.m))), 'players are told the mode was switched');
    for (let i = 0; i < 40; i++) { j = await (await post('/api/hq/state', {}, boss, 'sesame')).json(); if (j.rooms.find((x) => x.id === room).state === T.STATE.PLAY) break; await sleep(300); }
    ok(j.rooms.find((x) => x.id === room).state === T.STATE.PLAY, 'the new round gets going');
    r = await post('/api/hq/endmatch', { room }, boss, 'sesame'); ok(r.status === 200, 'staff end the running match');
    j = await (await post('/api/hq/state', {}, boss, 'sesame')).json(); ok(j.rooms.find((x) => x.id === room).state === T.STATE.RESULTS, 'the room shows its results');
    r = await post('/api/hq/endmatch', { room }, boss, 'sesame'); ok(r.status === 400, 'there is nothing to end while the results show');
    ok(j.log.some((l) => l.a === 'room-mode') && j.log.some((l) => l.a === 'end-match'), 'switching and ending are written to the staff log');
    for (const o of [kk, bj, pj2]) try { o.ws.close(); } catch (e) { /* done */ } }
  // no passcode configured => locked
  await srv.init({ file: null, admin: { admins: 'Boss', passcode: '' } }); const boss2 = await reg('Boss');
  r = await post('/api/admin/state', {}, boss2, 'anything'); ok(r.status === 403 && (await r.json()).setup, 'admin panel stays locked when ADMIN_PASSCODE is unset');
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
