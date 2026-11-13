'use strict';
/* Accounts over plain HTTP + a session cookie. Passwords are hashed with scrypt (built into Node), sessions are
   random 256-bit tokens stored hashed, the cookie is HttpOnly + SameSite=Lax (+ Secure on https), and every
   POST must be same-origin JSON, so other websites can't make a visitor's browser act on their account. */
const crypto = require('crypto');
const T = require('../public/shared.js');
const Chests = require('./chests.js');

const COOKIE = 'tr_sess';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ------------------------------ passwords ------------------------------ */
const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };
function scrypt(pw, salt) {
  return new Promise((res, rej) => crypto.scrypt(pw, salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (e, k) => (e ? rej(e) : res(k))));
}
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${(await scrypt(pw, salt)).toString('base64')}`;
}
async function verifyPassword(pw, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[4], 'base64'), want = Buffer.from(parts[5], 'base64');
  const got = await scrypt(pw, salt);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const DUMMY = hashPassword('not-a-real-password');           // burns the same time for unknown usernames

/* ------------------------------ rate limits ------------------------------ */
class Limiter {
  constructor(max, windowMs) { this.max = max; this.win = windowMs; this.m = new Map(); }
  /** Returns true if the action is allowed (and records it). */
  hit(key) {
    const now = Date.now(), arr = (this.m.get(key) || []).filter((t) => now - t < this.win);
    if (arr.length >= this.max) { this.m.set(key, arr); return false; }
    arr.push(now); this.m.set(key, arr); return true;
  }
  sweep() { const now = Date.now(); for (const [k, v] of this.m) if (!v.some((t) => now - t < this.win)) this.m.delete(k); }
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || (req.socket && req.socket.remoteAddress) || '?';
}
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || !!(req.socket && req.socket.encrypted);

function publicUser(u) {
  return u && { username: u.username, wins: u.wins, spent: u.spent, balance: u.wins - u.spent, owned: u.owned, settings: u.settings || {} };
}

function create(store, opts = {}) {
  const pu = (u) => { const o = publicUser(u); if (o && opts.isAdmin) o.admin = !!opts.isAdmin(u.username); return o; };
  const chests = Chests.create(store, { now: opts.now });
  /** The account as the browser sees it, with the chest ledger (glitter, pity, daily) attached. */
  const puFull = async (u) => { const o = pu(u); if (o) o.chest = await chests.view(u.id); return o; };
  const lim = {
    register: new Limiter(opts.registerPerHour || 6, 3600e3),
    loginIp: new Limiter(opts.loginPerIp || 25, 600e3),
    loginUser: new Limiter(opts.loginPerUser || 8, 600e3),
    buy: new Limiter(30, 60e3),
    chest: new Limiter(40, 60e3),
  };
  const sweeper = setInterval(() => { for (const l of Object.values(lim)) l.sweep(); store.dropExpired().catch(() => {}); }, 600e3);
  sweeper.unref();

  const json = (res, code, obj, headers) => {
    res.writeHead(code, Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, headers));
    res.end(JSON.stringify(obj));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 2048) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
  const sameOrigin = (req) => {
    const o = req.headers.origin; if (!o) return true;           // non-browser clients (tests, curl) send none
    try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
  };

  async function userFromCookie(cookieHeader) {
    const tok = parseCookies(cookieHeader)[COOKIE];
    if (!tok || tok.length > 100) return null;
    const s = await store.session(sha(tok));
    const u = s ? await store.userById(s.userId) : null;
    return u && !(opts.isBanned && opts.isBanned(u.username)) ? u : null;       // suspended accounts act as logged out
  }
  async function startSession(req, res, user) {
    const token = crypto.randomBytes(32).toString('base64url');
    await store.createSession(user.id, sha(token), Date.now() + SESSION_MS);
    return { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}` };
  }

  /** Returns true if it handled the request. */
  async function handle(req, res, url) {
    if (!url.startsWith('/api/') || url === '/api/stats') return false;
    try {
      if (req.method === 'GET' && url === '/api/me') {
        const u = await userFromCookie(req.headers.cookie);
        return json(res, 200, { accounts: true, user: await puFull(u), shop: T.SHOP }), true;
      }
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found' }), true;
      if (!sameOrigin(req) || !/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 403, { error: 'Forbidden' }), true;
      const body = await readBody(req).catch(() => null);
      if (!body || typeof body !== 'object') return json(res, 400, { error: 'Bad request' }), true;
      const ip = clientIp(req);

      if (url === '/api/register') {
        if (!lim.register.hit(ip)) return json(res, 429, { error: 'Too many sign-ups from here. Try again later.' }), true;
        const v = T.validateUsername(body.username); if (!v.ok) return json(res, 400, { error: v.err }), true;
        const pv = T.validatePassword(body.password); if (!pv.ok) return json(res, 400, { error: pv.err }), true;
        const user = await store.createUser(v.name, await hashPassword(String(body.password)));
        if (!user) return json(res, 409, { error: 'That username is taken.' }), true;
        const h = await startSession(req, res, user);
        return json(res, 200, { ok: true, user: await puFull(user) }, h), true;
      }

      if (url === '/api/login') {
        const name = String(body.username || '').trim().slice(0, 40), pw = String(body.password || '').slice(0, 200);
        if (!lim.loginIp.hit(ip) || !lim.loginUser.hit(name.toLowerCase())) return json(res, 429, { error: 'Too many attempts. Wait a few minutes.' }), true;
        const user = await store.userByName(name);
        const ok = user ? await verifyPassword(pw, user.hash) : (await verifyPassword(pw, await DUMMY), false);
        if (!ok) return json(res, 401, { error: 'Wrong username or password.' }), true;
        const why = opts.isBanned && opts.isBanned(user.username);
        if (why) return json(res, 403, { error: `This account is suspended: ${why}` }), true;
        const h = await startSession(req, res, user);
        return json(res, 200, { ok: true, user: await puFull(user) }, h), true;
      }

      if (url === '/api/logout') {
        const tok = parseCookies(req.headers.cookie)[COOKIE];
        if (tok) await store.dropSession(sha(tok));
        return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` }), true;
      }

      if (url === '/api/shop/buy') {
        const user = await userFromCookie(req.headers.cookie);
        if (!user) return json(res, 401, { error: 'Log in to buy things.' }), true;
        if (!lim.buy.hit('u' + user.id)) return json(res, 429, { error: 'Slow down a little.' }), true;
        const item = T.SHOP_BY_ID[String(body.item)];
        if (!item) return json(res, 400, { error: 'Unknown item.' }), true;
        const r = await store.buy(user.id, item.id, item.price);
        if (!r.ok) return json(res, 400, { error: r.err, user: await puFull(await store.userById(user.id)) }), true;
        return json(res, 200, { ok: true, user: await puFull(r.user), bought: item.id }), true;
      }

      if (url.startsWith('/api/chest/')) {
        const user = await userFromCookie(req.headers.cookie);
        if (!user) return json(res, 401, { error: 'Log in to open chests.' }), true;
        if (!lim.chest.hit('u' + user.id)) return json(res, 429, { error: 'Slow down a little.' }), true;
        const act = url.slice('/api/chest/'.length);
        let r;
        if (act === 'open') r = await chests.open(user, String(body.tier));
        else if (act === 'daily') r = await chests.daily(user);
        else if (act === 'craft') r = await chests.craft(user, String(body.skin));
        else if (act === 'focus') r = await chests.focus(user, String(body.char || ''));
        else return json(res, 404, { error: 'Not found' }), true;
        const fresh = await puFull(await store.userById(user.id));
        if (!r.ok) return json(res, 400, { error: r.err, user: fresh }), true;
        return json(res, 200, Object.assign({}, r, { user: fresh })), true;
      }
      return json(res, 404, { error: 'Not found' }), true;
    } catch (e) {
      console.error('auth error:', e);
      return json(res, 500, { error: 'Something went wrong. Please try again.' }), true;
    }
  }

  return { handle, userFromCookie, publicUser: pu, chests };
}

module.exports = { create, hashPassword, verifyPassword, publicUser };
