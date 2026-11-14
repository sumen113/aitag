'use strict';
/* Chests: buy them with wins (or claim the free daily one), each holds one skin. Everything that matters
   (rolling, pity, glitter, paying) happens here on the server; the browser only shows the result.
   The player's chest state (glitter, pity counters, daily streak...) is the "ledger", saved in the kv table
   next to the inventory change in the same transaction (see db.applyChest). */
const crypto = require('crypto');
const T = require('../public/shared.js');

const emptyLedger = () => ({ glitter: 0, sinceE: 0, sinceL: 0, streak: 0, lastDaily: 0, focus: '', opened: 0, counts: [0, 0, 0, 0, 0], gifts: { wood: 0, silver: 0, gold: 0 } });
const normLedger = (l) => {
  const o = Object.assign(emptyLedger(), l && typeof l === 'object' ? l : {});
  if (!Array.isArray(o.counts) || o.counts.length !== 5) o.counts = [0, 0, 0, 0, 0];
  const g = o.gifts && typeof o.gifts === 'object' ? o.gifts : {};
  o.gifts = { wood: Math.max(0, g.wood | 0), silver: Math.max(0, g.silver | 0), gold: Math.max(0, g.gold | 0) };      // chests staff gave this player
  return o;
};

/** Uniform float in [0,1) from the OS random source. */
const rnd = () => crypto.randomInt(0, 2 ** 40) / 2 ** 40;

function weighted(weights, r) {
  let tot = 0; for (const w of weights) tot += w;
  let x = r * tot;
  for (let i = 0; i < weights.length; i++) { if (x < weights[i]) return i; x -= weights[i]; }
  return weights.length - 1;
}

const SKINS_BY_RARITY = [0, 1, 2, 3, 4].map((r) => T.SKINS.filter((s) => s.rarity === r));

/** Pure: decide what one chest holds. Returns { rarity, skin (record or null when it was a duplicate), dup, pity } and does not touch the ledger. */
function roll(tier, ledger, owned, rand = rnd) {
  const odds = tier.odds;
  let rarity, pity = '';
  if (ledger.sinceL + tier.pts >= T.PITY.legendary) { rarity = 4; pity = 'legendary'; }
  else if (ledger.sinceE + tier.pts >= T.PITY.epic) {
    const w = [odds[3] || 0, odds[4] || 0]; if (!w[0] && !w[1]) w[0] = 1;
    rarity = 3 + weighted(w, rand()); pity = 'epic';
  } else rarity = weighted(odds, rand());
  const pool = SKINS_BY_RARITY[rarity];
  const have = new Set(owned);
  const pick = () => {                                   // a character you pointed the chest at counts four times
    const w = pool.map((s) => (ledger.focus && s.char === ledger.focus ? 4 : 1));
    return pool[weighted(w, rand())];
  };
  let skin = pick();
  if (have.has(skin.id)) skin = pick();                  // one free re-roll against duplicates
  const dup = have.has(skin.id);
  return { rarity, skin: dup ? null : skin, dup, dupSkin: skin, pity };
}

/** Pure: the ledger after a chest. */
function applyRoll(ledger, tier, res) {
  const l = normLedger(ledger);
  l.opened += 1; l.counts[res.rarity] += 1;
  l.sinceE = res.rarity >= 3 ? 0 : l.sinceE + tier.pts;
  l.sinceL = res.rarity >= 4 ? 0 : l.sinceL + tier.pts;
  const gain = tier.glitter + (res.dup ? T.GLITTER_DUP[res.rarity] : 0);
  l.glitter += gain;
  return { ledger: l, gain };
}

