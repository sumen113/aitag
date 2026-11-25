'use strict';
process.env.VOTE_TIME = '0.4'; process.env.PICK_TIME = '0';
/* Prop Hunt, run straight against Room (no sockets): voting, clutter, roles, hide phase, swing, finds, powers, scoring, end rules, bots. */
const T = require('../public/shared.js');
const { Room } = require('../src/room.js');
const { PropHunt } = require('../src/prophunt.js');
const { PH, PROPS, STATE } = T;
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  : ' : '  FAIL: ') + m); if (!c) fails++; };
let clk = Date.now(); Date.now = () => clk;
const step = (r) => { clk += 1000 / 60; if (!r.idleTest) for (const p of r.players.values()) p.lastActiveAt = clk; r.tick(); };
const run = (r, s, stop) => { for (let i = 0; i < s * 60; i++) { step(r); if (stop && stop()) return; } };
const mk = (mode, n, extra) => {
  const r = new Room('t' + mode, Object.assign({ kind: 'custom', name: 't', max: 15, mode, roundTime: 120, bots: 0 }, extra));
  r.evs = []; r.sent = []; const emit = r.emit.bind(r); r.emit = (e) => { r.evs.push(e); emit(e); };
  for (let i = 0; i < n; i++) r.addHuman({ readyState: 1, send(m) { r.sent.push(m); }, rtt: 0 }, 'P' + i, 0, 0, 0, 0);
  return r;
};
const ev = (r, k) => r.evs.filter((e) => e.k === k);
const toPlay = (n, extra) => { const r = mk('prophunt', n, extra); run(r, 8, () => r.state === STATE.PLAY); return r; };
const afterHide = (r) => run(r, PH.HIDE + 0.5, () => r.ph.hide <= 0);
const hiders = (r) => [...r.players.values()].filter((p) => PropHunt.isHider(p));
const seekers = (r) => [...r.players.values()].filter((p) => p.it);
// put two players next to each other, facing along +x, on free ground
const place = (a, x, y, fx = 1, fy = 0) => { a.x = x; a.y = y; a.vx = a.vy = 0; a.fx = fx; a.fy = fy; };
const freeSpot = (r) => { for (let x = 400; x < r.map.w; x += 37) for (let y = 300; y < r.map.h; y += 41) if (T.circleFree(r.map, x, y, 120) && !r.ph.clutter.some((c) => Math.hypot(c.x - x, c.y - y) < 150)) return [x, y]; return [200, 200]; };
let seq = 1000; const press = (r, p, h, x = 0, y = 0, a = 0) => { r.queueInputs(p, [[++seq, x, y, a, 0, 0, h]]); step(r); r.queueInputs(p, [[++seq, 0, 0, 0, 0, 0, 0]]); step(r); };

/* ---- availability ---- */
let r = mk('vote', 3); r.tick();
ok(r.state === STATE.VOTE && r.vote.modes.join() === 'classic', 'vote has only classic tag at 3 players');
r = mk('vote', 4); r.tick();
ok(r.vote.modes.join() === 'classic,prophunt', 'Prop Hunt joins the vote from 4 players (Infection / Potato still need 7)');
r = mk('vote', 7); r.tick();
ok(r.vote.modes.join() === 'classic,infection,potato,prophunt', 'all four modes are voted on at 7+ players');
const pi = r.vote.modes.indexOf('prophunt'); [...r.players.values()].forEach((p) => { r.castVote(p, 'd', pi); r.castVote(p, 'm', 0); });
run(r, 3, () => r.state === STATE.COUNT);
ok(r.mode === 'prophunt' && r.map.id === 'storehouse', 'a Prop Hunt vote plays on the Storehouse');
r = mk('prophunt', 3); run(r, 6, () => r.state === STATE.PLAY);
ok(r.mode === 'classic', 'a fixed Prop Hunt server falls back to classic tag below 4 players');
ok(T.MODE_BY_ID.prophunt && !T.MODE_BY_ID.prophunt.testOnly && T.modeMin('prophunt') === 4 && T.modeMin('infection') === 7, 'per-mode minimums');

