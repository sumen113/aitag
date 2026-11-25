'use strict';
process.env.VOTE_TIME = '0.4'; process.env.PICK_TIME = '0';
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

// under 7 players only classic tag and Prop Hunt (which needs just 4) are on offer
let r = mk('vote', 6); r.tick();
ok(r.state === T.STATE.VOTE && r.vote.modes.join() === 'classic,prophunt', 'vote has no infection/potato below 7 players (Prop Hunt is there from 4)');
r = mk('potato', 6); run(r, 6, () => r.state === T.STATE.PLAY);
ok(r.mode === 'classic', 'a fixed Hot Potato server plays classic tag below 7 players');
// vote: tally decides mode + map, big map only for infection
r = mk('vote', 7); r.tick();
ok(r.state === T.STATE.VOTE && r.vote.maps.length === 3 && r.vote.modes.length === 4, 'vote opens with 3 arenas and 4 modes at 7+ players');
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
ok(r.mode === 'potato' && r.itPlayers().length === 1 && r.itPlayers()[0].pot > 5.9 && r.itPlayers()[0].pot <= 6 + T.HEAD_START + 0.1, 'potato starts with exactly one holder (even at 7+ players) and a 6 s fuse (plus the head start)');
run(r, 90, () => r.state === T.STATE.RESULTS);
ok(r.state === T.STATE.RESULTS && r.evs.filter((e) => e.k === 'boom').length === 6, 'idle holders explode one by one until a single player is left');
ok(r.results.length === 7 && r.results[0][1] > r.results[1][1], 'winner is the unique top scorer');
// passing the potato resets the fuse and keeps the holder alive
r = mk('potato', 7); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 6);
let h = r.itPlayers()[0], v = [...r.players.values()].find((p) => !p.it);
h.pot = 2; r.tag(h, v);
ok(!h.it && v.it && r.passes === 1 && v.pot === 6, 'a pass moves the potato and resets the fuse to 6 s');
let last = v; for (let k = 0; k < 4; k++) { const a = r.itPlayers()[0], b = [...r.players.values()].find((p) => !p.it && !p.out); r.tag(a, b); last = b; }
r.elims = 4; ok(last.pot === 6 && T.potatoFuse() === 6 && T.potatoFuse(40, 5) === 6, 'the fuse stays 6 s after many passes and eliminations');
// after a pass-then-explosion the potato is re-dealt at random and never goes straight back to whoever passed it (even if everyone else is standing still)
for (const idle of [false, true]) {
  r = mk('potato', 7); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 6);
  const all = [...r.players.values()]; const got = new Set(); let back = 0, trials = 0;
  for (let k = 0; k < 300; k++) {
    for (const p of all) { p.out = 0; p.it = 0; p.pot = 0; p.afk = false; p.gone = 0; }
    const A = all[k % all.length], B = all[(k + 1 + (k % 5)) % all.length]; if (A === B) continue;
    if (idle) for (const p of all) if (p !== A && p !== B) p.afk = true;                 // everyone else stands still: the passer is the only active player
    A.it = 1; A.pot = 6; r.itId = A.id; r.tag(A, B); r.explode(B); trials++;
    const nh = r.itPlayers(); if (nh.length !== 1) { back = -999; break; }
    if (nh[0] === A) back++; got.add(nh[0].id);
  }
  ok(back === 0 && got.size >= 4, 'potato: it never goes straight back to the passer, and the new holder is random (' + (idle ? 'everyone else idle' : 'normal play') + ': ' + trials + ' explosions, ' + got.size + ' different holders, ' + back + ' bounce-backs)');
}
{ r = mk('potato', 7); run(r, 6, () => r.state === T.STATE.PLAY); run(r, 6);
  const all = [...r.players.values()]; let bad = 0;
  for (let k = 0; k < 6; k++) { const A = all[0], B = all[1 + k % 5]; for (const p of all) { p.out = 0; p.it = 0; p.gone = 0; } A.it = 1; r.itId = A.id; r.tag(A, B); r.markGone(B, true); if (A.it) bad++; B.gone = 0; }
  ok(bad === 0, 'potato: a holder who disconnects does not hand the potato straight back to the passer');
  const [A, B, C] = all; for (const p of all) { p.out = 1; p.it = 0; p.gone = 0; } A.out = B.out = C.out = 0; A.it = 1; r.itId = A.id; r.tag(A, B); r.explode(B);
  ok(C.it && !A.it, 'with three left, the potato goes to the one who did not pass it'); }
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

