'use strict';
process.env.VOTE_TIME = '0.4'; process.env.PICK_TIME = '0';
/* God (the secret, staff-only character): data, flight, teleport, beam of light, and who may play it. Runs straight against Room. */
const T = require('../public/shared.js');
const { Room } = require('../src/room.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  : ' : '  FAIL: ') + m); if (!c) fails++; };
let clk = Date.now(); Date.now = () => clk;
const step = (r) => { clk += 1000 / 60; for (const p of r.players.values()) p.lastActiveAt = clk; r.tick(); };
const run = (r, s, stop) => { for (let i = 0; i < s * 60; i++) { step(r); if (stop && stop()) return; } };
const GOD = T.CHARS.findIndex((c) => c.id === 'god');

// ---- data: secret, last, never sold, never in chests
ok(GOD === T.CHARS.length - 1 && T.CHARS[GOD].secret, 'God is the last character and is flagged secret');
ok(T.PUBLIC_CHARS === T.CHARS.length - 1, 'public character count excludes God');
ok(!T.SHOP.some((s) => s.id === 'char:god'), 'God is not in the shop');
ok(!T.SKINS.some((s) => s.char === 'god') && T.SECRET_SKINS.length === T.SKIN_THEMES.length && T.SECRET_SKINS.every((s) => T.parseSkin(s.id)), 'God has its own skins, kept out of SKINS (so no chest drops them)');
{ const ch = require('../src/chests.js'); const src = require('fs').readFileSync(require.resolve('../src/chests.js'), 'utf8'); ok(/T\.SKINS\.filter\(\(s\) => s\.rarity === r\)/.test(src) && !!ch, 'the chest pool is built from SKINS only'); }
ok(T.skinPool('god').length === T.SKIN_THEMES.length && T.skinPool('').every((s) => s.char !== 'god') && T.skinPool('fox').every((s) => s.char !== 'god'), 'staff skin actions only reach God skins when God is named');
ok(T.CHARS[GOD].radius === 27, 'God is 1.5x a normal player (radius 27 vs 18)');
ok(!T.canUseChar([], 'god', true) && !T.canUseChar(['char:god'], 'god', false) && T.canUseChar(['char:god'], 'god', true), 'God needs both a staff account and the unlock');
ok(T.canUseChar([], 'fox', false), 'starters still free for everybody');
ok(T.SIM.includes('z') && T.SIM.includes('bm'), 'altitude and beam are part of the predicted state');

// ---- flight in the shared step (what client and server both run)
const mkMap = () => ({ w: 3000, h: 3000, obstacles: [], rects: [], zones: [], walls: [] });
const room = (n, mode) => {
  const r = new Room('g', { kind: 'custom', name: 'g', max: 15, mode: mode || 'classic', roundTime: 120, bots: 0 });
  r.evs = []; const emit = r.emit.bind(r); r.emit = (e) => { r.evs.push(e); emit(e); };
  const ps = [];
  for (let i = 0; i < n; i++) ps.push(r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'P' + i, i === 0 ? GOD : 0, 0, 0, 0));
  return { r, ps: [...r.players.values()] };
};
{
  const { r, ps } = room(3); const g = ps[0]; g.staff = true;
  run(r, 12, () => r.state === T.STATE.PLAY); ok(r.state === T.STATE.PLAY, 'round reaches play');
  for (const p of ps) { p.stun = 0; p.imm = 0; }
  const feed = (p, inp) => r.queueInputs(p, [[++p.seqT || (p.seqT = 1), 0, 0, 0, 0, 0, inp]]);
  const z0 = g.z || 0;
  for (let i = 0; i < 60; i++) { feed(g, 1); step(r); }
  ok(g.z > z0 + 120, 'holding ascend climbs the longer you hold (z=' + Math.round(g.z) + ')');
  const zMid = g.z; for (let i = 0; i < 60; i++) { feed(g, 1); step(r); }
  ok(g.z > zMid + 120 && g.z <= T.GOD_ZMAX, 'it keeps rising while held, up to the ceiling');
  for (let i = 0; i < 60 * 8; i++) { feed(g, 0); step(r); }
  ok(g.z === 0, 'releasing lets God drift back down to the ground');
  // non-staff cannot use held inputs even if they somehow have the character
  const { r: r2, ps: ps2 } = room(3); const n = ps2[0]; run(r2, 12, () => r2.state === T.STATE.PLAY);
  for (let i = 0; i < 60; i++) { r2.queueInputs(n, [[i + 1, 0, 0, 0, 0, 0, 3]]); step(r2); }
  ok(!n.z && !n.bm, 'without staff status the hold inputs do nothing');
}

