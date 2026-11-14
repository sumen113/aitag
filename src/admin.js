'use strict';
/* Admin tools: moderation (kick / mute / ban), account fixes (wins, items, password reset), broadcast messages and a
   site-wide banner. Served as JSON under /api/admin/* and used by /admin.

   WHO IS AN ADMIN
     Put the usernames below (case-insensitive) and/or in the ADMIN_USERS env var ("alice,bob").
     Register those accounts yourself FIRST, before you share the website link, so nobody else can take the names.
   SECOND LOCK
     Every admin request must also carry the ADMIN_PASSCODE env var (typed once into the panel). Without ADMIN_PASSCODE
     the panel refuses to work, so a stolen or guessed admin password alone is not enough. */
const crypto = require('crypto');
const T = require('../public/shared.js');
const { hashPassword } = require('./auth');

const ADMIN_USERNAMES = [
  // 'YourName',
  // 'FriendName',
];

const KEY = 'admin-state';
const lower = (s) => String(s || '').toLowerCase();
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function create({ store, rooms, activeUsers, wss, opts = {} }) {
  const admins = new Set([...ADMIN_USERNAMES, ...String(opts.admins !== undefined ? opts.admins : process.env.ADMIN_USERS || '').split(',')].map((s) => lower(s.trim())).filter(Boolean));
  const passcode = String(opts.passcode !== undefined ? opts.passcode : process.env.ADMIN_PASSCODE || '');
  if (admins.size && !passcode) console.warn('ADMIN_USERS is set but ADMIN_PASSCODE is not: the admin panel stays locked until you set ADMIN_PASSCODE.');
  if (!admins.size) console.log('Admin panel: no admin usernames configured (set ADMIN_USERS or edit src/admin.js).');

  let st = { bans: {}, mutes: {}, banner: '', lbBase: {}, titles: {}, bonus: null, log: [] };           // persisted
  const guestMutes = new Set();                           // guests only, lost on restart
  const fails = new Map();                                // ip -> [timestamps] of wrong passcodes

  async function load() {
    try { const v = await store.kvGet(KEY); if (v && typeof v === 'object') st = Object.assign(st, v); } catch (e) { console.error('admin state load failed:', e.message); }
  }
  const save = () => store.kvSet(KEY, st).catch((e) => console.error('admin state save failed:', e.message));
  /** Staff log: kept in the saved state (last 200), so it survives restarts and redeploys. */
  const record = (by, action, detail) => { st.log = st.log || []; st.log.unshift({ t: Date.now(), by, a: action, d: detail }); if (st.log.length > 200) st.log.length = 200; save(); console.log(`[admin] ${by}: ${action} ${detail}`); };
  /** Win bonus event: { m: multiplier, until: ms } or null. Expired events count as none. */
  const bonus = () => { const b = st.bonus; return b && b.m > 1 && b.until > Date.now() ? { m: b.m, until: b.until } : null; };

  const isAdmin = (name) => admins.has(lower(name));
  const banReason = (name) => { const b = st.bans[lower(name)]; return b ? b.reason || 'No reason given.' : null; };
  const isMuted = (name, isAccount) => (isAccount ? !!st.mutes[lower(name)] : guestMutes.has(lower(name)));
  const banner = () => st.banner || '';
  /** A custom title (and its colour) given to an account from the staff page. Nobody has one by default, staff included. */
  const titleOf = (name) => { const t = st.titles && st.titles[lower(name)]; return t ? { t: t.t, c: t.c } : null; };
  const lbBase = (name) => (st.lbBase && st.lbBase[lower(name)]) || 0;     // wins that no longer count toward the leaderboard

  /* ------------------------------- helpers ------------------------------- */
  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(obj)); };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 4096) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
  const sameOrigin = (req) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host === req.headers.host; } catch (e) { return false; } };
  const ipOf = (req) => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || '?';
  const codeOk = (given) => {
    const a = crypto.createHash('sha256').update(String(given || '')).digest(), b = crypto.createHash('sha256').update(passcode).digest();
    return crypto.timingSafeEqual(a, b);
  };
  const send = (ws, obj) => { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) { /* closing */ } };

  const findPlayer = (roomCode, id) => { const r = rooms.get(roomCode); const p = r && r.players.get(id | 0); return p && !p.bot ? { r, p } : null; };
  function kickAccount(userId, message) {
    const a = activeUsers.get(userId);
    if (a) { send(a.ws, { t: 'kick', m: message }); try { a.ws.close(); } catch (e) { /* gone */ } }
  }

  async function userRow(u, auth) {
    const skins = u.owned.filter((x) => x.startsWith('skin:')), c = auth ? await auth.chests.view(u.id) : null;
    return {
      username: u.username, wins: u.wins, spent: u.spent, balance: u.wins - u.spent, created: u.created,
      owned: u.owned.filter((x) => !T.STARTER_ITEMS.includes(x) && !x.startsWith('skin:')), skins,
      chest: c && { glitter: c.glitter, opened: c.opened, counts: c.counts, sinceE: c.sinceE, sinceL: c.sinceL, gifts: c.gifts, streak: c.streak, focus: c.focus },
      banned: banReason(u.username), muted: !!st.mutes[lower(u.username)],
      online: activeUsers.has(u.id), admin: isAdmin(u.username), title: titleOf(u.username),
    };
  }

  function overview() {
    const rs = [], ps = [];
    let humans = 0;
    for (const r of rooms.values()) {
      const hs = [...r.players.values()].filter((p) => !p.bot);
      humans += hs.length;
      rs.push({ id: r.code, name: r.name, regular: !!r.regular, max: r.max, rt: r.roundTime, map: r.map.id, solo: !!r.solo, state: r.state, humans: hs.length, total: r.players.size, tl: Math.round(r.tl || 0) });
      for (const p of hs) ps.push({ room: r.code, id: p.id, name: p.name, acct: p.uid ? 1 : 0, char: T.CHARS[p.c] ? T.CHARS[p.c].id : '?', rtt: Math.round(p.rtt || 0), muted: !!p.muted, afk: !!p.afk, staff: !!p.staff, it: r.itId === p.id });
    }
    return { rooms: rs, players: ps, humans };
  }

  /* -------------------------------- handler -------------------------------- */
  /** Returns true when it handled the request. `auth` is the account module (cookie -> user). */
  async function handle(req, res, url, auth) {
    if (!url.startsWith('/api/admin/')) return false;
    try {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' }), true;
      if (!sameOrigin(req) || !/^application\/json\b/i.test(req.headers['content-type'] || '')) return json(res, 403, { error: 'Forbidden' }), true;
      const user = await auth.userFromCookie(req.headers.cookie);
      if (!user || !isAdmin(user.username)) return json(res, 403, { error: 'Not a staff account. Log in with a staff username first.' }), true;
      if (!passcode) return json(res, 403, { error: 'The server has no ADMIN_PASSCODE set. Add it to the environment variables and redeploy.', setup: true }), true;
      const ip = ipOf(req), now = Date.now(), recent = (fails.get(ip) || []).filter((t) => now - t < 600e3);
      if (recent.length >= 10) return json(res, 429, { error: 'Too many wrong passcodes. Wait a few minutes.' }), true;
      if (!codeOk(req.headers['x-admin-code'])) {
        if (req.headers['x-admin-code']) { recent.push(now); fails.set(ip, recent); }
        return json(res, 401, { error: req.headers['x-admin-code'] ? 'Wrong passcode.' : 'Enter the passcode.', needCode: true }), true;
      }
      const body = await readBody(req).catch(() => null);
      if (!body || typeof body !== 'object') return json(res, 400, { error: 'Bad request' }), true;
      const act = url.slice('/api/admin/'.length), me = user.username;
      const target = async () => { const u = await store.userByName(clip(body.username, 20)); return u || null; };
      const noUser = () => json(res, 404, { error: 'No account with that username.' });

      if (act === 'state') {
        const o = overview();
        return json(res, 200, {
          me, uptime: Math.round(process.uptime()), mem: Math.round(process.memoryUsage().rss / 1048576), db: store.kind, accounts: await store.countUsers(),
          rooms: o.rooms, players: o.players, humans: o.humans, banner: st.banner,
          bans: Object.entries(st.bans).map(([k, v]) => ({ name: v.name || k, reason: v.reason, by: v.by, at: v.at })),
          titles: Object.entries(st.titles || {}).map(([k, v]) => ({ name: v.name || k, t: v.t, c: v.c })),
          mutes: Object.keys(st.mutes), guestMutes: [...guestMutes], log: (st.log || []).slice(0, 80), admins: [...admins], bonus: bonus(),
        }), true;
      }

      if (act === 'users') {
        const list = await store.listUsers(clip(body.q, 20), 25);
        return json(res, 200, { users: await Promise.all(list.map((u) => userRow(u, auth))) }), true;
      }

      if (act === 'kick') {
        const f = findPlayer(String(body.room), body.id); if (!f) return json(res, 404, { error: 'That player already left.' }), true;
        send(f.p.ws, { t: 'kick', m: 'Staff removed you from the game.' }); try { f.p.ws.close(); } catch (e) { /* gone */ }
        record(me, 'kick', f.p.name); return json(res, 200, { ok: true }), true;
      }

      if (act === 'mute') {
        const f = findPlayer(String(body.room), body.id); if (!f) return json(res, 404, { error: 'That player already left.' }), true;
        const on = !!body.on; f.p.muted = on;
        const key = lower(f.p.name);
        if (f.p.uid) { if (on) st.mutes[key] = { by: me, at: Date.now() }; else delete st.mutes[key]; save(); } else if (on) guestMutes.add(key); else guestMutes.delete(key);
        send(f.p.ws, { t: 'announce', m: on ? 'Staff muted your chat.' : 'You can chat again.', p: 1 });
        record(me, on ? 'mute' : 'unmute', f.p.name); return json(res, 200, { ok: true }), true;
      }

      if (act === 'unmute') {                                // by name, from the lists in the panel
        const key = lower(clip(body.username, 20));
        delete st.mutes[key]; guestMutes.delete(key); save();
        for (const r of rooms.values()) for (const p of r.players.values()) if (!p.bot && lower(p.name) === key) p.muted = false;
        record(me, 'unmute', key); return json(res, 200, { ok: true }), true;
      }

      if (act === 'ban') {
        const u = await target(); if (!u) return noUser(), true;
        if (isAdmin(u.username)) return json(res, 400, { error: 'Admin accounts cannot be banned. Remove the name from ADMIN_USERS first.' }), true;
        if (body.on === false) { delete st.bans[lower(u.username)]; await save(); record(me, 'unban', u.username); return json(res, 200, { ok: true }), true; }
        st.bans[lower(u.username)] = { name: u.username, reason: clip(body.reason, 120) || 'Broke the rules.', by: me, at: Date.now() };
        await save(); await store.dropUserSessions(u.id);
        kickAccount(u.id, 'This account has been suspended.');
        record(me, 'ban', `${u.username} (${st.bans[lower(u.username)].reason})`); return json(res, 200, { ok: true }), true;
      }

      if (act === 'wins') {
        const u = await target(); if (!u) return noUser(), true;
        const d = Math.trunc(Number(body.delta));
        if (!Number.isFinite(d) || d === 0 || Math.abs(d) > 1000) return json(res, 400, { error: 'Enter a whole number between -1000 and 1000.' }), true;
        const n = await store.adjustWins(u.id, d);
        record(me, 'wins', `${u.username} ${d > 0 ? '+' : ''}${d} -> ${n.wins}`); return json(res, 200, { ok: true, user: await userRow(n, auth) }), true;
      }

      if (act === 'lbreset') {                               // zero someone's leaderboard score; characters and balance stay
        const u = await target(); if (!u) return noUser(), true;
        st.lbBase = st.lbBase || {}; st.lbBase[lower(u.username)] = u.wins; await save();
        record(me, 'leaderboard-reset', u.username); return json(res, 200, { ok: true }), true;
      }

      if (act === 'item') {
        const u = await target(); if (!u) return noUser(), true;
        const item = T.SHOP_BY_ID[String(body.item)] || T.parseSkin(String(body.item)); if (!item) return json(res, 400, { error: 'Unknown item.' }), true;
        const n = body.on === false ? await store.revokeItem(u.id, item.id) : await store.grantItem(u.id, item.id);
        record(me, body.on === false ? 'revoke' : 'grant', `${item.id} ${body.on === false ? 'from' : 'to'} ${u.username}`); return json(res, 200, { ok: true, user: await userRow(n, auth) }), true;
      }

      if (act === 'glitter') {                               // add or remove crafting glitter
        const u = await target(); if (!u) return noUser(), true;
        const d = Math.max(-100000, Math.min(100000, body.delta | 0)); if (!d) return json(res, 400, { error: 'Give a non-zero amount.' }), true;
        const n = await auth.chests.addGlitter(u.id, d);
        record(me, 'glitter', `${u.username} ${d > 0 ? '+' : ''}${d} -> ${n}`); return json(res, 200, { ok: true, glitter: n }), true;
      }

      if (act === 'skin') {                                  // give or take skins: one, a whole character, a whole theme, or all of them
        const u = await target(); if (!u) return noUser(), true;
        const ch = String(body.char || ''), th = String(body.theme || '');
        if (ch && !T.CHARS.some((c) => c.id === ch)) return json(res, 400, { error: 'Unknown character.' }), true;
        if (th && !T.cleanSkin(th)) return json(res, 400, { error: 'Unknown theme.' }), true;
        const list = T.SKINS.filter((s) => (!ch || s.char === ch) && (!th || s.theme === th));
        const on = body.on !== false, have = new Set(u.owned);
        let n = 0;
        for (const s of list) { if (on !== have.has(s.id)) { if (on) await store.grantItem(u.id, s.id); else await store.revokeItem(u.id, s.id); n++; } }
        const what = list.length === 1 ? list[0].name : `${list.length} skins (${ch || 'all characters'} / ${th || 'all themes'})`;
        record(me, on ? 'grant-skins' : 'revoke-skins', `${what}: ${n} changed for ${u.username}`);
        return json(res, 200, { ok: true, changed: n, user: await userRow(await store.userById(u.id), auth) }), true;
      }

      if (act === 'gift') {                                  // chests the player can open for free from their chest screen
        const u = await target(); if (!u) return noUser(), true;
        const tier = String(body.tier); if (!T.CHEST_TIERS[tier]) return json(res, 400, { error: 'Unknown chest.' }), true;
        const n = Math.max(-99, Math.min(99, body.n | 0)); if (!n) return json(res, 400, { error: 'Give a non-zero number.' }), true;
        const g = await auth.chests.addGift(u.id, tier, n);
        record(me, 'gift-chest', `${n > 0 ? '+' : ''}${n} ${tier} for ${u.username} (now ${g[tier]})`); return json(res, 200, { ok: true, gifts: g }), true;
      }

      if (act === 'giftall') {                               // wins and/or a free chest for everyone with an account online right now
        const wins = Math.max(0, Math.min(50, body.wins | 0)), tier = String(body.tier || ''), n = tier ? Math.max(1, Math.min(10, body.n | 0)) : 0;
        if (tier && !T.CHEST_TIERS[tier]) return json(res, 400, { error: 'Unknown chest.' }), true;
        if (!wins && !n) return json(res, 400, { error: 'Pick some wins or a chest to give.' }), true;
        let count = 0;
        for (const [id, a] of [...activeUsers.entries()]) {
          if (wins) { const u = await store.adjustWins(id, wins); if (u) send(a.ws, { t: 'award', wins: u.wins, balance: u.wins - u.spent }); }
          if (n) await auth.chests.addGift(id, tier, n);
          send(a.ws, { t: 'announce', m: 'Staff sent you ' + [wins ? `${wins} win${wins > 1 ? 's' : ''}` : '', n ? `${n} ${T.CHEST_TIERS[tier].name}${n > 1 ? 's' : ''}` : ''].filter(Boolean).join(' and ') + '!', p: 1 });
          count++;
        }
        record(me, 'gift-all', `${wins ? wins + ' wins ' : ''}${n ? n + ' ' + tier + ' chest ' : ''}to ${count} online players`);
        return json(res, 200, { ok: true, count }), true;
      }

      if (act === 'bonus') {                                 // win multiplier event (e.g. double wins for 3 hours)
        const m = Math.max(1, Math.min(5, body.m | 0)), hours = Math.max(0, Math.min(72, Number(body.hours) || 0));
        if (m <= 1 || !hours) { st.bonus = null; await save(); record(me, 'bonus-end', ''); return json(res, 200, { ok: true, bonus: null }), true; }
        st.bonus = { m, until: Date.now() + Math.round(hours * 3600e3), by: me };
        await save(); record(me, 'bonus', `x${m} wins for ${hours}h`);
        return json(res, 200, { ok: true, bonus: bonus() }), true;
      }

      if (act === 'logout') {                                // sign someone out everywhere and drop them from any game
        const u = await target(); if (!u) return noUser(), true;
        await store.dropUserSessions(u.id); kickAccount(u.id, 'Staff signed you out. Log in again.');
        record(me, 'sign-out', u.username); return json(res, 200, { ok: true }), true;
      }

      if (act === 'password') {
        const u = await target(); if (!u) return noUser(), true;
        const pv = T.validatePassword(body.password); if (!pv.ok) return json(res, 400, { error: pv.err }), true;
        await store.setPassword(u.id, await hashPassword(String(body.password)));
        kickAccount(u.id, 'Your password was changed by staff. Log in again.');
        record(me, 'password-reset', u.username); return json(res, 200, { ok: true }), true;
      }

      if (act === 'title') {                                 // give (or clear) a coloured title shown next to the player's name
        const u = await target(); if (!u) return noUser(), true;
        const text = clip(body.title, 16), col = String(body.color || '').trim();
        st.titles = st.titles || {};
        if (!text) { delete st.titles[lower(u.username)]; }
        else {
          if (!/^#[0-9a-fA-F]{6}$/.test(col)) return json(res, 400, { error: 'Pick a colour like #ff8a3d.' }), true;
          st.titles[lower(u.username)] = { name: u.username, t: text, c: col.toLowerCase(), by: me, at: Date.now() };
        }
        await save();
        const t = titleOf(u.username);
        for (const r of rooms.values()) for (const p of r.players.values()) if (!p.bot && p.uid === u.id) { p.title = t; r.rosterDirty = true; }       // shows up in the live game straight away
        record(me, text ? 'title' : 'title-clear', text ? `${u.username}: "${text}" ${col}` : u.username);
        return json(res, 200, { ok: true, title: t }), true;
      }

      if (act === 'announce') {
        const m = clip(body.m, 140); if (!m) return json(res, 400, { error: 'Write a message first.' }), true;
        let n = 0; for (const ws of wss.clients) if (ws.readyState === 1) { send(ws, { t: 'announce', m }); n++; }
        record(me, 'announce', `"${m}" -> ${n} sockets`); return json(res, 200, { ok: true, sent: n }), true;
      }

      if (act === 'banner') {
        st.banner = clip(body.m, 160); await save();
        record(me, 'banner', st.banner ? `"${st.banner}"` : '(cleared)'); return json(res, 200, { ok: true, banner: st.banner }), true;
      }

      return json(res, 404, { error: 'Unknown action.' }), true;
    } catch (e) {
      console.error('admin error:', e);
      return json(res, 500, { error: 'Something went wrong.' }), true;
    }
  }

  return { handle, load, isAdmin, banReason, isMuted, banner, bonus, lbBase, titleOf, admins };
}

module.exports = { create, ADMIN_USERNAMES };