// ---- arenas: ten of them, each playable, and the floor mechanics push the way they should
ok(T.MAPS.length === 8 && T.BIG_MAPS.length === 2 && T.MAPS.concat(T.BIG_MAPS).every((m) => T.MAP_BY_ID[m.id] === m), '10 arenas in total (8 regular + Outbreak + Storehouse)');
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
  const r2 = new Room('m' + m.id, { kind: 'custom', name: 't', max: 8, mode: m.id === 'storehouse' ? 'prophunt' : m.big ? 'infection' : 'classic', roundTime: 120, bots: 3, map: m.id, mapMode: m.id });
  for (let i = 0; i < 5; i++) r2.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'P' + i, 0, 0, 0, 0);
  for (let i = 0; i < 60 * 14; i++) r2.tick();
  const bad = [...r2.players.values()].filter((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < -50 || p.y < -50 || p.x > m.w + 50 || p.y > m.h + 50);
  ok(r2.map.id === m.id && bad.length === 0, m.id + ': round runs and nobody leaves the arena');
}


// ---- change-character window: the first part of the countdown, after the vote ----
{
  const got = []; const wsA = { readyState: 1, send(m) { got.push(JSON.parse(m)); }, rtt: 0 };
  const r3 = new Room('pick', { kind: 'custom', name: 't', max: 15, mode: 'vote', roundTime: 120, bots: 0 });
  r3.pickTime = 7;
  const A = r3.addHuman(wsA, 'Aa', 0, 0, 0, 0), B = r3.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Bb', 0, 0, 0, 0);
  r3.tick(); ok(r3.state === T.STATE.VOTE, 'pick: the vote comes first');
  ok(!r3.canPick() && !r3.setLook(A, 2, 1, ''), 'pick: no character change during the vote');
  run(r3, 20, () => r3.state === T.STATE.COUNT);
  ok(r3.state === T.STATE.COUNT && Math.abs(r3.timer - (T.COUNTDOWN + 7)) < 0.3, 'pick: the countdown starts with the 7 s change window in front of the 4-3-2-1');
  ok(r3.canPick() && r3.setLook(A, 3, 2, 'lava') && A.c === 3 && A.col === 2 && A.skin === 'lava', 'pick: a player can change character, colour and skin');
  ok(r3.setLook(A, 0, 0, '') && A.c === 0, 'pick: and change again');
  ok(!r3.setLook(A, 99, 0, ''), 'pick: unknown characters are refused');
  A.cd = 5; A.abT = 1; r3.setLook(A, 1, 0, ''); ok(A.cd === 0 && A.abT === 0, 'pick: ability state starts fresh on the new character');
  run(r3, 9, () => !r3.canPick());
  ok(!r3.canPick() && r3.state === T.STATE.COUNT && r3.timer <= T.COUNTDOWN + 0.1, 'pick: the window closes when the 4-3-2-1 starts');
  ok(!r3.setLook(A, 2, 0, '') && A.c === 1, 'pick: no change once the countdown is running');
  run(r3, 6, () => r3.state === T.STATE.PLAY); ok(r3.state === T.STATE.PLAY, 'pick: then the round starts');
  ok(!r3.setLook(A, 2, 0, ''), 'pick: no change mid-round');

  // typing bubble: flag bit 64 in snapshots, expires, and is cleared by sending the message
  const flagOf = (pl) => { got.length = 0; r3.sendSnapshots(); const sn = got.filter((m) => m.t === 's').pop(); const e = sn.p.find((x) => x[0] === pl.id); return e[7]; };
  ok((flagOf(B) & 64) === 0, 'typing: no bubble by default');
  B.typeAt = clk + 3000; ok((flagOf(B) & 64) === 64, 'typing: bubble flag set while typing');
  clk += 3100; ok((flagOf(B) & 64) === 0, 'typing: it expires after 3 s without a refresh');
  B.typeAt = clk + 3000; B.lastChat = 0; r3.chat(B, 'hi'); ok((flagOf(B) & 64) === 0, 'typing: sending the message clears the bubble');
}


