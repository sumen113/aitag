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

// vote: tally decides mode + map, big map only for infection
let r = mk('vote', 4); r.tick();
ok(r.state === T.STATE.VOTE && r.vote.maps.length === 3 && r.vote.modes.length === 3, 'vote opens with 3 arenas and 3 modes');
const ps = [...r.players.values()];
const pi = r.vote.modes.indexOf('potato'); ps.forEach((p) => { r.castVote(p, 'd', pi); r.castVote(p, 'm', 1); });
const wantMap = r.vote.maps[1];
run(r, 3, () => r.state === T.STATE.COUNT);
ok(r.state === T.STATE.COUNT && r.mode === 'potato' && r.map.id === wantMap, 'unanimous vote picks that mode and arena');
r.castVote(ps[0], 'd', 0); ok(true, 'late vote ignored without crashing');
r = mk('vote', 4); r.tick(); const ii = r.vote.modes.indexOf('infection'); [...r.players.values()].forEach((p) => { r.castVote(p, 'd', ii); r.castVote(p, 'm', 0); });
run(r, 3, () => r.state === T.STATE.COUNT);
ok(r.mode === 'infection' && r.map.id === 'outbreak', 'infection always plays on Outbreak');
r = mk('vote', 3); r.tick(); const ci = r.vote.modes.indexOf('classic'); [...r.players.values()].forEach((p) => { r.castVote(p, 'd', ci); r.castVote(p, 'm', 0); });
run(r, 3, () => r.state === T.STATE.COUNT);
ok(r.mode === 'classic' && !r.map.big, 'classic never uses the big map');
r.castVote(null, 'd', 0); ok(true, 'bad vote caller ignored');

// Hot Potato
r = mk('potato', 6); run(r, 6, () => r.state === T.STATE.PLAY);
ok(r.mode === 'potato' && r.itPlayers().length === 1 && r.itPlayers()[0].pot > 9, 'potato starts with one holder and a ~10 s fuse');
run(r, 90, () => r.state === T.STATE.RESULTS);
ok(r.state === T.STATE.RESULTS && r.evs.filter((e) => e.k === 'boom').length === 5, 'idle holders explode one by one until a single player is left');
ok(r.results.length === 6 && r.results[0][1] > r.results[1][1], 'winner is the unique top scorer');
// passing the potato resets the fuse and keeps the holder alive
r = mk('potato', 4); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 6);
let h = r.itPlayers()[0], v = [...r.players.values()].find((p) => p !== h);
h.pot = 2; r.tag(h, v);
ok(!h.it && v.it && Math.abs(v.pot - T.potatoFuse(r.elims)) < 1e-6, 'a pass moves the potato and restarts the fuse');
ok(T.potatoFuse(0) === 10 && T.potatoFuse(3) < T.potatoFuse(1) && T.potatoFuse(99) === T.POTATO_MIN, 'fuse shrinks per elimination, floored');
r = mk('potato', 8); run(r, 6, () => r.state === T.STATE.PLAY);
ok(r.itPlayers().length === 2, 'two potatoes at 7+ players');
// eliminated players never get the potato or tags
r = mk('potato', 5); run(r, 6, () => r.state === T.STATE.PLAY);
const first = r.itPlayers()[0]; r.explode(first);
ok(first.out === 1 && !first.it && r.itPlayers().length === 1 && r.itPlayers()[0] !== first, 'explosion eliminates the holder and passes the potato on');

// Infection
r = mk('infection', 5); run(r, 6, () => r.state === T.STATE.PLAY);
ok(r.map.id === 'outbreak' && r.itPlayers().length === 1, 'infection starts with one zombie on Outbreak');
let z = r.itPlayers()[0], surv = [...r.players.values()].filter((p) => !p.it);
r.tag(z, surv[0]);
ok(z.it && surv[0].it && r.itPlayers().length === 2, 'a tag infects the victim and the tagger stays a zombie');
r.tag(z, surv[1]); run(r, 0.1);
ok(r.state === T.STATE.PLAY, 'round continues while 2 or more survive');
r.tag(z, surv[2]); run(r, 0.1);
ok(r.state === T.STATE.RESULTS, 'round ends when the last survivor is the only one left');

// joining mid-match
r = mk('classic', 4); run(r, 6, () => r.state === T.STATE.PLAY);
const late = r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Late', 0, 0, 0, 0);
ok(late.out === 1 && late.wait === 1 && !late.it, 'player joining a running match waits as a spectator');
const before = r.aliveCount(); run(r, 1); ok(r.aliveCount() === before, 'spectator is not counted as alive');
r.endRound(); ok(!r.results.some((x) => x[0] === late.id), 'spectator is not in the results');
run(r, T.RESULTS_TIME + 2, () => r.state === T.STATE.COUNT);
ok(r.state === T.STATE.COUNT && late.out === 0 && late.wait === 0, 'spectator plays from the next round');

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED'); process.exit(fails ? 1 : 0);
