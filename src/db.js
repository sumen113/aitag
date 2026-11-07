'use strict';
/* Persistence for accounts. Two interchangeable backends behind one async API:
     - Postgres (set DATABASE_URL)  -> what you use in production (Neon, Supabase, Render Postgres, ...)
     - JSON file (no DATABASE_URL)  -> local development only; Render's disk is wiped on every deploy.
   Also a small key/value table (kv) for admin state: bans, mutes, banner.
   User shape returned everywhere: { id, username, hash, wins, spent, owned: [itemId], settings: {}, created }
   Spendable balance = wins - spent. Inventory rows are generic item ids ('char:frog', later 'trail:rainbow', ...). */
const fs = require('fs');
const path = require('path');
const T = require('../public/shared.js');

const lower = (s) => String(s).toLowerCase();
const withStarters = (owned) => [...new Set([...T.STARTER_ITEMS, ...owned])];

/* =============================== Postgres =============================== */
async function openPg(url, opts = {}) {
  const pool = opts.pool || (() => {
    const { Pool } = require('pg');
    const u = new URL(url);
    const local = ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
    u.searchParams.delete('sslmode'); u.searchParams.delete('channel_binding');
    const ssl = local || process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: process.env.PGSSL_STRICT === '1' };
    return new Pool({ connectionString: u.toString(), ssl, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
  })();
  pool.on && pool.on('error', (e) => console.error('pg pool error:', e.message));

  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    wins INTEGER NOT NULL DEFAULT 0,
    spent INTEGER NOT NULL DEFAULT 0,
    settings TEXT NOT NULL DEFAULT '{}',
    created_at BIGINT NOT NULL,
    last_seen BIGINT NOT NULL DEFAULT 0
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS inventory (
    user_id INTEGER NOT NULL,
    item_id TEXT NOT NULL,
    acquired_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, item_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at BIGINT NOT NULL
  )`);

  await pool.query(`CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  )`);

  const toUser = async (row) => {
    if (!row) return null;
    const inv = await pool.query('SELECT item_id FROM inventory WHERE user_id = $1', [row.id]);
    let settings = {}; try { settings = JSON.parse(row.settings || '{}'); } catch (e) { /* corrupt settings: ignore */ }
    return { id: +row.id, username: row.username, hash: row.pass_hash, wins: +row.wins, spent: +row.spent, owned: withStarters(inv.rows.map((r) => r.item_id)), settings, created: +row.created_at };
  };

  return {
    kind: 'postgres',
    async createUser(username, hash) {
      let r;
      try { r = await pool.query('INSERT INTO users (username, username_lower, pass_hash, created_at) VALUES ($1, $2, $3, $4) RETURNING id', [username, lower(username), hash, Date.now()]); }
      catch (e) { if (e.code === '23505' || /duplicate|unique/i.test(e.message)) return null; throw e; }   // username taken
      return this.userById(r.rows[0].id);
    },
    async userByName(name) { return toUser((await pool.query('SELECT * FROM users WHERE username_lower = $1', [lower(name)])).rows[0]); },
    async userById(id) { return toUser((await pool.query('SELECT * FROM users WHERE id = $1', [id])).rows[0]); },
    async nameTaken(name) { return (await pool.query('SELECT 1 AS x FROM users WHERE username_lower = $1', [lower(name)])).rows.length > 0; },
    async addWin(id) { await pool.query('UPDATE users SET wins = wins + 1 WHERE id = $1', [id]); return this.userById(id); },
    async saveSettings(id, settings) { await pool.query('UPDATE users SET settings = $2 WHERE id = $1', [id, JSON.stringify(settings)]); },
    async touch(id) { await pool.query('UPDATE users SET last_seen = $2 WHERE id = $1', [id, Date.now()]); },
    /** Atomic: charge the price and grant the item in one transaction, or do neither. */
    async buy(id, item, price) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const own = await c.query('SELECT 1 AS x FROM inventory WHERE user_id = $1 AND item_id = $2', [id, item]);
        if (own.rows.length) { await c.query('ROLLBACK'); return { ok: false, err: 'You already own that.' }; }
        const r = await c.query('UPDATE users SET spent = spent + $2 WHERE id = $1 AND wins - spent >= $2', [id, price]);
        if (!r.rowCount) { await c.query('ROLLBACK'); return { ok: false, err: 'Not enough wins yet.' }; }
        await c.query('INSERT INTO inventory (user_id, item_id, acquired_at) VALUES ($1, $2, $3)', [id, item, Date.now()]);
        await c.query('COMMIT');
      } catch (e) {
        try { await c.query('ROLLBACK'); } catch (x) { /* already closed */ }
        if (/duplicate|unique/i.test(e.message)) return { ok: false, err: 'You already own that.' };
        throw e;
      } finally { c.release(); }
      return { ok: true, user: await this.userById(id) };
    },
    /* ---- admin / extras ---- */
    async kvGet(k) { const r = (await pool.query('SELECT v FROM kv WHERE k = $1', [k])).rows[0]; if (!r) return null; try { return JSON.parse(r.v); } catch (e) { return null; } },
    async kvSet(k, val) {
      const v = JSON.stringify(val);
      const u = await pool.query('UPDATE kv SET v = $2 WHERE k = $1', [k, v]);
      if (!u.rowCount) { try { await pool.query('INSERT INTO kv (k, v) VALUES ($1, $2)', [k, v]); } catch (e) { await pool.query('UPDATE kv SET v = $2 WHERE k = $1', [k, v]); } }
    },
    async countUsers() { return +(await pool.query('SELECT COUNT(*) AS n FROM users')).rows[0].n; },
    async listUsers(q, limit = 20) {
      const like = String(q || '').toLowerCase().replace(/[^a-z0-9]/g, '') + '%';
      const rows = (await pool.query('SELECT * FROM users WHERE username_lower LIKE $1 ORDER BY id DESC LIMIT $2', [like, limit])).rows;
      return Promise.all(rows.map(toUser));
    },
    async topWins(n = 10) {
      return (await pool.query('SELECT username, wins FROM users WHERE wins > 0 ORDER BY wins DESC, id ASC LIMIT $1', [n])).rows.map((r) => ({ username: r.username, wins: +r.wins }));
    },
    /** Admin gift/removal. Never takes the balance below zero (wins can't drop under what was already spent). */
    async adjustWins(id, delta) {
      await pool.query('UPDATE users SET wins = CASE WHEN wins + $2 < spent THEN spent ELSE wins + $2 END WHERE id = $1', [id, delta]);
      return this.userById(id);
    },
    async grantItem(id, item) {
      try { await pool.query('INSERT INTO inventory (user_id, item_id, acquired_at) VALUES ($1, $2, $3)', [id, item, Date.now()]); } catch (e) { if (!/duplicate|unique/i.test(e.message)) throw e; }
      return this.userById(id);
    },
    async revokeItem(id, item) { await pool.query('DELETE FROM inventory WHERE user_id = $1 AND item_id = $2', [id, item]); return this.userById(id); },
    async setPassword(id, hash) { await pool.query('UPDATE users SET pass_hash = $2 WHERE id = $1', [id, hash]); await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]); },
    async dropUserSessions(id) { await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]); },
    async createSession(userId, tokenHash, expires) { await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expires]); },
    async session(tokenHash) {
      const r = (await pool.query('SELECT user_id, expires_at FROM sessions WHERE token_hash = $1', [tokenHash])).rows[0];
      if (!r) return null;
      if (+r.expires_at < Date.now()) { await this.dropSession(tokenHash); return null; }
      return { userId: +r.user_id, expires: +r.expires_at };
    },
    async dropSession(tokenHash) { await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]); },
    async dropExpired() { await pool.query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]); },
    async close() { if (pool.end) await pool.end(); },
  };
}

/* ============================ JSON file (dev only) ============================ */
async function openFile(file) {
  let db = { nextId: 1, users: {}, sessions: {}, kv: {} };
  try { db = Object.assign(db, JSON.parse(fs.readFileSync(file, 'utf8'))); db.kv = db.kv || {}; } catch (e) { /* first run */ }
  let timer = null;
  const save = () => {
    if (timer || !file) return;
    timer = setTimeout(() => {
      timer = null;
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file + '.tmp', JSON.stringify(db)); fs.renameSync(file + '.tmp', file); } catch (e) { console.error('could not save dev db:', e.message); }
    }, 150);
  };
  const view = (u) => u && { id: u.id, username: u.username, hash: u.hash, wins: u.wins, spent: u.spent, owned: withStarters(u.owned), settings: Object.assign({}, u.settings), created: u.created };
  const byName = (n) => Object.values(db.users).find((u) => lower(u.username) === lower(n));

  return {
    kind: 'file',
    async createUser(username, hash) {
      if (byName(username)) return null;
      const u = { id: db.nextId++, username, hash, wins: 0, spent: 0, owned: [], settings: {}, created: Date.now() };
      db.users[u.id] = u; save(); return view(u);
    },
    async userByName(n) { return view(byName(n)); },
    async userById(id) { return view(db.users[id]); },
    async nameTaken(n) { return !!byName(n); },
    async addWin(id) { const u = db.users[id]; if (!u) return null; u.wins++; save(); return view(u); },
    async saveSettings(id, s) { if (db.users[id]) { db.users[id].settings = s; save(); } },
    async touch() {},
    async buy(id, item, price) {
      const u = db.users[id]; if (!u) return { ok: false, err: 'Account not found.' };
      if (withStarters(u.owned).includes(item)) return { ok: false, err: 'You already own that.' };
      if (u.wins - u.spent < price) return { ok: false, err: 'Not enough wins yet.' };
      u.spent += price; u.owned.push(item); save();
      return { ok: true, user: view(u) };
    },
    async kvGet(k) { return db.kv[k] === undefined ? null : JSON.parse(JSON.stringify(db.kv[k])); },
    async kvSet(k, v) { db.kv[k] = JSON.parse(JSON.stringify(v)); save(); },
    async countUsers() { return Object.keys(db.users).length; },
    async listUsers(q, limit = 20) {
      const pre = String(q || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return Object.values(db.users).filter((u) => lower(u.username).startsWith(pre)).sort((a, b) => b.id - a.id).slice(0, limit).map(view);
    },
    async topWins(n = 10) { return Object.values(db.users).filter((u) => u.wins > 0).sort((a, b) => b.wins - a.wins || a.id - b.id).slice(0, n).map((u) => ({ username: u.username, wins: u.wins })); },
    async adjustWins(id, delta) { const u = db.users[id]; if (!u) return null; u.wins = Math.max(u.spent, u.wins + delta); save(); return view(u); },
    async grantItem(id, item) { const u = db.users[id]; if (!u) return null; if (!withStarters(u.owned).includes(item)) { u.owned.push(item); save(); } return view(u); },
    async revokeItem(id, item) { const u = db.users[id]; if (!u) return null; u.owned = u.owned.filter((x) => x !== item); save(); return view(u); },
    async setPassword(id, hash) { const u = db.users[id]; if (!u) return; u.hash = hash; for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === id) delete db.sessions[k]; save(); },
    async dropUserSessions(id) { for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === id) delete db.sessions[k]; save(); },
    async createSession(userId, tokenHash, expires) { db.sessions[tokenHash] = { userId, expires }; save(); },
    async session(tokenHash) {
      const s = db.sessions[tokenHash]; if (!s) return null;
      if (s.expires < Date.now()) { delete db.sessions[tokenHash]; save(); return null; }
      return s;
    },
    async dropSession(tokenHash) { delete db.sessions[tokenHash]; save(); },
    async dropExpired() { const now = Date.now(); for (const k of Object.keys(db.sessions)) if (db.sessions[k].expires < now) delete db.sessions[k]; save(); },
    async close() { if (timer) { clearTimeout(timer); timer = null; try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(db)); } catch (e) { /* noop */ } } },
  };
}

/** Open the right backend. opts.pool lets tests hand in an in-memory Postgres. */
async function open(opts = {}) {
  const url = opts.url !== undefined ? opts.url : process.env.DATABASE_URL;
  if (opts.pool || url) return openPg(url, opts);
  const file = opts.file !== undefined ? opts.file : path.join(__dirname, '..', 'data', 'dev-db.json');
  return openFile(file);
}

module.exports = { open };
