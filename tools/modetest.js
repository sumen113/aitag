'use strict';
process.env.VOTE_TIME = '0.4';
/* Game-mode rules, run straight against Room (no sockets): voting, Infection, Hot Potato, spectators. */
const T = require('../public/shared.js');
const { Room } = require('../src/room.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  : ' : '  FAIL: ') + m); if (!c) fails++; };
const mk = (mode, n, extra) => {
  const r = new Room('t' + mode, Object.assign({ kind: 'custom', name: 't', max: 15, mode, roundTime: 120, bots: 0 }, extra));
  r.evs = []; const emit = r.emit.bind(r); r.emit = (e) => { r.evs.push(e); emit(e); };
  for (let i = 0; i < n; i++) r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'P' + i, 0, 0, 0, 0);
  return r;
};
const run = (r, s, stop) => { for (let i = 0; i < s * 60; i++) { r.tick(); if (stop && stop()) return; } };

// under 7 players there is only classic tag
let r = mk('vote', 6); r.tick();
ok(r.state === T.STATE.VOTE && r.vote.modes.join() === 'classic', 'vote has no special modes below 7 players');
r = mk('potato', 6); run(r, 6, () => r.state === T.STATE.PLAY);
ok(r.mode === 'classic', 'a fixed Hot Potato server plays classic tag below 7 players');
// vote: tally decides mode + map, big map only for infection
r = mk('vote', 7); r.tick();
ok(r.state === T.STATE.VOTE && r.vote.maps.length === 3 && r.vote.modes.length === 3, 'vote opens with 3 arenas and 3 modes at 7+ players');
const ps = [...r.players.values()];
const pi = r.vote.modes.indexOf('potato'); ps.forEach((p) => { r.castVote(p, 'd', pi); r.castVote(p, 'm', 1); });
const wantMap = r.vote.maps[1];
run(r, 3, () => r.state === T.STATE.COUNT);
ok(r.state === T.STATE.COUNT && r.mode === 'potato' && r.map.id === wantMap, 'unanimous vote picks that mode and arena');
r.castVote(ps[0], 'd', 0); ok(true, 'late vote ignored without crashing');
r = mk('vote', 7); r.tick(); const ii = r.vote.modes.indexOf('infection'); [...r.players.values()].forEach((p) => { r.castVote(p, 'd', ii); r.castVote(p, 'm', 0); });
run(r, 3, () => r.state === T.STATE.COUNT);
ok(r.mode === 'infection' && r.map.id === 'outbreak', 'infection always plays on Outbreak');
r = mk('vote', 7); r.tick(); const ci = r.vote.modes.indexOf('classic'); [...r.players.values()].forEach((p) => { r.castVote(p, 'd', ci); r.castVote(p, 'm', 0); });
run(r, 3, () => r.state === T.STATE.COUNT);
ok(r.mode === 'classic' && !r.map.big, 'classic never uses the big map');
r.castVote(null, 'd', 0); ok(true, 'bad vote caller ignored');

// Hot Potato
r = mk('potato', 7); run(r, 6, () => r.state === T.STATE.PLAY);
ok(r.mode === 'potato' && r.itPlayers().length === 2 && r.itPlayers()[0].pot > 9, 'potato starts with two holders (7 players) and a ~10 s fuse');
run(r, 90, () => r.state === T.STATE.RESULTS);
ok(r.state === T.STATE.RESULTS && r.evs.filter((e) => e.k === 'boom').length === 6, 'idle holders explode one by one until a single player is left');
ok(r.results.length === 7 && r.results[0][1] > r.results[1][1], 'winner is the unique top scorer');
// passing the potato resets the fuse and keeps the holder alive
r = mk('potato', 7); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 6);
let h = r.itPlayers()[0], v = [...r.players.values()].find((p) => !p.it);
h.pot = 2; const f0 = T.potatoFuse(r.passes, r.elims); r.tag(h, v);
ok(!h.it && v.it && r.passes === 1 && Math.abs(v.pot - T.potatoFuse(1, r.elims)) < 1e-6 && v.pot < f0, 'a pass moves the potato and the fuse gets shorter every pass');
const vPot = v.pot; let last = v; for (let k = 0; k < 4; k++) { const a = r.itPlayers()[0], b = [...r.players.values()].find((p) => !p.it && !p.out); r.tag(a, b); last = b; }
ok(last.pot < vPot, 'each further pass shortens it more');
ok(T.potatoFuse(0, 0) === 10 && T.potatoFuse(5, 0) < T.potatoFuse(1, 0) && T.potatoFuse(0, 3) < T.potatoFuse(0, 1) && T.potatoFuse(99, 99) === T.POTATO_MIN, 'fuse shrinks per pass and per elimination, floored');
// eliminated players never get the potato or tags
r = mk('potato', 7); run(r, 6, () => r.state === T.STATE.PLAY);
const first = r.itPlayers()[0]; r.explode(first);
ok(first.out === 1 && !first.it && r.itPlayers().length === 2 && !r.itPlayers().includes(first), 'explosion eliminates the holder and passes the potato on');