/* ---- clutter ---- */
r = mk('prophunt', 6); run(r, 1, () => r.state === STATE.COUNT);
const cl = r.ph.clutter;
ok(r.state === STATE.COUNT && r.ph && cl.length >= PH.CLUTTER_MIN, `clutter is generated in the countdown (${cl.length} props)`);
ok(cl.every((c) => T.circleFree(r.map, c.x, c.y, PROPS[c.t].r)), 'no clutter sits inside a wall');
let minGap = 1e9; for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) minGap = Math.min(minGap, Math.hypot(cl[i].x - cl[j].x, cl[i].y - cl[j].y));
ok(minGap >= 37, 'clutter never overlaps itself (min gap ' + minGap.toFixed(0) + ')');
ok(r.map.spawns.every((s) => cl.every((c) => Math.hypot(c.x - s[0], c.y - s[1]) > 60)), 'nothing is on a spawn point');
ok(new Set(cl.map((c) => c.t)).size >= 6, 'a good mix of prop types');
const pm = r.sent.map((m) => JSON.parse(m)).find((m) => m.t === 'props');
ok(pm && pm.c.length === cl.length && pm.c[0].length === 4, 'clients are sent the clutter list');
r.sent.length = 0; ok(PropHunt.propsMsg(r).c.length === cl.length, 'late joiners can be sent it too (init)');

/* ---- roles + hide phase ---- */
r = toPlay(6);
ok(r.state === STATE.PLAY && r.mode === 'prophunt', 'round starts');
ok(seekers(r).length === 1 && hiders(r).length === 5, 'six players: one seeker, five hiders');
ok(hiders(r).every((p) => p.pr >= 1 && p.pr <= PROPS.length && p.pv >= 0 && p.pv < 16) && seekers(r).every((p) => p.pr === 0), 'hiders get a prop, seekers keep their character');
ok(Math.abs(r.ph.hide - PH.HIDE) < 0.5, 'hide phase runs ' + PH.HIDE + ' s');
let s0 = seekers(r)[0], px = s0.x, py = s0.y;
r.queueInputs(s0, [[++seq, 1, 0, 0], [++seq, 1, 0, 0], [++seq, 1, 0, 0]]); run(r, 1);
ok(Math.hypot(s0.x - px, s0.y - py) < 1, 'seekers are held in place during the hide phase');
let h0 = hiders(r)[0]; px = h0.x; r.queueInputs(h0, [[++seq, 1, 0, 0], [++seq, 1, 0, 0], [++seq, 1, 0, 0], [++seq, 1, 0, 0]]); run(r, 0.5);
ok(Math.abs(h0.x - px) > 5, 'hiders can move during it');
const snap = (() => { const h = []; r.sent.length = 0; r.sendSnapshots(); return JSON.parse(r.sent[r.sent.length - 1] || 'null'); })();
ok(r.state === STATE.PLAY, 'still playing');
r = toPlay(15);
ok(seekers(r).length === 3, 'fifteen players start with three seekers');
r = toPlay(8); ok(seekers(r).length === 2, 'eight players: two seekers');

/* ---- snapshot ---- */
r = toPlay(6); { const sw = []; const p0 = [...r.players.values()].find((p) => !p.bot); p0.ws = { readyState: 1, bufferedAmount: 0, send(m) { sw.push(JSON.parse(m)); } }; r.sendSnapshots();
  const m = sw[sw.length - 1]; const row = m.p.find((e) => e[0] === hiders(r)[0].id);
  ok(row.length === 14 && row[12] === hiders(r)[0].pr && row[13] === hiders(r)[0].pv, 'snapshot rows carry the prop and its turn'); ok(m.hd > 15, 'snapshot carries the hide timer');
  ok(m.me.length === T.SIM.length, 'own state includes the prop fields'); }

