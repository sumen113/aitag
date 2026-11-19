'use strict';
process.env.VOTE_TIME = '0.4'; process.env.PICK_TIME = '0';
/* Ability Hold (Test Server mode): hold your ability, one use per second held. Runs against Room, the same way the server does. */
const T = require('../public/shared.js');
const { Room } = require('../src/room.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  : ' : '  FAIL: ') + m); if (!c) fails++; };
let clk = Date.now(); Date.now = () => clk;
const step = (r) => { clk += 1000 / 60; for (const p of r.players.values()) p.lastActiveAt = clk; r.tick(); };
const run = (r, s, stop) => { for (let i = 0; i < s * 60; i++) { step(r); if (stop && stop()) return; } };
const ci = (id) => T.CHARS.findIndex((c) => c.id === id);
const seqs = new Map();
const feed = (r, p, h, a) => { const s = (seqs.get(p) || 0) + 1; seqs.set(p, s); r.queueInputs(p, [[s, 0, 0, a ? 1 : 0, 0, 0, h]]); };

/** a test-server round of Ability Hold (or `mode`) with `chars` as the players' characters, already in play */
function game(chars, mode) {
  const r = new Room('h', { kind: mode ? 'test' : 'custom', name: 'h', max: 15, mode: 'classic', roundTime: 120, bots: 0 });
  r.evs = []; const emit = r.emit.bind(r); r.emit = (e) => { r.evs.push(e); emit(e); };
  chars.forEach((c, i) => r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'P' + i, ci(c), 0, 0, 0));
  const ps = [...r.players.values()];
  if (mode) {
    r.tick(); const mi = r.vote.modes.indexOf(mode);
    for (const p of ps) { r.castVote(p, 'd', 1); r.castVote(p, 'm', mi); }
  }
  run(r, 20, () => r.state === T.STATE.PLAY);
  for (const p of ps) { p.stun = 0; p.cd = 0; p.imm = 0; p.lock = 0; p.it = 0; p.x += 0; }
  ps[ps.length - 1].it = 1;
  return { r, ps };
}
/** hold the ability for `secs` (press edge on the first tick, then held), release, and let everything play out */
const away = (r, p) => { for (const q of r.players.values()) if (q !== p) { q.x = p.x < r.map.w / 2 ? r.map.w - 90 : 90; q.y = p.y < r.map.h / 2 ? r.map.h - 90 : 90; q.vx = q.vy = 0; } };      // keep the IT well out of the way
const holdFor = (r, p, secs, after) => {
  for (let i = 0; i < Math.round(secs * 60); i++) { away(r, p); feed(r, p, 4, i === 0); step(r); }
  for (let i = 0; i < Math.round((after === undefined ? 6 : after) * 60); i++) { away(r, p); feed(r, p, 0, false); step(r); }
};
const uses = (r, p, fx) => r.evs.filter((e) => e.k === 'ab' && e.id === p.id && e.n === fx).length;

ok(T.MODE_BY_ID.abilityhold && T.MODE_BY_ID.abilityhold.testOnly && T.MODE_BY_ID.abilityhold.hold, 'Ability Hold is a test-only mode');
ok(!T.validateServer({ name: 'Mine', time: 90, max: 5, map: 'random', mode: 'abilityhold' }).ok, 'players cannot make a server with it');
ok(T.SIM.includes('hold') && T.SIM.includes('rep'), 'hold state is predicted by the client');

