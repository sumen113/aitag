'use strict';
/* Admin panel client. Talks to /api/hq/* (an alias of /api/admin/*; some school filters block anything called "admin") (server checks: admin account + ADMIN_PASSCODE on every request). */
(function () {
  const T = window.TagShared;
  // anything that goes wrong is shown on the page instead of leaving it blank
  window.addEventListener('error', (e) => { const m = document.getElementById('adGateMsg'); if (m && !document.getElementById('adGate').classList.contains('hidden')) m.textContent = 'Something broke: ' + (e.message || 'unknown error'); });
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  let code = '';
  try { code = sessionStorage.getItem('tr_admin_code') || ''; } catch (e) { /* storage blocked */ }
  let tab = 'live', timer = null, toastTimer = null, lastState = null;

  async function api(action, body) {
    try {
      const r = await fetch('/api/hq/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Code': code }, body: JSON.stringify(body || {}) });
      return { status: r.status, j: await r.json().catch(() => ({})) };
    } catch (e) { return { status: 0, j: { error: 'Could not reach the server.' } }; }
  }
  function toast(msg, bad) {
    const t = $('adToast'); t.textContent = msg; t.classList.toggle('err', !!bad);
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.textContent = ''; }, 4500);
  }
  const fmtUp = (s) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${s}s`);
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`; };
  const STATE_NAME = ['waiting', 'countdown', 'playing', 'results'];

  /* ------------------------------ gate / boot ------------------------------ */
  function gate(title, msg, mode) {
    $('adPanel').classList.add('hidden'); $('adGate').classList.remove('hidden');
    $('adGateTitle').textContent = title; $('adGateMsg').textContent = msg;
    $('adCodeForm').classList.toggle('hidden', mode !== 'code'); $('adLogin').classList.toggle('hidden', mode !== 'login');
    if (mode === 'code') $('adCode').focus();
    clearInterval(timer); timer = null;
  }
  async function refresh() {
    const r = await api('state');
    if (r.status === 200) {
      lastState = r.j; $('adGate').classList.add('hidden'); $('adPanel').classList.remove('hidden');
      $('adMe').textContent = 'Signed in as ' + r.j.me; paint(r.j);
      if (!timer) timer = setInterval(refresh, 3000);
      return true;
    }
    if (r.status === 401) { gate('Admin passcode', r.j.error || 'Enter the passcode to continue.', 'code'); return false; }
    if (r.status === 403 && r.j.setup) { gate('Almost there', r.j.error, 'none'); return false; }
    if (r.status === 403) {
      const me = await (await fetch('/api/me', { cache: 'no-store' }).catch(() => null))?.json().catch(() => ({}));
      if (!me || !me.user) gate('Log in first', 'Log in on the main page with one of the admin usernames, then come back here.', 'login');
      else gate('No access', `You are logged in as ${me.user.username}, which is not an admin account.`, 'none');
      return false;
    }
    if (r.status === 429) { gate('Slow down', r.j.error, 'none'); return false; }
    gate('Something went wrong', r.j.error || 'Could not load the panel.', 'none'); return false;
  }
  $('adCodeForm').addEventListener('submit', async (e) => {
    e.preventDefault(); code = $('adCode').value; $('adCode').value = '';
    try { sessionStorage.setItem('tr_admin_code', code); } catch (x) { /* ignore */ }
    const ok = await refresh();
    if (!ok) { try { sessionStorage.removeItem('tr_admin_code'); } catch (x) { /* ignore */ } }
  });

  /* --------------------------------- tabs --------------------------------- */
  $('adTabs').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; tab = b.dataset.tab;
    $('adTabs').querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== tab));
    if (tab === 'accounts' && !$('adUsers').children.length) searchUsers();
  });

  /* ---------------------------- live / broadcast ---------------------------- */
  function paint(s) {
    const tiles = [['Players', s.humans], ['Rooms', s.rooms.length], ['Accounts', s.accounts], ['Uptime', fmtUp(s.uptime)], ['Memory', s.mem + ' MB'], ['Storage', s.db === 'postgres' ? 'Postgres' : 'Dev file']];
    $('adTiles').replaceChildren(...tiles.map(([k, v]) => { const d = el('div', 'ad-tile'); d.append(el('span', 'mono', k), el('b', '', String(v))); return d; }));

    const pb = $('adPlayers').tBodies[0]; pb.replaceChildren();
    if (!s.players.length) { const tr = el('tr'), td = el('td', 'empty', 'Nobody is online right now.'); td.colSpan = 6; tr.append(td); pb.append(tr); }
    for (const p of s.players) {
      const tr = el('tr'), name = el('td'); name.append(el('b', '', p.name));
      const flags = el('td');
      if (p.staff) flags.append(el('span', 'ad-pill staff', 'staff'));
      flags.append(el('span', 'ad-pill' + (p.acct ? ' acct' : ''), p.acct ? 'account' : 'guest'));
      if (p.it) flags.append(el('span', 'ad-pill it', 'it'));
      if (p.afk) flags.append(el('span', 'ad-pill', 'afk'));
      if (p.muted) flags.append(el('span', 'ad-pill bad', 'muted'));
      const act = el('td'), box = el('div', 'ad-actions');
      const mute = el('button', 'ad-btn', p.muted ? 'Unmute' : 'Mute'); mute.type = 'button';
      mute.onclick = async () => done(await api('mute', { room: p.room, id: p.id, on: !p.muted }), p.muted ? `${p.name} unmuted` : `${p.name} muted`);
      const kick = el('button', 'ad-btn', 'Kick'); kick.type = 'button';
      kick.onclick = async () => { if (confirm(`Kick ${p.name}?`)) done(await api('kick', { room: p.room, id: p.id }), `${p.name} kicked`); };
      box.append(mute, kick);
      if (p.acct) {
        const ban = el('button', 'ad-btn danger', 'Ban'); ban.type = 'button';
        ban.onclick = async () => { const why = prompt(`Ban account "${p.name}"? Reason (shown to them when they try to log in):`, 'Broke the rules.'); if (why !== null) done(await api('ban', { username: p.name, reason: why }), `${p.name} banned`); };
        box.append(ban);
      }
      act.append(box);
      tr.append(name, el('td', '', p.room), el('td', '', p.char), el('td', '', p.rtt ? p.rtt + ' ms' : '-'), flags, act); pb.append(tr);
    }

    const rb = $('adRooms').tBodies[0]; rb.replaceChildren();
    if (!s.rooms.length) { const tr = el('tr'), td = el('td', 'empty', 'No rooms yet.'); td.colSpan = 6; tr.append(td); rb.append(tr); }
    for (const r of s.rooms) {
      const tr = el('tr');
      tr.append(el('td', '', r.id), el('td', '', r.map), el('td', '', r.solo ? 'practice' : r.regular ? 'Regular' : `"${r.name}" · ${r.rt}s · max ${r.max}`), el('td', '', `${r.humans} human${r.humans === 1 ? '' : 's'}${r.total > r.humans ? ` + ${r.total - r.humans} bots` : ''}`), el('td', '', STATE_NAME[r.state] || String(r.state)), el('td', '', r.tl ? r.tl + 's' : '-'));
      rb.append(tr);
    }

    // broadcast tab lists (don't clobber text being typed)
    if (document.activeElement !== $('adBanTxt') && document.activeElement !== $('adAnnTxt')) { if ($('adBanTxt').dataset.set !== '1') { $('adBanTxt').value = s.banner || ''; $('adBanTxt').dataset.set = '1'; } }
    const bans = $('adBans'); bans.replaceChildren();
    if (!s.bans.length) bans.append(el('span', 'ad-none', 'Nobody is banned.'));
    for (const b of s.bans) {
      const c = el('span', 'ad-chip'); c.append(el('b', '', b.name), el('small', '', b.reason || ''));
      const x = el('button', 'ad-btn', 'Unban'); x.type = 'button'; x.onclick = async () => done(await api('ban', { username: b.name, on: false }), `${b.name} unbanned`); c.append(x); bans.append(c);
    }
    const mutes = $('adMutes'); mutes.replaceChildren();
    const all = [...s.mutes.map((n) => [n, 'account']), ...s.guestMutes.map((n) => [n, 'guest'])];
    if (!all.length) mutes.append(el('span', 'ad-none', 'Nobody is muted.'));
    for (const [n, kind] of all) {
      const c = el('span', 'ad-chip'); c.append(el('b', '', n), el('small', '', kind));
      const x = el('button', 'ad-btn', 'Unmute'); x.type = 'button'; x.onclick = async () => done(await api('unmute', { username: n }), `${n} unmuted`); c.append(x); mutes.append(c);
    }
    $('adAdmins').textContent = 'Admin usernames: ' + s.admins.join(', ') + '. Change them with the ADMIN_USERS environment variable.';

    const log = $('adLog'); log.replaceChildren();
    if (!s.log.length) log.append(el('li', '', 'Nothing yet this session.'));
    for (const l of s.log) { const li = el('li'); li.append(el('time', '', ago(l.t)), el('b', '', l.by), el('span', '', `${l.a} ${l.d}`)); log.append(li); }
  }
  async function done(r, okMsg) {
    if (r.status === 200) toast(okMsg); else toast(r.j.error || 'That did not work.', true);
    refresh(); if (tab === 'accounts') searchUsers($('adQ').value);
    return r;
  }
  $('adAnnounce').addEventListener('submit', async (e) => { e.preventDefault(); const r = await api('announce', { m: $('adAnnTxt').value }); if (r.status === 200) { $('adAnnTxt').value = ''; toast(`Sent to ${r.j.sent} connection${r.j.sent === 1 ? '' : 's'}.`); refresh(); } else toast(r.j.error, true); });
  $('adBanner').addEventListener('submit', async (e) => { e.preventDefault(); const r = await api('banner', { m: $('adBanTxt').value }); toast(r.status === 200 ? (r.j.banner ? 'Banner is live.' : 'Banner removed.') : r.j.error, r.status !== 200); refresh(); });

  /* -------------------------------- accounts -------------------------------- */
  $('adSearch').addEventListener('submit', (e) => { e.preventDefault(); searchUsers($('adQ').value); });
  async function searchUsers(q) {
    const r = await api('users', { q: q || '' }); const box = $('adUsers'); box.replaceChildren();
    if (r.status !== 200) { toast(r.j.error || 'Search failed.', true); return; }
    if (!r.j.users.length) box.append(el('p', 'ad-none', 'No accounts match.'));
    for (const u of r.j.users) box.append(userCard(u));
  }
  function userCard(u) {
    const c = el('div', 'ad-user'), head = el('div', 'ad-user-head');
    head.append(el('b', '', u.username), el('span', 'mono', `${u.wins} wins · ${u.balance} to spend · joined ${new Date(u.created).toLocaleDateString()}`));
    if (u.online) head.append(el('span', 'ad-pill acct', 'online')); if (u.admin) head.append(el('span', 'ad-pill staff', 'admin'));
    if (u.banned) head.append(el('span', 'ad-pill bad', 'banned: ' + u.banned)); if (u.muted) head.append(el('span', 'ad-pill bad', 'muted'));
    c.append(head);
    const owned = el('div', 'ad-user-row'); owned.append(el('span', 'mono', 'Owns'));
    owned.append(el('span', '', u.owned.length ? u.owned.map((x) => x.replace('char:', '')).join(', ') : 'only the starters'));
    c.append(owned);

    const r1 = el('div', 'ad-user-row'), amt = el('input', 'ad-in'); amt.type = 'number'; amt.value = '5'; amt.min = '-1000'; amt.max = '1000'; amt.setAttribute('aria-label', 'Wins to add');
    const add = el('button', 'ad-btn', 'Give wins'); add.type = 'button'; add.onclick = async () => done(await api('wins', { username: u.username, delta: Number(amt.value) }), `Wins updated for ${u.username}`);
    r1.append(amt, add, el('span', 'mono', '(negative takes away)'));
    const sel = el('select'); for (const it of T.SHOP) { const o = el('option', '', `${it.name} (${it.price}★)`); o.value = it.id; sel.append(o); }
    const give = el('button', 'ad-btn', 'Give item'), take = el('button', 'ad-btn', 'Remove item'); give.type = take.type = 'button';
    give.onclick = async () => done(await api('item', { username: u.username, item: sel.value, on: true }), `Item given to ${u.username}`);
    take.onclick = async () => done(await api('item', { username: u.username, item: sel.value, on: false }), `Item removed from ${u.username}`);
    r1.append(sel, give, take); c.append(r1);

    const r2 = el('div', 'ad-user-row');
    const pw = el('button', 'ad-btn', 'Reset password'); pw.type = 'button';
    pw.onclick = async () => { const p = prompt(`New password for ${u.username} (8+ characters). Tell them to log in with it.`); if (p) done(await api('password', { username: u.username, password: p }), `Password changed for ${u.username}`); };
    r2.append(pw);
    const lb = el('button', 'ad-btn', 'Reset leaderboard score'); lb.type = 'button';
    lb.onclick = async () => { if (confirm(`Set ${u.username}'s leaderboard score to 0? Their characters and spendable wins are not touched.`)) done(await api('lbreset', { username: u.username }), `${u.username} reset on the leaderboard`); };
    r2.append(lb);
    if (u.muted) { const um = el('button', 'ad-btn', 'Unmute'); um.type = 'button'; um.onclick = async () => done(await api('unmute', { username: u.username }), `${u.username} unmuted`); r2.append(um); }
    if (!u.admin) {
      if (u.banned) { const ub = el('button', 'ad-btn', 'Unban'); ub.type = 'button'; ub.onclick = async () => done(await api('ban', { username: u.username, on: false }), `${u.username} unbanned`); r2.append(ub); }
      else { const b = el('button', 'ad-btn danger', 'Ban'); b.type = 'button'; b.onclick = async () => { const why = prompt(`Ban "${u.username}"? Reason:`, 'Broke the rules.'); if (why !== null) done(await api('ban', { username: u.username, reason: why }), `${u.username} banned`); }; r2.append(b); }
    }
    c.append(r2);
    return c;
  }

  refresh();
})();