/* ---- swing: finds ---- */
r = toPlay(6); afterHide(r);
let sk = seekers(r)[0], hd = hiders(r)[0];
const [fx, fy] = freeSpot(r);
for (const o of hiders(r).slice(1)) place(o, 100, 100);
place(sk, fx, fy); place(hd, fx + 55, fy); sk.swT = 0; sk.lock = 0; sk.stun = 0; sk.afk = false;
const sc0 = sk.score; r.evs.length = 0;
press(r, sk, 8);
ok(hd.it === 1 && hd.pr === 0, 'a swing that reaches a hider finds them: they become a seeker');
ok(sk.tags === 1 && sk.score - sc0 >= PH.FIND_PTS, 'the finder scores ' + PH.FIND_PTS);
ok(ev(r, 'found').length === 1 && ev(r, 'found')[0].b === hd.id && ev(r, 'found')[0].pr > 0 && ev(r, 'swing').length === 1, 'found + swing events');
ok(hd.lock > 0.5, 'a freshly found hider has a moment before they can swing');
// cooldown
r.evs.length = 0; press(r, sk, 8); ok(ev(r, 'swing').length === 0, 'swing is on cooldown');
run(r, PH.SWING_CD + 0.1);
// out of reach / cone
let h1 = hiders(r)[0]; place(sk, fx, fy); place(h1, fx + 260, fy); sk.swT = 0; r.evs.length = 0; press(r, sk, 8);
ok(h1.it === 0 && ev(r, 'found').length === 0, 'too far away: nothing');
place(h1, fx - 95, fy); sk.swT = 0; place(sk, fx, fy, 1, 0); r.evs.length = 0; press(r, sk, 8);
ok(h1.it === 0, 'behind the seeker: nothing (cone only)');
place(h1, fx - 28, fy); sk.swT = 0; place(sk, fx, fy, 1, 0); r.evs.length = 0; press(r, sk, 8);
ok(h1.it === 1, 'but anything touching the seeker is hit whichever way they face');

/* ---- swing: clutter + nearest wins ---- */
r = toPlay(6); afterHide(r);
sk = seekers(r)[0]; hd = hiders(r)[0]; for (const o of hiders(r).slice(1)) place(o, 100, 100);
const c0 = r.ph.clutter[0]; place(sk, c0.x - 60, c0.y); place(hd, c0.x + 400, c0.y + 300); sk.swT = 0; sk.stun = 0; sk.lock = 0; r.evs.length = 0;
// make sure only that clutter is near the seeker
r.ph.clutter = [c0];
press(r, sk, 8);
ok(ev(r, 'dud').length === 1 && sk.stun > PH.MISS_STUN - 0.2, 'swinging at harmless clutter leaves the seeker dizzy');
ok(hd.it === 0 && sk.tags === 0, 'and finds nobody');
run(r, PH.MISS_STUN + 0.3);
// hider behind clutter: nearest thing wins
place(sk, c0.x - 70, c0.y); place(hd, c0.x + 28, c0.y); sk.swT = 0; sk.stun = 0; sk.lock = 0; r.evs.length = 0; press(r, sk, 8);
ok(hd.it === 0 && ev(r, 'dud').length === 1, 'a hider tucked behind a closer prop is not hit: the nearest thing in the swing wins');
run(r, 2);
place(sk, c0.x - 12, c0.y); place(hd, c0.x - 70 - 6, c0.y); sk.swT = 0; sk.stun = 0; sk.lock = 0; sk.fx = -1; sk.fy = 0; r.evs.length = 0; press(r, sk, 8);
ok(hd.it === 0 || hd.it === 1, 'ordering is by distance (no crash with overlap)');

