'use strict';
/* Chests: odds, pity, duplicates, paying, daily streak, crafting, double-click safety. Runs the same checks on Postgres (pg-mem) and the file store. */
const { newDb } = require('pg-mem');
const db = require('../src/db');
const T = require('../public/shared.js');
const Chests = require('../src/chests.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } else console.log('  ok  :', m); };

/* ---- pure: odds and pity (seeded so the test is repeatable) ---- */
function pure() {
  console.log('rolling');
  const rand = T.mulberry32(12345);
  const pity0 = Object.assign({}, T.PITY); T.PITY.epic = T.PITY.legendary = 1e9;      // measure the raw odds without pity
  for (const id of T.CHEST_ORDER) {
    const tier = T.CHEST_TIERS[id], N = 40000, got = [0, 0, 0, 0, 0];
    ok(Math.abs(tier.odds.reduce((a, b) => a + b, 0) - 100) < 1e-9, id + ' odds add up to 100%');
    let l = Chests.emptyLedger();
    for (let i = 0; i < N; i++) {
      const res = Chests.roll(tier, l, [], rand);
      got[res.rarity]++;
      l = Chests.applyRoll(l, tier, res).ledger;
    }
    // each rarity must be near its advertised odds
    const near = tier.odds.every((p, r) => Math.abs((got[r] / N) * 100 - p) < Math.max(1.2, p * 0.25));
    ok(near, id + ' real odds near advertised: ' + got.map((g) => ((g / N) * 100).toFixed(1)).join('/') + ' vs ' + tier.odds.join('/'));
    ok(id !== 'gold' || got[0] === 0, 'golden chests never give common');
    ok(id !== 'wood' || got[4] === 0, 'wood never gives legendary without pity');
  }
  Object.assign(T.PITY, pity0);
  // pity: a long unlucky streak of wooden chests (rand always 0 -> common) must hit an epic exactly when promised
  const wood = T.CHEST_TIERS.wood; let l = Chests.emptyLedger(), n = 0, r;
  do { r = Chests.roll(wood, l, [], () => 0); l = Chests.applyRoll(l, wood, r).ledger; n++; } while (r.rarity < 3 && n < 200);
  ok(r.rarity === 3 && r.pity === 'epic' && n === T.PITY.epic, 'epic pity fires on chest #' + n + ' (expected ' + T.PITY.epic + ')');
  ok(l.sinceE === 0 && l.sinceL === T.PITY.epic, 'epic pity resets its counter only');
  const gold = T.CHEST_TIERS.gold; l = Chests.emptyLedger(); n = 0;
  do { r = Chests.roll(gold, l, [], () => 0.0001); l = Chests.applyRoll(l, gold, r).ledger; n++; } while (r.rarity < 4 && n < 200);
  ok(r.rarity === 4 && n <= Math.ceil(T.PITY.legendary / gold.pts), 'legendary pity fires by golden chest #' + n);
  // duplicates: owning everything but one common skin means we get that or a duplicate -> glitter, never a crash
  const common = T.SKINS.filter((s) => s.rarity === 0), all = common.map((s) => s.id);
  const d = Chests.roll(wood, Chests.emptyLedger(), all, () => 0.3);
  ok(d.dup && d.skin === null, 'a duplicate gives no skin');
  const g = Chests.applyRoll(Chests.emptyLedger(), wood, d);
  ok(g.gain === wood.glitter + T.GLITTER_DUP[0] && g.ledger.glitter === g.gain, 'duplicate pays glitter on top of the chest bonus');
  // focus makes the chosen character show up more
  const lf = Object.assign(Chests.emptyLedger(), { focus: 'frog' }); let hits = 0;
  for (let i = 0; i < 6000; i++) if (Chests.roll(wood, lf, [], rand).dupSkin.char === 'frog') hits++;
  ok(hits / 6000 > 0.17 && hits / 6000 < 0.23, 'focus lifts a character to ~' + ((hits / 60).toFixed(0)) + '% (4x weight of 18 = 18%->~' + (4 / 21 * 100).toFixed(0) + '%)');
}

async function suite(name, store) {
  console.log(name);
  let clock = 1e12; const ch = Chests.create(store, { now: () => clock });
  const u = await store.createUser('Cleo', 'h');
  let r = await ch.open(u, 'wood'); ok(!r.ok && /enough/i.test(r.err), 'cannot open a chest with 0 wins');
  r = await ch.open(u, 'nope'); ok(!r.ok, 'unknown chest rejected');
  for (let i = 0; i < 10; i++) await store.addWin(u.id);
  r = await ch.open(u, 'wood');
  ok(r.ok && r.user.wins - r.user.spent === 8, 'wooden chest costs 2 wins');
  ok(r.result.skin && T.parseSkin(r.result.skin) && r.result.glitter >= 4, 'result names a real skin and pays glitter: ' + r.result.skin + ' +' + r.result.glitter);
  ok(r.user.owned.includes(r.result.skin) || r.result.dup, 'the skin is in the inventory');
  ok((await ch.view(u.id)).glitter === r.result.glitter && (await ch.view(u.id)).opened === 1, 'ledger saved');
  // three clicks at once with only enough wins for four more wooden chests: all fine but never overspend
  const many = await Promise.all([1, 2, 3, 4, 5, 6].map(() => ch.open(u, 'wood')));
  const done = many.filter((x) => x.ok).length, bal = await store.userById(u.id);
  ok(done === 4 && bal.wins - bal.spent === 0, 'six simultaneous opens with 8 wins: exactly ' + done + ' succeed, balance ' + (bal.wins - bal.spent));
  ok((await ch.view(u.id)).opened === 5, 'ledger counted each chest once');
  // daily
  let d = await ch.daily(u); ok(d.ok && d.result.tier === 'wood' && d.chest.streak === 1, 'first daily chest is wooden, streak 1');
  d = await ch.daily(u); ok(!d.ok && /not ready/i.test(d.err), 'cannot claim twice in a row');
  clock += 21 * 3600e3; d = await ch.daily(u); ok(d.ok && d.chest.streak === 2, 'next day: streak 2');
  clock += 21 * 3600e3; d = await ch.daily(u); ok(d.ok && d.result.tier === 'silver' && d.chest.streak === 3, 'day 3 is a silver chest');
  clock += 100 * 3600e3; let v = await ch.view(u.id); ok(v.streak === 0 && v.dailyReady && v.dailyTier === 'wood', 'miss a few days: streak resets to a wooden chest');
  for (let i = 0; i < 7; i++) { d = await ch.daily(u); ok(d.ok, 'streak day ' + (i + 1) + ' tier ' + d.result.tier); clock += 21 * 3600e3; }
  ok(d.result.tier === 'gold' && d.chest.streak === 7, 'day 7 is golden');
  v = await ch.view(u.id); ok(v.dailyDay === 1, 'after day 7 the cycle starts again');
  // craft
  await ch.addGlitter(u.id, 1000);
  const owned = (await store.userById(u.id)).owned;
  const want = T.SKINS.find((s) => s.rarity === 1 && !owned.includes(s.id));
  const before = (await ch.view(u.id)).glitter;
  let c = await ch.craft(u, want.id);
  ok(c.ok && c.user.owned.includes(want.id) && c.chest.glitter === before - T.GLITTER_CRAFT[1], 'crafting an uncommon costs ' + T.GLITTER_CRAFT[1] + ' glitter');
  c = await ch.craft(u, want.id); ok(!c.ok && /already/i.test(c.err), 'cannot craft what you own');
  c = await ch.craft(u, 'skin:fox:nothing'); ok(!c.ok, 'cannot craft a made-up skin');
  const poor = await store.createUser('Poor', 'h'); c = await ch.craft(poor, T.SKINS[0].id); ok(!c.ok && /glitter/i.test(c.err), 'cannot craft without glitter');
  // focus
  let f = await ch.focus(u, 'frog'); ok(f.ok && f.chest.focus === 'frog', 'focus a character');
  f = await ch.focus(u, 'zzz'); ok(!f.ok, 'bad focus rejected'); f = await ch.focus(u, ''); ok(f.ok && f.chest.focus === '', 'clear focus');
  // validators
  ok(T.cleanSkin('lava') === 'lava' && T.cleanSkin('__proto__') === '' && T.cleanSkin(5) === '', 'cleanSkin only accepts real themes');
  ok(!T.parseSkin('constructor') && !T.parseSkin('skin:fox:nothing') && T.parseSkin('skin:fox:gold').name === 'Gold Fox', 'parseSkin');
}

(async () => {
  pure();
  const mem = newDb(); const { Pool } = mem.adapters.createPg();
  await suite('postgres (pg-mem)', await db.open({ pool: new Pool() }));
  await suite('file store', await db.open({ file: null }));
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