// Infection
r = mk('infection', 7); run(r, 6, () => r.state === T.STATE.PLAY);
ok(r.map.id === 'outbreak' && r.itPlayers().length === 2, 'infection starts with two zombies on Outbreak at 7 players');
let z = r.itPlayers()[0], surv = [...r.players.values()].filter((p) => !p.it);
r.tag(z, surv[0]);
ok(z.it && surv[0].it && r.itPlayers().length === 3, 'a tag infects the victim and the tagger stays a zombie');
r.tag(z, surv[1]); r.tag(z, surv[2]); run(r, 0.1);
ok(r.state === T.STATE.PLAY, 'round continues while 2 or more survive');
r.tag(z, surv[3]); run(r, 0.1);
ok(r.state === T.STATE.RESULTS, 'round ends when the last survivor is the only one left');

// classic tag can be joined mid-round, special modes can't
r = mk('classic', 4); run(r, 6, () => r.state === T.STATE.PLAY);
const early = r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Early', 0, 0, 0, 0);
ok(!early.out && !early.wait, 'a player joining a running classic round plays straight away');
r = mk('potato', 7); run(r, 6, () => r.state === T.STATE.PLAY);
const late = r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Late', 0, 0, 0, 0);
ok(late.out === 1 && late.wait === 1 && !late.it, 'player joining a running match waits as a spectator');
const before = r.aliveCount(); run(r, 1); ok(r.aliveCount() === before, 'spectator is not counted as alive');
r.endRound(); ok(!r.results.some((x) => x[0] === late.id), 'spectator is not in the results');
run(r, T.RESULTS_TIME + 2, () => r.state === T.STATE.COUNT);
ok(r.state === T.STATE.COUNT && late.out === 0 && late.wait === 0, 'spectator plays from the next round');

// a dead connection can't be tagged and can't hold the tag
r = mk('classic', 4); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 4);
const it0 = r.itPlayers()[0], run0 = [...r.players.values()].find((p) => !p.it);
r.markGone(it0, true);
ok(!it0.it && r.itPlayers().length === 1 && r.itPlayers()[0] !== it0, 'IT is handed on at once when its connection goes quiet');
const tagger = r.itPlayers()[0]; it0.x = tagger.x + 2; it0.y = tagger.y; it0.imm = 0; tagger.stun = 0; tagger.lock = 0;
const tc = r.tagCount; run(r, 0.5);
ok(r.tagCount === tc || !it0.it, 'a gone player can not be tagged');
r.markGone(it0, false); ok(!it0.gone, 'comes back when the connection answers again');

// avocado shoots at the aim vector, not the walking direction
r = mk('classic', 3); run(r, 6, () => r.state === T.STATE.PLAY);
const av = [...r.players.values()][0]; av.c = T.CHARS.findIndex((c) => c.id === 'avocado'); av.cd = 0; av.stun = 0; av.lock = 0;
r.runStep(av, { s: 1, x: 1, y: 0, a: 1, ax: 0, ay: -1 });
const sd = r.seeds.find((x) => x.o === av.id);
ok(sd && sd.vy < -700 && Math.abs(sd.vx) < 50, 'avocado seed flies toward the mouse even while walking sideways');
ok(av.cd === 15 && T.CHARS.find((c) => c.id === 'frog').cd === 14, 'avocado recharges in 15 s, frog in 14 s');
r.queueInputs(av, [[2, 0, 0, 1, 3, 4]]); const q = av.queue[av.queue.length - 1]; ok(Math.abs(q.ax - 0.6) < 0.011 && Math.abs(q.ay - 0.8) < 0.011, 'server normalises the aim vector');
r.queueInputs(av, [[3, 0, 0, 1, 'x', null]]); ok(av.queue[av.queue.length - 1].ax === undefined, 'junk aim is ignored');

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED'); process.exit(fails ? 1 : 0);