/* ---- hider powers ---- */
r = toPlay(6); afterHide(r);
hd = hiders(r)[0]; sk = seekers(r)[0]; place(sk, 2400, 1600);
for (const o of hiders(r).slice(1)) place(o, 100, 100);
const [hx, hy] = freeSpot(r); place(hd, hx, hy); hd.afk = false;
// freeze
r.queueInputs(hd, Array.from({ length: 30 }, () => [++seq, 1, 0, 0, 0, 0, 8])); run(r, 0.6);
ok(Math.hypot(hd.x - hx, hd.y - hy) < 0.5 && hd.vx === 0, 'a frozen hider cannot move');
hd.vx = 500; r.queueInputs(hd, [[++seq, 0, 0, 0, 0, 0, 8]]); step(r);
ok(hd.vx === 0, 'and cannot be shoved while frozen');
r.queueInputs(hd, Array.from({ length: 30 }, () => [++seq, 1, 0, 0])); run(r, 0.5);
ok(hd.x - hx > 20, 'letting go lets them move again');
// dash
place(hd, hx, hy); hd.cd = 0; hd.abT = 0; r.evs.length = 0;
r.queueInputs(hd, Array.from({ length: 12 }, (_, i) => [++seq, 1, 0, i === 0 ? 1 : 0])); run(r, 0.2);
ok(hd.x - hx > 40 && ev(r, 'ab').some((e) => e.n === 'pdash'), 'a hider can dash');
ok(hd.cd > PH.DASH_CD - 1, 'dash has its cooldown');
// morph
place(hd, hx, hy); hd.mt = 0; hd.stun = 0; hd.afk = false;
const first = r.ph.clutter.reduce((b, c) => (Math.hypot(c.x - hx, c.y - hy) < Math.hypot(b.x - hx, b.y - hy) ? c : b));
place(hd, first.x + 30, first.y);
const near = r.ph.clutter.reduce((b, c) => (Math.hypot(c.x - hd.x, c.y - hd.y) < Math.hypot(b.x - hd.x, b.y - hd.y) ? c : b));   // the nearest one to where the hider now stands
hd.pr = ((near.t + 3) % PROPS.length) + 1; r.evs.length = 0; press(r, hd, 32);
ok(hd.pr === near.t + 1 && hd.pv === near.v, 'change prop copies the nearest prop exactly (type and turn)');
ok(hd.mt > 0 && ev(r, 'morph').length === 1, 'change prop has a cooldown');
place(hd, 20, 20); hd.mt = 0; r.ph.clutter.forEach((c) => { if (Math.hypot(c.x - 20, c.y - 20) < 130) c.x += 1000; }); r.evs.length = 0; press(r, hd, 32);
ok(ev(r, 'nomorph').length === 1, 'nothing nearby to copy');
// taunt
place(hd, hx, hy); hd.tt = 0; hd.score = 0; r.evs.length = 0; press(r, hd, 16);
ok(ev(r, 'taunt').length === 1 && hd.score >= PH.TAUNT_PTS && hd.tt > 10, 'taunt: a noise at your position, points, cooldown');
r.evs.length = 0; press(r, hd, 16); ok(ev(r, 'taunt').length === 0, 'taunt is on cooldown');
// taunt / swing keys are ignored for the wrong role
r.evs.length = 0; sk.swT = 0; press(r, sk, 16 | 32); ok(ev(r, 'taunt').length === 0 && ev(r, 'morph').length === 0, 'seekers cannot taunt or change prop');
r.evs.length = 0; press(r, hd, 8, 0, 0, 0); ok(ev(r, 'swing').length === 0, 'hiders cannot swing');
// bits are masked outside Prop Hunt
const rc = mk('classic', 3); const q0 = [...rc.players.values()][0]; rc.queueInputs(q0, [[1, 0, 0, 0, 0, 0, 56]]); ok(!q0.queue[0].h, 'the new input bits are ignored outside Prop Hunt');

