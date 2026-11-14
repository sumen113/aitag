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
// the sim runs faster than real time here, so give Room (which timestamps activity with Date.now) a clock that moves one tick per tick
let clk = Date.now(); Date.now = () => clk;
const step = (r) => { clk += 1000 / 60; if (!r.idleTest) for (const p of r.players.values()) p.lastActiveAt = clk; r.tick(); };     // test players count as playing unless a test is about idling
const run = (r, s, stop) => { for (let i = 0; i < s * 60; i++) { step(r); if (stop && stop()) return; } };

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
ok(r.mode === 'potato' && r.itPlayers().length === 1 && r.itPlayers()[0].pot > 9, 'potato starts with exactly one holder (even at 7+ players) and a ~10 s fuse');
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
ok(first.out === 1 && !first.it && r.itPlayers().length === 1 && !r.itPlayers().includes(first), 'explosion eliminates the holder and passes the potato on');

// Infection
r = mk('infection', 7); run(r, 6, () => r.state === T.STATE.PLAY);
ok(r.map.id === 'outbreak' && r.itPlayers().length === 1, 'infection starts with exactly one zombie on Outbreak');
let z = r.itPlayers()[0], surv = [...r.players.values()].filter((p) => !p.it);
r.tag(z, surv[0]);
ok(z.it && surv[0].it && r.itPlayers().length === 2, 'a tag infects the victim and the tagger stays a zombie');
r.tag(z, surv[1]); r.tag(z, surv[2]); r.tag(z, surv[3]); run(r, 0.1);
ok(r.state === T.STATE.PLAY, 'round continues while 2 or more survive');
r.tag(z, surv[4]); run(r, 0.1);
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

// standing still never removes you (only a lost connection does); it just marks you afk, and moving clears that
r = mk('classic', 4); r.idleTest = true; run(r, 6, () => r.state === T.STATE.PLAY);
{
  const hs = [...r.players.values()].sort((a, b) => a.it - b.it), camper = hs[0], mover = hs[2], got = [];
  camper.ws.send = (m) => got.push(m); camper.ws.close = () => { got.push('closed'); };
  const bx = mover.x;
  for (let i = 0; i < 60 * 40; i++) { step(r); if (r.state !== T.STATE.PLAY) break; mover.x = bx + (i % 300); }
  ok(r.players.has(camper.id) && !got.includes('closed') && !got.some((m) => String(m).includes('"kick"')), 'a player standing still for the whole round is NOT removed');
  ok(!got.some((m) => String(m).includes('"idle"')), 'no "move or be removed" warning any more');
  ok(r.players.has(mover.id), 'a moving player stays in too');
}
// an idle player who gets tagged doesn't make the tag jump
r = mk('classic', 4); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 5);
{ const it = r.itPlayers()[0], v = [...r.players.values()].find((p) => !p.it); it.imm = 0; v.imm = 0; r.tag(it, v); run(r, 1); ok(r.itPlayers().length === 1 && v.it === 1, 'tagging someone who stands still hands them the tag for real'); }

// the only infected player leaves: the round is redone (vote again), nobody else gets the infection
r = mk('vote', 7); r.tick(); { const ps = [...r.players.values()], pi = r.vote.modes.indexOf('infection'); ps.forEach((p) => { r.castVote(p, 'd', pi); r.castVote(p, 'm', 0); }); }
run(r, 6, () => r.state === T.STATE.PLAY); run(r, 3);
ok(r.mode === 'infection' && r.itPlayers().length === 1, 'infection starts with one zombie');
{ const z = r.itPlayers()[0], n = r.players.size; r.removePlayer(z); ok(r.state === T.STATE.VOTE && r.players.size === n - 1 && r.itPlayers().length === 0, 'lone zombie leaves: back to the vote, nobody inherits it'); }
r = mk('infection', 7); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 2);
{ const z = r.itPlayers()[0]; r.removePlayer(z); ok(r.state === T.STATE.COUNT && r.itPlayers().length === 0, 'fixed infection server: lone zombie leaves, round restarts'); run(r, 6, () => r.state === T.STATE.PLAY); ok(r.itPlayers().length === 1, 'and a fresh zombie is picked'); }
// with several zombies the round carries on
r = mk('infection', 7); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 2);
{ const z = r.itPlayers()[0], v = [...r.players.values()].find((p) => !p.it); r.tag(z, v); r.removePlayer(z); ok(r.state === T.STATE.PLAY && r.itPlayers().length === 1, 'one of two zombies leaving does not restart the round'); }