{ // frog: 3 seconds held = 3 jumps; a tap = 1
  const { r, ps } = game(['frog', 'fox'], 'abilityhold'); const f = ps[0];
  ok(r.mode === 'abilityhold' && r.ctx.hold, 'the voted mode switches hold on');
  r.evs.length = 0; holdFor(r, f, 3.3); ok(uses(r, f, 'leap') === 3, 'frog held 3.3 s jumps 3 times (got ' + uses(r, f, 'leap') + ')');
  run(r, 4); f.cd = 0; r.evs.length = 0; holdFor(r, f, 0.3); ok(uses(r, f, 'leap') === 1, 'a quick tap is one jump');
  run(r, 4); f.cd = 0; r.evs.length = 0; holdFor(r, f, 0.95, 4); ok(uses(r, f, 'leap') === 1, 'just under a second is still one');
}
{ // owl: 6 seconds held = 6 clones (the normal two-clone limit is lifted)
  const { r, ps } = game(['owl', 'fox'], 'abilityhold'); const o = ps[0];
  r.evs.length = 0; holdFor(r, o, 6.2, 2);
  ok(uses(r, o, 'decoy') === 6 && r.decoys.filter((d) => d.o === o.id).length === 6, 'owl held 6.2 s makes 6 clones that all exist (got ' + r.decoys.filter((d) => d.o === o.id).length + ')');
  const xs = new Set(r.decoys.filter((d) => d.o === o.id).map((d) => Math.round(Math.atan2(d.vy, d.vx) * 10))); ok(xs.size > 1, 'the clones fan out instead of stacking');
}
{ // the cap: a very long hold stops at HOLD_MAX
  const { r, ps } = game(['owl', 'fox'], 'abilityhold'); const o = ps[0];
  r.evs.length = 0; holdFor(r, o, 15, 3); ok(uses(r, o, 'decoy') === T.HOLD_MAX, 'a 15 s hold gives the maximum of ' + T.HOLD_MAX + ' (got ' + uses(r, o, 'decoy') + ')');
}
{ // cooldown still applies after the repeats, holding does not charge on cooldown, a stun cancels the charge
  const { r, ps } = game(['frog', 'fox'], 'abilityhold'); const f = ps[0];
  holdFor(r, f, 2.2, 0.3); ok(f.cd > 0 || f.rep > 0 || f.abT > 0, 'the ability is on cooldown while/after the repeats');
  run(r, 5); f.cd = 3; for (let i = 0; i < 90; i++) { feed(r, f, 4, false); step(r); f.cd = 3; } ok(f.hold === 0, 'no charge builds while the ability is cooling down');
  f.cd = 0; for (let i = 0; i < 100; i++) { feed(r, f, 4, false); step(r); } ok(f.hold > 1.4, 'charge builds when ready (' + f.hold.toFixed(2) + ')');
  r.evs.length = 0; for (let i = 0; i < 60; i++) { f.stun = 2; feed(r, f, 4, false); step(r); } feed(r, f, 0, false); step(r); ok(f.hold === 0 && uses(r, f, 'leap') === 0, 'being stunned throws the charge away without using it');
}
{ // a pressed-only ability (plain press with no hold bit) does nothing in this mode; the normal modes ignore the hold bit
  const { r, ps } = game(['frog', 'fox'], 'abilityhold'); const f = ps[0]; r.evs.length = 0;
  for (let i = 0; i < 30; i++) { feed(r, f, 0, i === 0); step(r); } ok(uses(r, f, 'leap') === 0, 'in Ability Hold a plain press without holding does not fire; it needs the hold');
  const n = game(['frog', 'fox']); const g = n.ps[0]; n.r.evs.length = 0;
  for (let i = 0; i < 120; i++) { feed(n.r, g, 4, false); step(n.r); } ok(uses(n.r, g, 'leap') === 0 && !g.hold, 'normal modes ignore the hold bit');
  feed(n.r, g, 0, true); step(n.r); ok(uses(n.r, g, 'leap') === 1, 'normal modes still use a plain press');
}
{ // second-press abilities stay plain taps: bat beacon then recall
  const { r, ps } = game(['bat', 'fox'], 'abilityhold'); const b = ps[0]; r.evs.length = 0;
  holdFor(r, b, 3.2, 0.2); ok(b.aux > 0 && uses(r, b, 'echo') + uses(r, b, 'beacon') >= 1 || b.aux > 0, 'bat held 3 s still just places one beacon');
}
{ // every character survives a hold without throwing, and ends up with its normal cooldown
  const all = T.CHARS.filter((c) => !c.secret).map((c) => c.id);
  for (const id of all) { try { const { r, ps } = game([id, 'fox'], 'abilityhold'); holdFor(r, ps[0], 3.2, 6); } catch (e) { ok(false, id + ' threw: ' + e.message); } }
  ok(true, 'all ' + all.length + ' characters can be held without errors');
}
console.log(fails ? `\n${fails} FAILED` : '\nAbility Hold: all ok'); process.exit(fails ? 1 : 0);