// ---- wins are anti-farm: main server only, and only with 3+ real players ----
{
  const payout = (kind, n, extra) => {
    const r = mk('classic', n, Object.assign({ kind }, extra)); const won = []; r.onWin = (p) => won.push(p.id);
    let i = 1; for (const p of r.players.values()) { p.uid = i++; p.score = p === [...r.players.values()][0] ? 60 : 5; p.lastActiveAt = clk; }
    r.state = T.STATE.PLAY; r.endRound(); return won.length;
  };
  ok(payout('public', 2) === 0, 'wins: no win in the main server with only 2 players');
  ok(payout('public', 3) === 1, 'wins: a win is paid in the main server with 3 players');
  ok(payout('custom', 8) === 0, 'wins: a private/custom server never pays wins, however many are in it');
  ok(payout('custom', 3, { bots: 0 }) === 0, 'wins: not even a bot-free custom server with 3');
}


// ---- Test Server: always votes on a test-only mode; Tagger Proximity / Tagger Points ----
{
  const tsrv = (n) => mk('vote', n, { kind: 'test', name: T.TEST_NAME });
  let t = tsrv(3); t.tick();
  ok(t.testServer && t.state === T.STATE.VOTE && t.vote.modes.join() === 'proximity,abilityhold,points', 'test server: votes between exactly the three test modes (Proximity, Ability Hold, Points), even with 3 players');
  ok(t.modeOpt === 'vote' && !t.regular, 'test server: always a mode vote, not the regular server');
  const rg = mk('vote', 8, { kind: 'public' }); rg.tick(); ok(!rg.vote.modes.some((m) => T.MODE_BY_ID[m].testOnly), 'regular server: never offers the test modes');
  const pr = mk('vote', 8, { kind: 'bots' }); pr.tick(); ok(!(pr.vote && pr.vote.modes.some((m) => T.MODE_BY_ID[m].testOnly)), 'practice: never offers the test modes');
  const cu = mk('points', 4, {}); ok(cu.modeOpt === 'classic', 'custom server: a test mode cannot be set as its mode');
  ok(!T.validateServer({ name: 'Mine', time: 90, max: 5, map: 'random', mode: 'proximity' }).ok && !T.validateServer({ name: 'Mine', time: 90, max: 5, map: 'random', mode: 'points' }).ok, 'custom server: the create form refuses the test modes');

  const play = (modeId, n) => {
    const r = tsrv(n); r.tick(); const idx = r.vote.modes.indexOf(modeId);
    for (const p of r.players.values()) { r.castVote(p, 'd', idx); r.castVote(p, 'm', 0); }
    run(r, 4, () => r.state === T.STATE.COUNT); run(r, 14, () => r.state === T.STATE.PLAY);
    ok(r.state === T.STATE.PLAY && r.mode === modeId, 'test server: voting for ' + modeId + ' plays it (3 players, still not forced to classic)');
    return r;
  };
  // proximity: closer to IT = faster score. The tagger earns nothing; a stunned tagger gives nothing extra.
  let r4 = play('proximity', 3);
  let it = r4.itPlayers()[0], others = [...r4.players.values()].filter((p) => p !== it), A = others[0], Bp = others[1];
  it.x = 800; it.y = 500; A.x = 800 + 130; A.y = 500; Bp.x = 800 + 900; Bp.y = 500; for (const p of r4.players.values()) { p.vx = p.vy = 0; p.score = 0; p.imm = 0; }
  run(r4, 2.3); it.stun = 0; it.lock = 0;                                  // (head start over)
  for (const p of r4.players.values()) { p.score = 0; }
  const pos = (p) => [p.x, p.y];
  it.stun = 0; run(r4, 2); 
  ok(A.score > Bp.score * 3 && Bp.score > 0.4 && it.score === 0, 'proximity: standing close to IT scores much faster than far away (' + A.score.toFixed(1) + ' vs ' + Bp.score.toFixed(1) + '), IT earns nothing');
  r4 = play('proximity', 3); it = r4.itPlayers()[0]; A = [...r4.players.values()].find((p) => p !== it);
  it.x = 800; it.y = 500; A.x = 830; A.y = 500; it.stun = 2; A.score = 0; A.vx = A.vy = 0; A.imm = 0; it.vx = it.vy = 0;
  run(r4, 1); ok(A.score < 0.5, 'proximity: standing next to a stunned tagger earns only the base rate (' + A.score.toFixed(2) + ')');
  // points: +10 per tag
  const r5 = play('points', 3); it = r5.itPlayers()[0]; A = [...r5.players.values()].find((p) => p !== it);
  it.stun = 0; it.lock = 0; it.score = 0; it.x = 800; it.y = 500; A.x = 815; A.y = 500; A.imm = 0; A.vx = A.vy = 0; it.vx = it.vy = 0;
  step(r5); ok(it.tags >= 1 && it.score >= T.TAG_POINTS && !it.it, 'points: tagging someone gives the tagger 10 points (' + it.score.toFixed(1) + ')');
  ok(r5.evs.some((e) => e.k === 'tag' && e.pts === 10), 'points: the tag event carries the +10 for the client');
  const r6 = play('proximity', 3); const it6 = r6.itPlayers()[0], V = [...r6.players.values()].find((p) => p !== it6);
  it6.stun = 0; it6.lock = 0; it6.score = 0; it6.x = 800; it6.y = 500; V.x = 815; V.y = 500; V.imm = 0; V.vx = V.vy = 0; it6.vx = it6.vy = 0; step(r6);
  ok(it6.score < 1, 'proximity: a tag itself is worth nothing extra');
  // any number of players can vote: even one person alone gets the mode vote every round
  for (const n of [1, 2]) {
    const t1 = tsrv(n); t1.tick();
    ok(t1.state === T.STATE.VOTE && t1.vote.modes.join() === 'proximity,abilityhold,points', 'test server: ' + n + ' player(s) still get the mode vote');
    const pp = [...t1.players.values()]; pp.forEach((p) => { t1.castVote(p, 'd', t1.vote.modes.indexOf('points')); t1.castVote(p, 'm', 0); });
    run(t1, 4, () => t1.state === T.STATE.COUNT); run(t1, 14, () => t1.state === T.STATE.PLAY);
    ok(t1.state === T.STATE.PLAY && t1.mode === 'points', 'test server: ' + n + ' player(s) play the voted mode');
    run(t1, t1.tl + 1, () => t1.state === T.STATE.RESULTS); run(t1, 20, () => t1.state === T.STATE.VOTE);
    ok(t1.state === T.STATE.VOTE, 'test server: ' + n + ' player(s) vote again next round');
  }
  { const t1 = tsrv(2); t1.tick(); const left = [...t1.players.values()][1]; t1.removePlayer(left); step(t1);
    ok(t1.state === T.STATE.VOTE && t1.players.size === 1, 'test server: the vote carries on when all but one player leave'); }
  { const g = mk('vote', 1, { kind: 'public' }); g.tick(); run(g, 1); ok(g.state === T.STATE.WAIT, 'regular server: one player still waits for company'); }
  // wins on the test server
  const payoutT = (n) => { const r = tsrv(n); const won = []; r.onWin = (p) => won.push(p.id); let i = 1; const first = [...r.players.values()][0]; for (const p of r.players.values()) { p.uid = i++; p.score = p === first ? 60 : 5; p.lastActiveAt = clk; } r.state = T.STATE.PLAY; r.endRound(); return won.length; };
  ok(payoutT(2) === 0 && payoutT(3) === 1, 'test server: wins count, but only with 3+ players');
  // staff controls: switch the mode of a running room, end a match early (no wins for it)
  { const payoutS = (end) => { const r = tsrv(3); const won = []; r.onWin = (p) => won.push(p.id); let i = 1; const first = [...r.players.values()][0]; for (const p of r.players.values()) { p.uid = i++; p.score = p === first ? 60 : 5; p.lastActiveAt = clk; } r.state = T.STATE.PLAY; if (end) r.staffEnd(); else r.endRound(); return { won: won.length, state: r.state }; };
    const a1 = payoutS(false), a2 = payoutS(true);
    ok(a1.won === 1 && a2.won === 0 && a2.state === T.STATE.RESULTS, 'staff ending a match shows the results but pays no wins (normal end: ' + a1.won + ', staff end: ' + a2.won + ')');
    let g = mk('classic', 3, { kind: 'public' }); g.tick(); run(g, 8, () => g.state === T.STATE.PLAY);
    ok(g.state === T.STATE.PLAY && g.mode === 'classic', 'staff: a public room with 3 players plays classic');
    ok(g.staffSetMode('nope') !== '' && g.mode === 'classic', 'staff: an unknown mode is refused');
    ok(g.staffSetMode('infection') === '' && g.mode === 'infection' && g.state === T.STATE.COUNT && g.map.id === 'outbreak', 'staff: switching to Infection restarts the round in it, even with fewer than 7 players');
    run(g, 8, () => g.state === T.STATE.PLAY); ok(g.state === T.STATE.PLAY && g.mode === 'infection' && g.itPlayers().length === 1, 'staff: the forced mode actually plays (one zombie)');
    ok(g.staffSetMode('potato') === '' && g.mode === 'potato', 'staff: and can be switched again mid-round');
    run(g, 8, () => g.state === T.STATE.PLAY); ok(g.itPlayers().length === 1 && g.itPlayers()[0].pot > 5.9, 'staff: Hot Potato starts with one holder and the 6 s fuse');
    ok(g.staffEnd() === '' && g.state === T.STATE.RESULTS && g.evs.some((e) => e.k === 'redo' && /ended/i.test(e.m)), 'staff: end match goes to the results with a notice');
    ok(g.staffEnd() !== '', 'staff: nothing to end while the results show');
    run(g, 20, () => g.state === T.STATE.VOTE || g.state === T.STATE.COUNT); run(g, 12, () => g.state === T.STATE.PLAY);
    ok(g.state === T.STATE.PLAY && g.mode === 'classic', 'staff: afterwards the room goes back to its normal rule (classic)');
    g.staffSetMode('abilityhold'); ok(g.mode === 'abilityhold' && g.ctx.hold === true, 'staff: test-only modes can be forced too');
    run(g, 6, () => g.state === T.STATE.COUNT); g.staffEnd(); ok(g.state !== T.STATE.RESULTS && g.state !== T.STATE.WAIT, 'staff: ending during the countdown starts a fresh round instead');
    // G while out: staff join the running round with 0 points that never grow
    for (const mode of ['infection', 'potato']) {
      const q = mk(mode, 7, { kind: 'public' }); q.tick(); run(q, 12, () => q.state === T.STATE.PLAY); ok(q.state === T.STATE.PLAY && q.mode === mode, 'staff join (' + mode + '): round is running');
      const late = q.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Late', 0, 0, 7, 0), pleb = q.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Pleb', 0, 0, 8, 0);
      ok(late.out === 1 && late.wait === 1 && pleb.out === 1, 'staff join (' + mode + '): late arrivals are spectators');
      ok(q.staffJoin(late) === false && q.staffJoin(pleb) === false && late.out === 1, 'staff join: a non-staff account cannot jump in');
      late.staff = true; ok(q.staffJoin(late) === true && !late.out && !late.wait && late.noScore === 1 && late.imm > 0, 'staff join (' + mode + '): staff jump in and are alive');
      ok(q.staffJoin(late) === false, 'staff join: nothing to do when already playing');
      pleb.staff = true; const lateAfk = late; run(q, 12);
      const others = [...q.players.values()].filter((x) => x !== late && x !== pleb && !x.out);
      ok(late.score === 0 && others.some((x) => x.score > 0), 'staff join (' + mode + '): their points stay 0 while the others score (' + late.score.toFixed(2) + ' vs ' + (others[0] ? others[0].score.toFixed(1) : '-') + ')');
      // eliminated players can come back too
      const dead = [...q.players.values()].find((x) => x.out && x !== pleb && !x.wait); if (dead) { dead.staff = true; ok(q.staffJoin(dead) === true && !dead.out, 'staff join (' + mode + '): an eliminated staff player can come back in'); }
      // they never get the win or the last-standing bonus
      late.out = 0; late.it = 0; q.endRound(); ok(late.score === 0 && q.results.find((r) => r[0] === late.id)[1] === 0, 'staff join (' + mode + '): no last-standing bonus either');
    }
    { const q = mk('infection', 7, { kind: 'public' }); q.tick(); run(q, 12, () => q.state === T.STATE.PLAY); const late = q.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Late', 0, 0, 7, 0); late.staff = true; q.staffJoin(late); late.score = 77;
      const won = []; q.onWin = (w) => won.push(w.id); for (const x of q.players.values()) { x.uid = x.uid || x.id; } q.regular = true; q.endRound(); ok(!won.includes(late.id) && late.score === 0, 'staff join: even an inflated score is cleared and they never get a win');
      run(q, 30, () => q.state === T.STATE.COUNT); ok(!late.noScore, 'staff join: scoring is back to normal in the next round'); }
    const lone = mk('classic', 1, { kind: 'public' }); ok(lone.staffSetMode('infection') !== '' && lone.staffEnd() !== '', 'staff: nothing to switch or end in a room that is only waiting for players'); }
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nALL PASSED'); process.exit(fails ? 1 : 0);