// ---- new characters
const CI = (id) => T.CHARS.findIndex((c) => c.id === id);
{ // Max the dog: a pit stops the other side, not himself or his own side
  r = mk('classic', 4); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 1);
  const it = r.itPlayers()[0], rs = [...r.players.values()].filter((p) => !p.it), dog = rs[0], mate = rs[1];
  dog.c = CI('dog'); it.stun = 0; it.lock = 0; mate.imm = 0;
  r.abilityEvent(dog, { n: 'pit', x: dog.x, y: dog.y, dx: 0, dy: 0 });
  ok(r.pits.length === 1, 'the dog digs a pit');
  mate.x = r.pits[0].x; mate.y = r.pits[0].y; step(r);
  ok(!(mate.stun > 0) && r.pits.length === 1, 'a runner on the dog\'s own side does not fall in');
  step(r); ok(!(dog.stun > 0), 'the dog does not fall in his own pit');
  it.x = r.pits[0].x + 5; it.y = r.pits[0].y; it.stun = 0; step(r);
  ok(it.stun > 1.5 && r.pits.length === 0, 'the tagger drops into the pit and is stuck for a moment');
  it.x = dog.x + 400; r.abilityEvent(dog, { n: 'pit', x: dog.x, y: dog.y, dx: 0, dy: 0 }); it.x = r.pits[0].x; it.y = r.pits[0].y; step(r);
  ok(!(it.stun > 1.5) || r.pits.length === 1, 'someone just freed from a pit gets a short grace period');
  for (let i = 0; i < 4; i++) r.abilityEvent(dog, { n: 'pit', x: dog.x + i * 5, y: dog.y, dx: 0, dy: 0 });
  ok(r.pits.filter((x) => x.o === dog.id).length <= 3, 'at most three pits per dog');
}
{ // Marty the mole: untaggable underground, can't tag, pops up with a daze
  r = mk('classic', 4); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 1);
  const it = r.itPlayers()[0], rs = [...r.players.values()].filter((p) => !p.it), mole = rs[0];
  mole.c = CI('mole'); mole.abT = 2; mole.x = 800; mole.y = 800; it.x = 805; it.y = 800; it.stun = 0; it.lock = 0; mole.imm = 0;
  step(r); step(r); ok(mole.it === 0, 'a tunnelling mole cannot be tagged');
  mole.abT = 0; it.x = mole.x + 3; it.y = mole.y; it.stun = 0; it.lock = 0; mole.imm = 0; run(r, 0.2);
  ok(mole.it === 1, 'and can be tagged again once surfaced');
}
{ // the mole as IT can't tag from underground, and the sim announces the pop-up
  r = mk('classic', 4); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 1);
  const it = r.itPlayers()[0], v = [...r.players.values()].find((p) => !p.it);
  it.c = CI('mole'); it.abT = 2; it.stun = 0; it.lock = 0; v.x = it.x + 4; v.y = it.y; v.imm = 0; run(r, 0.3);
  ok(v.it === 0, 'an underground mole can\'t tag');
  const m = T.newSim(1, CI('mole'), 500, 500), ev = [], ctx2 = { map: T.MAP_BY_ID[T.MAPS[0].id], goos: [] };
  T.stepPlayer(m, { s: 1, x: 0, y: 0, a: 1 }, ctx2, ev);
  ok(m.abT > 2.3 && m.cd > 12, 'burrow starts the tunnel and the cooldown');
  let surfaced = 0; for (let i = 0; i < 60 * 3; i++) { const e2 = []; T.stepPlayer(m, { s: 2 + i, x: 0, y: 0, a: 0 }, ctx2, e2); if (e2.some((e) => e.n === 'surface')) surfaced++; }
  ok(surfaced === 1 && m.abT === 0, 'the sim announces the pop-up exactly once when time runs out');
  const m2 = T.newSim(1, CI('mole'), 500, 500); T.stepPlayer(m2, { s: 1, x: 0, y: 0, a: 1 }, ctx2, []);
  for (let i = 0; i < 30; i++) T.stepPlayer(m2, { s: 2 + i, x: 0, y: 0, a: 0 }, ctx2, []);
  const e3 = []; T.stepPlayer(m2, { s: 99, x: 0, y: 0, a: 1 }, ctx2, e3);
  ok(m2.abT === 0 && e3.some((e) => e.n === 'surface'), 'pressing the button again pops up early');
  const m3 = T.newSim(1, CI('mole'), 500, 500), e4 = []; T.stepPlayer(m3, { s: 1, x: 0, y: 0, a: 1 }, ctx2, e4); T.stepPlayer(m3, { s: 2, x: 0, y: 0, a: 1 }, ctx2, e4);
  ok(m3.abT > 2, 'pressing straight away does not cancel the burrow');
}
{ // Dusty the donkey kicks in a cone behind him
  r = mk('classic', 5); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 1);
  const ps = [...r.players.values()], d = ps[0], behind = ps[1], front = ps[2], side = ps[3];
  d.c = CI('donkey'); d.x = 900; d.y = 700; behind.x = 820; behind.y = 702; front.x = 980; front.y = 700; side.x = 900; side.y = 780;
  for (const q of ps) { q.stun = 0; q.vx = q.vy = 0; }
  r.abilityEvent(d, { n: 'kick', x: d.x, y: d.y, dx: 1, dy: 0 });
  ok(behind.stun >= 0.7 && behind.vx < -300, 'a player behind the donkey is launched away and stunned');
  ok(!(front.stun > 0) && !(side.stun > 0), 'the front and the sides are safe');
  const dn = T.newSim(1, CI('donkey'), 500, 500); T.stepPlayer(dn, { s: 1, x: 1, y: 0, a: 1 }, { map: T.MAP_BY_ID[T.MAPS[0].id], goos: [] }, []);
  ok(dn.boostT > 0.3, 'the donkey lunges forward as he kicks');
}
{ // Pepper's cloud flips everyone else's controls, but not the skunk's own
  const ctx3 = { map: T.MAP_BY_ID[T.MAPS[0].id], goos: [{ id: 1, x: 500, y: 500, r: 88, o: 77, ttl: 3, s: 2 }] };
  const a = T.newSim(5, 0, 500, 500), b = T.newSim(77, CI('skunk'), 500, 500), c = T.newSim(6, 0, 900, 500);
  for (let i = 0; i < 20; i++) for (const q of [a, b, c]) T.stepPlayer(q, { s: i + 1, x: 1, y: 0, a: 0 }, ctx3, []);
  ok(a.vx < 0 || a.x < 500, 'pushing right inside the cloud moves you left');
  ok(b.x > 500 && c.x > 900, 'the skunk and anyone outside move normally');
}

