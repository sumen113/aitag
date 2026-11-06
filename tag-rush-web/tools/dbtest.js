'use strict';
/* Runs the Postgres code path against an in-memory Postgres (pg-mem) and the file store, same assertions for both. */
const { newDb } = require('pg-mem');
const db = require('../src/db');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } else console.log('  ok  :', m); };

async function suite(name, store) {
  console.log(name);
  const u = await store.createUser('Alex', 'h1');
  ok(u && u.username === 'Alex' && u.wins === 0 && u.owned.includes('char:fox'), 'create user gets the starter characters');
  ok((await store.createUser('ALEX', 'h2')) === null, 'duplicate username (any case) rejected');
  ok(await store.nameTaken('aLeX'), 'nameTaken is case-insensitive');
  ok((await store.userByName('alex')).id === u.id, 'lookup by name, any case');
  await store.addWin(u.id); await store.addWin(u.id); await store.addWin(u.id);
  ok((await store.userById(u.id)).wins === 3, 'wins accumulate');
  let r = await store.buy(u.id, 'char:frog', 3);
  ok(r.ok && r.user.owned.includes('char:frog') && r.user.wins - r.user.spent === 0, 'buy frog for 3 wins -> balance 0');
  r = await store.buy(u.id, 'char:frog', 3); ok(!r.ok && /already/i.test(r.err), 'cannot buy twice');
  r = await store.buy(u.id, 'char:cat', 3); ok(!r.ok && /enough/i.test(r.err), 'cannot buy without enough wins');
  const after = await store.userById(u.id); ok(after.spent === 3, 'failed buys do not charge');
  await store.addWin(u.id); await store.addWin(u.id); await store.addWin(u.id);
  const results = await Promise.all([store.buy(u.id, 'char:cat', 3), store.buy(u.id, 'char:cat', 3), store.buy(u.id, 'char:cat', 3)]);
  ok(results.filter((x) => x.ok).length === 1, 'three simultaneous buys of one item: exactly one succeeds');
  const fin = await store.userById(u.id); ok(fin.spent === 6, 'and only charged once (spent=' + fin.spent + ')');
  await store.saveSettings(u.id, { c: 'frog', k: 2 });
  ok((await store.userById(u.id)).settings.c === 'frog', 'settings persist');
  await store.createSession(u.id, 'tok1', Date.now() + 60000);
  ok((await store.session('tok1')).userId === u.id, 'session lookup');
  await store.createSession(u.id, 'tok2', Date.now() - 1);
  ok((await store.session('tok2')) === null, 'expired session is rejected');
  await store.dropSession('tok1'); ok((await store.session('tok1')) === null, 'logout drops session');
}

(async () => {
  const mem = newDb(); const { Pool } = mem.adapters.createPg();
  const pg = await db.open({ pool: new Pool() });
  await suite('postgres (pg-mem)', pg);
  await suite('file store', await db.open({ file: null }));
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
