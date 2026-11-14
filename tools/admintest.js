'use strict';
process.env.VOTE_TIME = process.env.VOTE_TIME || '0.4';   // regular/solo rooms vote before each round: keep it short in tests
/* Admin API integration test: access control, passcode, moderation, wins/items, password reset, announce, banner, leaderboard. */
process.env.PORT = '3120';
const srv = require('../server.js');
const T = require('../public/shared.js');
const WebSocket = require('ws');
const BASE = 'http://127.0.0.1:3120', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) fails++; };
const post = (url, body, cookie, code) => fetch(BASE + url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}, code ? { 'x-admin-code': code } : {}), body: JSON.stringify(body || {}) });
async function reg(name) { const r = await fetch(BASE + '/api/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'correct-horse-9' }) }); return r.headers.get('set-cookie').split(';')[0]; }
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
  j = await (await fetch(BASE + '/api/stats')).json(); ok(j.bonus && j.bonus.m === 3, 'the status shows the bonus to everyone');
  r = await post('/api/admin/bonus', { m: 9, hours: 500 }, boss, 'sesame'); j = await r.json(); ok(j.bonus.m === 5 && j.bonus.until - Date.now() <= 72 * 3600e3 + 1000, 'bonus limits are clamped');
  r = await post('/api/admin/bonus', { m: 1, hours: 0 }, boss, 'sesame'); j = await r.json(); ok(j.bonus === null, 'end the bonus');
  const pj = await join('x', pleb); await sleep(200);
  r = await post('/api/admin/giftall', { wins: 2, tier: 'silver', n: 1 }, boss, 'sesame'); j = await r.json(); await sleep(300);
  ok(j.count >= 1 && pj.msgs.some((m) => m.t === 'award') && pj.msgs.some((m) => m.t === 'announce'), 'gift everyone online reaches players in game');
  me4 = await (await fetch(BASE + '/api/me', { headers: { cookie: pleb } })).json(); ok(me4.user.chest.gifts.silver === 1, 'the online player got the silver chest');
  r = await post('/api/admin/giftall', { wins: 0 }, boss, 'sesame'); ok(r.status === 400, 'gift-all needs something to give');
  r = await post('/api/admin/logout', { username: 'Pleb' }, boss, 'sesame'); await sleep(300); ok(r.status === 200 && pj.closed, 'sign out kicks the player and ends the session');
  me4 = await (await fetch(BASE + '/api/me', { headers: { cookie: pleb } })).json(); ok(!me4.user, 'the old session is dead after sign out');
  // no passcode configured => locked
  await srv.init({ file: null, admin: { admins: 'Boss', passcode: '' } }); const boss2 = await reg('Boss');
  r = await post('/api/admin/state', {}, boss2, 'anything'); ok(r.status === 403 && (await r.json()).setup, 'admin panel stays locked when ADMIN_PASSCODE is unset');
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})();