// ---- untaggable and unable to tag while high; tags normally on the ground
{
  const { r, ps } = room(3); const [g, a, b] = ps; g.staff = true;
  run(r, 12, () => r.state === T.STATE.PLAY);
  for (const p of ps) { p.stun = 0; p.imm = 0; p.lock = 0; p.it = 0; }
  a.it = 1; a.x = 900; a.y = 900; g.x = 900; g.y = 900; b.x = 2500; b.y = 2500; g.z = 200;
  for (let i = 0; i < 20; i++) step(r);
  ok(!g.it, 'a flying God cannot be tagged');
  a.it = 0; g.it = 1; g.z = 200; a.x = g.x; a.y = g.y;
  for (let i = 0; i < 20; i++) step(r);
  ok(!a.it, 'a flying God cannot tag either');
}

// ---- beam: stuns through everything, ignores immunity, shields and tunnelling; only sideways, only in front
{
  const { r, ps } = room(4); const [g, front, behind, off] = ps; g.staff = true;
  run(r, 12, () => r.state === T.STATE.PLAY);
  for (const p of ps) { p.stun = 0; p.imm = 0; p.lock = 0; p.it = 0; p.vx = p.vy = 0; }
  g.x = 800; g.y = 800; g.fx = 1; front.x = 1400; front.y = 810; behind.x = 300; behind.y = 800; off.x = 1400; off.y = 1000;
  front.imm = 3; front.c = T.CHARS.findIndex((c) => c.id === 'robot'); front.abT = 2;       // immune + shielding: the beam does not care
  for (let i = 0; i < 6; i++) { r.queueInputs(g, [[i + 1, 0, 0, 0, 0, 0, 2]]); step(r); }
  ok(g.bm === 1, 'holding the beam turns it on');
  ok(front.stun > 0 && front.abT === 0, 'someone in the beam is stunned even with immunity and a shield up');
  ok(!behind.stun && !off.stun, 'players behind God or above/below the beam are untouched');
  ok(r.evs.some((e) => e.n === 'beamhit' && e.id === front.id), 'a hit is announced for effects');
  for (let i = 6; i < 80; i++) { r.queueInputs(g, [[i + 1, 0, 0, 0, 0, 0, 2]]); step(r); }
  ok(front.stun > 0, 'the stun lasts as long as the beam is held');
  for (let i = 80; i < 100; i++) { r.queueInputs(g, [[i + 1, 0, 0, 0, 0, 0, 0]]); step(r); }
  ok(g.bm === 0, 'releasing turns the beam off');
  for (let i = 0; i < 90; i++) { r.queueInputs(front, [[500 + i, 0, 0, 0]]); r.queueInputs(g, [[500 + i, 0, 0, 0, 0, 0, 0]]); step(r); }
  ok(front.stun === 0, 'and the stun wears off after');
  // beam follows facing
  g.fx = -1; front.stun = 0; behind.stun = 0; g.x = 800;
  for (let i = 0; i < 6; i++) { r.queueInputs(g, [[1000 + i, 0, 0, 0, 0, 0, 2]]); step(r); }
  ok(behind.stun > 0 && !front.stun, 'it fires the way God is facing');
}

// ---- teleport: staff only, cooldown, lands beside the target
{
  const { r, ps } = room(3); const [g, a, b] = ps; g.staff = true;
  run(r, 12, () => r.state === T.STATE.PLAY);
  for (const p of ps) { p.stun = 0; p.cd = 0; }
  g.x = 300; g.y = 300; a.x = 1500; a.y = 1200;
  ok(r.godTeleport(g, a.id) === true, 'teleport works');
  ok(Math.hypot(g.x - a.x, g.y - a.y) < 90 && Math.hypot(g.x - a.x, g.y - a.y) > 20, 'God lands next to the target');
  ok(g.cd > 0 && r.godTeleport(g, b.id) === false, 'teleport has a cooldown');
  ok(r.evs.some((e) => e.n === 'godtp' && e.id === g.id), 'teleport event for effects');
  g.cd = 0; ok(r.godTeleport(g, g.id) === false && r.godTeleport(g, 99999) === false, 'cannot teleport to yourself or to nobody');
  g.staff = false; ok(r.godTeleport(g, a.id) === false, 'non-staff cannot teleport');
  g.staff = true; a.c = 0; g.c = 0; ok(r.godTeleport(g, a.id) === false, 'only God can teleport');
}

// ---- bots never pick God
{
  const r = new Room('b', { kind: 'bots', name: 'b', max: 15, mode: 'classic', roundTime: 120, bots: 8, solo: true });
  r.addHuman({ readyState: 1, send() {}, rtt: 0 }, 'Me', 0, 0, 0, 0);
  let bad = 0; for (let k = 0; k < 40; k++) { r.rebalanceBots && r.rebalanceBots(); for (const p of r.players.values()) if (p.bot && p.c === GOD) bad++; }
  ok(bad === 0, 'bots never choose God');
}

console.log(fails ? `\n${fails} FAILED` : '\nGod: all ok'); process.exit(fails ? 1 : 0);