// avocado shoots at the aim vector, not the walking direction
r = mk('classic', 3); run(r, 6, () => r.state === T.STATE.PLAY);
const av = [...r.players.values()][0]; av.c = T.CHARS.findIndex((c) => c.id === 'avocado'); av.cd = 0; av.stun = 0; av.lock = 0;
r.runStep(av, { s: 1, x: 1, y: 0, a: 1, ax: 0, ay: -1 });
const sd = r.seeds.find((x) => x.o === av.id);
ok(sd && sd.vy < -700 && Math.abs(sd.vx) < 50, 'avocado seed flies toward the mouse even while walking sideways');
ok(av.cd === 15 && T.CHARS.find((c) => c.id === 'frog').cd === 14, 'avocado recharges in 15 s, frog in 14 s');
r.queueInputs(av, [[2, 0, 0, 1, 3, 4]]); const q = av.queue[av.queue.length - 1]; ok(Math.abs(q.ax - 0.6) < 0.011 && Math.abs(q.ay - 0.8) < 0.011, 'server normalises the aim vector');
r.queueInputs(av, [[3, 0, 0, 1, 'x', null]]); ok(av.queue[av.queue.length - 1].ax === undefined, 'junk aim is ignored');

// ---- arenas: nine of them, each playable, and the floor mechanics push the way they should
ok(T.MAPS.length === 8 && T.BIG_MAPS.length === 1 && T.MAPS.concat(T.BIG_MAPS).every((m) => T.MAP_BY_ID[m.id] === m), '9 arenas in total (8 regular + Outbreak)');
const sim = (map, x, y, secs, inp) => {
  const p = T.newSim(1, 0, x, y), ctx = { map, goos: [], itBoost: 1 };
  for (let i = 0; i < secs * 60; i++) T.stepPlayer(p, Object.assign({ s: i, x: 0, y: 0, a: 0 }, inp), ctx, null);
  return p;
};
const fac = T.MAP_BY_ID.factory, topBelt = fac.zones[0];
let qq = sim(fac, 600, 215, 1);
ok(qq.x > 600 + 150 && Math.abs(qq.y - 215) < 5, 'a conveyor carries a standing player along its direction');
qq = sim(fac, 1000, 215, 1, { x: -1 });
ok(qq.x > 1000 - 250 && qq.x < 1000 - 40, 'running against a belt is slower than running with it');
const reef = T.MAP_BY_ID.reef, wp = reef.zones.find((z) => z.k === 'swirl');
qq = sim(reef, wp.x + 100, wp.y, 0.6);
ok(Math.abs(qq.y - wp.y) > 40, 'a whirlpool pulls a standing player round its centre');
const pin = T.MAP_BY_ID.pinball, bz = pin.zones.find((z) => z.k === 'bump');
qq = sim(pin, bz.x + 40, bz.y, 0.5);
ok(Math.hypot(qq.x - bz.x, qq.y - bz.y) > Math.hypot(40, 0), 'a bumper kicks a player outwards');
for (const m of T.MAPS.concat(T.BIG_MAPS)) {
  const r2 = new Room('m' + m.id, { kind: 'custom', name: 't', max: 8, mode: m.big ? 'infection' : 'classic', roundTime: 120, bots: 3, map: m.id, mapMode: m.id });
  for (let i = 0; i < 5; i++) r2.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'P' + i, 0, 0, 0, 0);
  for (let i = 0; i < 60 * 14; i++) r2.tick();
  const bad = [...r2.players.values()].filter((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -50 || p.y < -50 || p.x > m.w + 50 || p.y > m.h + 50);
  ok(r2.map.id === m.id && bad.length === 0, m.id + ': round runs and nobody leaves the arena');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED'); process.exit(fails ? 1 : 0);
