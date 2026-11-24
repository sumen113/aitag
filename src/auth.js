'use strict';
/* Accounts over plain HTTP + a session cookie. Passwords are hashed with scrypt (built into Node), sessions are
   random 256-bit tokens stored hashed, the cookie is HttpOnly + SameSite=None; Secure; Partitioned on https so it works inside an iframe (SameSite=Lax on plain http), and every
   POST must be same-origin JSON, so other websites can't make a visitor's browser act on their account. */
const crypto = require('crypto');
const T = require('../public/shared.js');
const Mail = require('./mail');
const Chests = require('./chests.js');

const COOKIE = 'tr_sess';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const RESET_MS = 15 * 60e3, RESET_TRIES = 5, RESET_GAP = 60e3;       // emailed recovery code: lives 15 min, 5 wrong guesses kill it, one email a minute per account
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
/** On https the session cookie must also work when the game is embedded in another site (an iframe, e.g. a school's Google Site): SameSite=None + Secure, and Partitioned (CHIPS) so browsers that block third-party cookies still keep it, per embedding site. Plain http (local dev) stays Lax. Cross-site requests are still refused by the Origin check on every POST. */
const cookieKind = (req) => (isHttps(req) ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax');

function publicUser(u) {
  return u && { username: u.username, wins: u.wins, spent: u.spent, balance: u.wins - u.spent, owned: u.owned, settings: u.settings || {} };
}

function create(store, opts = {}) {
  const pu = (u) => { const o = publicUser(u); if (o && opts.isAdmin) o.admin = !!opts.isAdmin(u.username); return o; };
  const chests = Chests.create(store, { now: opts.now });
  /** The account as the browser sees it, with the chest ledger (glitter, pity, daily) attached. */
  const puFull = async (u) => { const o = pu(u); if (o) { o.chest = await chests.view(u.id); o.email = u.email || ''; o.needsEmail = !u.email; } return o; };
  const lim = {
    register: new Limiter(opts.registerPerHour || 6, 3600e3),
    loginIp: new Limiter(opts.loginPerIp || 25, 600e3),
    loginUser: new Limiter(opts.loginPerUser || 8, 600e3),
    buy: new Limiter(30, 60e3),
    chest: new Limiter(40, 60e3),
    email: new Limiter(10, 600e3),
    recIp: new Limiter(opts.recoverPerIp || 8, 1800e3),        // asking for codes: per visitor,
    recWho: new Limiter(opts.recoverPerWho || 3, 3600e3),       // per account / address (so nobody can flood one inbox)
    recFin: new Limiter(opts.recoverTries || 12, 600e3),       // trying codes: per visitor (each code also dies after 5 wrong tries)
  };
  const mailer = opts.mailer === undefined ? Mail.fromEnv() : opts.mailer;      // null = email recovery switched off
  const now = opts.now || Date.now;
  const codeHash = (code, salt) => crypto.createHash('sha256').update(salt + ':' + code).digest('hex');
  /** A fresh 6-digit code for the account, or null if one was sent in the last minute. Only a salted hash is stored. */
  async function issueCode(user) {
    const key = 'reset:' + user.id, cur = await store.kvGet(key);
    if (cur && cur.at && now() - cur.at < RESET_GAP) return null;
    const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'), salt = crypto.randomBytes(8).toString('hex');
    await store.kvSet(key, { h: codeHash(code, salt), s: salt, exp: now() + RESET_MS, tries: 0, at: now() });
    return code;
  }
  /** Runs after the answer is already sent, so how long it takes never reveals whether an account matched. */
  async function sendRecovery(who) {
    let users = [], to = '';
    if (who.includes('@')) { const ev = T.validateEmail(who); if (ev.ok) { to = ev.email; users = await store.usersByEmail(ev.email); } }
    else { const u = await store.userByName(who); if (u && u.email) { users = [u]; to = u.email; } }
    const list = [];
    for (const u of users) { if (opts.isBanned && opts.isBanned(u.username)) continue; const code = await issueCode(u); if (code) list.push({ username: u.username, code }); }
    if (list.length) await mailer.send(Object.assign({ to }, Mail.recoveryEmail(list, RESET_MS / 60e3)));
  }
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
    return { 'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; Max-Age=${SESSION_MS / 1000}; ${cookieKind(req)}` };
  }

  /** Returns true if it handled the request. */
  async function handle(req, res, url) {
    if (!url.startsWith('/api/') || url === '/api/stats') return false;
    try {
      if (req.method === 'GET' && url === '/api/me') {
        const u = await userFromCookie(req.headers.cookie);
        return json(res, 200, { accounts: true, user: await puFull(u), shop: T.SHOP, recovery: !!mailer }), true;
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
        const ev = T.validateEmail(body.email); if (!ev.ok) return json(res, 400, { error: ev.err }), true;
        const user = await store.createUser(v.name, await hashPassword(String(body.password)), ev.email);
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

      if (url === '/api/recover/start') {                     // "forgot password": email a one-time code. Same answer whether or not an account matches.
        if (!mailer) return json(res, 503, { error: 'Email recovery is not set up on this server yet.' }), true;
        const who = String(body.who || '').trim().toLowerCase().slice(0, 120);
        if (!who) return json(res, 400, { error: 'Enter your username or the email on your account.' }), true;
        if (!lim.recIp.hit(ip) || !lim.recWho.hit(who)) return json(res, 429, { error: 'Too many requests. Try again in a little while.' }), true;
        json(res, 200, { ok: true, minutes: RESET_MS / 60e3 });
        sendRecovery(who).catch((e) => console.error('recovery email failed:', e && e.message));
        return true;
      }

      if (url === '/api/recover/finish') {                    // username + emailed code + new password: sets it, signs everything else out, logs you in
        if (!mailer) return json(res, 503, { error: 'Email recovery is not set up on this server yet.' }), true;
        if (!lim.recFin.hit(ip)) return json(res, 429, { error: 'Too many attempts. Wait a few minutes.' }), true;
        const name = String(body.username || '').trim().slice(0, 40), code = String(body.code || '').replace(/\s/g, '').slice(0, 12), pw = String(body.password || '');
        const pv = T.validatePassword(pw); if (!pv.ok) return json(res, 400, { error: pv.err }), true;          // checked first, so a typo here never burns a guess
        const BAD = 'That code is wrong or has expired. Ask for a new one.', user = name ? await store.userByName(name) : null, key = user && 'reset:' + user.id;
        const rec = user && await store.kvGet(key);
        if (!rec || !rec.h || rec.exp < now()) return json(res, 400, { error: BAD }), true;
        const a = Buffer.from(codeHash(code, rec.s), 'hex'), b = Buffer.from(rec.h, 'hex');
        if (!(a.length === b.length && crypto.timingSafeEqual(a, b))) {
          rec.tries = (rec.tries || 0) + 1; await store.kvSet(key, rec.tries >= RESET_TRIES ? null : rec);
          return json(res, 400, { error: BAD }), true;
        }
        const why = opts.isBanned && opts.isBanned(user.username);
        if (why) return json(res, 403, { error: `This account is suspended: ${why}` }), true;
        await store.setPassword(user.id, await hashPassword(pw)); await store.kvSet(key, null);               // setPassword also ends every old session
        const h = await startSession(req, res, user);
        if (user.email) mailer.send(Object.assign({ to: user.email }, Mail.changedEmail(user.username))).catch((e) => console.error('notice email failed:', e && e.message));
        return json(res, 200, { ok: true, user: await puFull(await store.userById(user.id)) }, h), true;
      }

      if (url === '/api/logout') {
        const tok = parseCookies(req.headers.cookie)[COOKIE];
        if (tok) await store.dropSession(sha(tok));
        return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; ${cookieKind(req)}` }), true;
      }

      if (url === '/api/email') {
        const user = await userFromCookie(req.headers.cookie);
        if (!user) return json(res, 401, { error: 'Log in first.' }), true;
        if (!lim.email.hit('u' + user.id)) return json(res, 429, { error: 'Slow down a little.' }), true;
        const ev = T.validateEmail(body.email); if (!ev.ok) return json(res, 400, { error: ev.err }), true;
        const fresh = await store.setEmail(user.id, ev.email);
        return json(res, 200, { ok: true, user: await puFull(fresh) }), true;
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
        if (act === 'open') r = await chests.open(user, String(body.tier), !!body.gift);
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