function create(store, opts = {}) {
  const now = () => (opts.now ? opts.now() : Date.now());
  const locks = new Map();
  /** Run fn for one player at a time, so two quick clicks can never double-spend or double-roll. */
  function exclusive(id, fn) {
    const prev = locks.get(id) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    locks.set(id, tail);
    tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }
  const load = async (id) => normLedger(await store.kvGet('ledger:' + id));

  /** What the browser needs to draw the chest screen. */
  function view(l) {
    const t = now(), ready = !l.lastDaily || t - l.lastDaily >= T.DAILY.cooldownH * 3600e3;
    const kept = l.lastDaily && t - l.lastDaily <= T.DAILY.graceH * 3600e3;
    const next = ((kept ? l.streak : 0) % T.DAILY.tiers.length) + 1;
    return {
      glitter: l.glitter, sinceE: l.sinceE, sinceL: l.sinceL, pityE: T.PITY.epic, pityL: T.PITY.legendary, focus: l.focus,
      opened: l.opened, counts: l.counts, gifts: l.gifts, streak: kept ? l.streak : 0,
      dailyReady: ready, nextDaily: ready ? 0 : l.lastDaily + T.DAILY.cooldownH * 3600e3, dailyTier: T.dailyTier(next), dailyDay: next,
    };
  }
  const ledgerView = async (id) => view(await load(id));

  async function finish(user, tier, price, l0, res, extra) {
    const { ledger, gain } = applyRoll(l0, tier, res);
    Object.assign(ledger, extra || {});
    const r = await store.applyChest(user.id, { price, item: res.skin ? res.skin.id : null, ledger });
    if (!r.ok) return r;
    return {
      ok: true, user: r.user, chest: view(ledger),
      result: { tier: tier.id, rarity: res.rarity, skin: res.skin ? res.skin.id : res.dupSkin.id, dup: res.dup, glitter: gain, pity: res.pity },
    };
  }

  return {
    view: ledgerView,
    /** Buy and open a chest with wins (or open one staff gave you, when gift is true). */
    open: (user, tierId, gift) => exclusive(user.id, async () => {
      const tier = Object.prototype.hasOwnProperty.call(T.CHEST_TIERS, tierId) ? T.CHEST_TIERS[tierId] : null;
      if (!tier) return { ok: false, err: 'Unknown chest.' };
      const u = await store.userById(user.id);
      if (!u) return { ok: false, err: 'Account not found.' };
      const l = await load(u.id);
      if (gift) {
        if (l.gifts[tier.id] < 1) return { ok: false, err: 'You have no gifted chest of that kind.' };
        const gifts = Object.assign({}, l.gifts, { [tier.id]: l.gifts[tier.id] - 1 });
        return finish(u, tier, 0, l, roll(tier, l, u.owned), { gifts });
      }
      if (u.wins - u.spent < tier.price) return { ok: false, err: 'Not enough wins yet.' };
      return finish(u, tier, tier.price, l, roll(tier, l, u.owned));
    }),
    /** Claim the free daily chest (its tier grows with your streak). */
    daily: (user) => exclusive(user.id, async () => {
      const u = await store.userById(user.id);
      if (!u) return { ok: false, err: 'Account not found.' };
      const l = await load(u.id), v = view(l);
      if (!v.dailyReady) return { ok: false, err: 'Your daily chest is not ready yet.', chest: v };
      const tier = T.CHEST_TIERS[v.dailyTier];
      return finish(u, tier, 0, l, roll(tier, l, u.owned), { lastDaily: now(), streak: v.dailyDay });
    }),
    /** Spend glitter to make one exact skin. */
    craft: (user, skinId) => exclusive(user.id, async () => {
      const sk = T.parseSkin(skinId);
      if (!sk) return { ok: false, err: 'Unknown skin.' };
      const u = await store.userById(user.id);
      if (!u) return { ok: false, err: 'Account not found.' };
      if (u.owned.includes(sk.id)) return { ok: false, err: 'You already own that skin.' };
      const l = await load(u.id), cost = T.GLITTER_CRAFT[sk.rarity];
      if (l.glitter < cost) return { ok: false, err: 'Not enough glitter.' };
      l.glitter -= cost;
      const r = await store.applyChest(u.id, { price: 0, item: sk.id, ledger: l });
      if (!r.ok) return r;
      return { ok: true, user: r.user, chest: view(l), crafted: sk.id, cost };
    }),
    /** Point your chests at one character (or clear it with ''). */
    focus: (user, charId) => exclusive(user.id, async () => {
      const ok = charId === '' || T.CHARS.some((c) => c.id === charId);
      if (!ok) return { ok: false, err: 'Unknown character.' };
      const l = await load(user.id); l.focus = charId;
      await store.kvSet('ledger:' + user.id, l);
      return { ok: true, chest: view(l) };
    }),
    /** Staff: give (or take back) chests the player can open for free. Returns the new counts. */
    addGift: (id, tierId, n) => exclusive(id, async () => {
      const l = await load(id); l.gifts[tierId] = Math.max(0, Math.min(999, l.gifts[tierId] + (n | 0)));
      await store.kvSet('ledger:' + id, l);
      return l.gifts;
    }),
    /** Staff: give glitter (or take it back with a negative number). */
    addGlitter: (id, n) => exclusive(id, async () => {
      const l = await load(id); l.glitter = Math.max(0, l.glitter + (n | 0));
      await store.kvSet('ledger:' + id, l);
      return l.glitter;
    }),
  };
}

module.exports = { create, roll, applyRoll, emptyLedger, normLedger };