/* ---- taunt not during hide phase ---- */
r = toPlay(6); hd = hiders(r)[0]; hd.tt = 0; r.evs.length = 0; press(r, hd, 16);
ok(ev(r, 'taunt').length === 0, 'no taunting while the seekers are still blindfolded');
sk = seekers(r)[0]; r.evs.length = 0; press(r, sk, 8); ok(ev(r, 'swing').length === 0, 'and no swinging');

/* ---- scoring, afk, bonus, end ---- */
r = toPlay(6); sk = seekers(r)[0]; hd = hiders(r)[0]; const s1 = hd.score;
run(r, 10); ok(hd.score - s1 < 1, 'no survival score during the hide phase');
afterHide(r); const s2 = hd.score; for (const o of [...r.players.values()]) { o.queue.length = 0; } run(r, 5);
ok(hd.score - s2 > 4 && hd.score - s2 < 6, 'hiders earn a point per second afterwards');
r.idleTest = true; clk += 1; for (const p of r.players.values()) p.lastActiveAt = clk - 100000;
for (let i = 0; i < 40 * 60; i++) { clk += 1000 / 60; for (const p of r.players.values()) if (p.it && p.afk === false && p !== sk) p.lastActiveAt = clk; r.tick(); }      // everyone is idle (hiders are exempt from the afk rule, the lone seeker is not and gets replaced by a drafted hider, who is then kept active)
ok(hiders(r).length > 0 && hiders(r).every((h) => !h.afk) && r.state === STATE.PLAY, 'hiders standing perfectly still for 40 s are never flagged afk');
ok(sk.afk === true, 'an idle seeker is (so they can be replaced)');
r.idleTest = false;
// idle seekers are replaced
ok(seekers(r).length >= 2, 'the idle seeker was backed up by a drafted hider');
ok(ev(r, 'found').some((e) => e.a === 0), '(an unscored found event)');

// everyone found -> seekers win
r = toPlay(6); afterHide(r); sk = seekers(r)[0];
for (const h of hiders(r)) PropHunt.find(r, sk, h);
run(r, 0.1); ok(r.state === STATE.RESULTS && r.phWin === 's', 'when every hider is found the round ends: seekers win');
ok(sk.score >= PH.FIND_PTS * 5, 'the finder keeps their points');
// time runs out -> hiders win + bonus
r = toPlay(6, { roundTime: 120 }); afterHide(r); r.tl = 0.5; const alive = hiders(r).map((p) => p.score);
run(r, 1); ok(r.state === STATE.RESULTS && r.phWin === 'h', 'surviving hiders win when the clock runs out');
ok(hiders(r).length === 0 && [...r.players.values()].every((p) => p.pr === 0 && p.it === 0), 'everyone is back to normal on the results screen');
ok(r.results && r.results.length === 6, 'results list all players');
// snapshot in results carries the winner
{ const sw = []; const p0 = [...r.players.values()][0]; p0.ws = { readyState: 1, bufferedAmount: 0, send(m) { sw.push(JSON.parse(m)); } }; r.sendSnapshots(); ok(sw[0].pw === 'h', 'the snapshot says who won'); }

/* ---- leaving ---- */
r = toPlay(6); afterHide(r); sk = seekers(r)[0]; r.removePlayer(sk); run(r, 0.2);
ok(seekers(r).length === 1 && r.state === STATE.PLAY, 'if the only seeker leaves, a hider is drafted (no scrapped round)');
r = toPlay(6); afterHide(r); sk = seekers(r)[0]; r.markGone(sk, true); run(r, 0.2);
ok(seekers(r).filter((p) => !p.gone).length === 1, 'a seeker whose connection died is replaced too');
r = toPlay(5); afterHide(r); for (const h of hiders(r).slice(0, 3)) r.removePlayer(h); run(r, 0.2);
ok(r.state === STATE.PLAY && hiders(r).length === 1, 'one hider left: round goes on');
r.removePlayer(hiders(r)[0]); run(r, 0.5);
ok(r.state !== STATE.PLAY, 'everyone left: the round is over / the room waits');

/* ---- late joiners / staff ---- */
r = toPlay(6); const late = r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Late', 0, 0, 0, 0);
ok(late.out === 1 && late.wait === 1, 'arriving mid-round you watch as a spectator');
late.staff = true; ok(r.staffJoin(late) && late.noScore === 1 && late.pr > 0 && !late.it, 'staff pressing G jump in as a scoreless hider');
run(r, 2); ok(late.score === 0, 'with no points');
// staff mode switch into prop hunt
r = mk('classic', 5); run(r, 6, () => r.state === STATE.PLAY); ok(r.staffSetMode('prophunt') === '' && r.mode === 'prophunt' && r.map.id === 'storehouse' && r.ph.clutter.length > 0, 'staff can switch a running room to Prop Hunt');
r = mk('classic', 2); run(r, 6, () => r.state === STATE.PLAY); r.staffSetMode('prophunt'); run(r, 8, () => r.state === STATE.PLAY);
ok(r.mode === 'prophunt' && seekers(r).length === 1, 'staff can force Prop Hunt with only two players');

/* ---- seeds, pits and abilities still work as seeker tools ---- */
r = toPlay(6); afterHide(r); sk = seekers(r)[0]; hd = hiders(r)[0]; place(sk, 800, 600); place(hd, 900, 600);
r.seeds.push({ id: 99, o: sk.id, x: 850, y: 600, vx: T.SEED_SPEED, vy: 0, it: 1, ttl: 1 }); for (const o of hiders(r).slice(1)) place(o, 100, 100); run(r, 0.1);
ok(hd.it === 1, 'a seed from a seeker finds a hider it hits');

/* ---- bots ---- */
for (const diff of ['easy', 'normal', 'hard']) {
  r = new Room('bots' + diff, { kind: 'bots', diff });
  r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Me', 0, 0, 0, 0);
  r.evs = []; const em = r.emit.bind(r); r.emit = (e) => { r.evs.push(e); em(e); };
  r.vote = null; r.setMode('prophunt'); r.forceMode = true; r.startCountdown(); r.forceMode = false;
  let threw = null, found = 0, botSeeker = false;
  try { run(r, 25, () => r.state === STATE.PLAY); botSeeker = seekers(r).some((p) => p.bot); r.ph.hide = 0; for (const p of r.players.values()) p.lastActiveAt = clk; run(r, 200, () => r.state === STATE.RESULTS); } catch (e) { threw = e; }
  found = ev(r, 'found').length;
  ok(!threw, `${diff}: a full bot round runs without errors` + (threw ? ' ' + threw.stack : ''));
  ok(r.state === STATE.RESULTS || r.state === STATE.PLAY, `${diff}: state is sane (${r.state}), ${found} found, ${ev(r, 'swing').length} swings, ${ev(r, 'dud').length} duds`);
  ok(!botSeeker || ev(r, 'swing').length > 3, `${diff}: seeker bots do swing`);
  ok([...r.players.values()].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), `${diff}: positions stay finite`);
}
// bots in a human-less, all-bot-hider scenario: a human seeker finds them eventually only by chance; make sure the bots hold still (freeze) most of the time
r = new Room('botsfreeze', { kind: 'bots', diff: 'hard' }); r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Me', 0, 0, 0, 0);
r.evs = []; r.setMode('prophunt'); r.forceMode = true; r.startCountdown(); r.forceMode = false; run(r, 12, () => r.state === STATE.PLAY);
{ afterHide(r); let still = 0, total = 0; for (let i = 0; i < 40; i++) { run(r, 1); for (const p of hiders(r)) { total++; if (Math.hypot(p.vx, p.vy) < 5) still++; } }
  ok(total === 0 || still / total > 0.4, `bot hiders spend most of their time frozen (${still}/${total} samples)`); }

console.log(fails ? `\n${fails} Prop Hunt test(s) FAILED` : '\nProp Hunt tests passed');
process.exit(fails ? 1 : 0);
