/* Tag Rush · website layer: landing page, GSAP animation, character picker, page transitions.
   Exposes window.App; game.js plugs into it (Game.join / Game.leave). */
(() => {
  'use strict';
  const C = TagShared, { CHARS, COLORS } = C;
  const $ = (id) => document.getElementById(id);
  const clamp = C.clamp, TAU = Math.PI * 2;
  const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;
  gsap.registerPlugin(ScrollTrigger, Flip, SplitText);

  const store = {
    get(k, d) { try { const v = localStorage.getItem('tagrush.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('tagrush.' + k, JSON.stringify(v)); } catch (e) { /* storage blocked */ } },
  };
  const STAGE = ['#ffc58a', '#a8e8b0', '#c9d6ff', '#cdd3ea', '#e8c4a0', '#ffb3d3', '#f3deaa', '#a9d3ff'];
  const sel = {
    name: String(store.get('name', '') || '').slice(0, 14),
    c: clamp(store.get('c', 0) | 0, 0, CHARS.length - 1),
    k: clamp(store.get('k', 0) | 0, 0, COLORS.length - 1),
    diff: ['easy', 'normal', 'hard'].includes(store.get('diff', 'normal')) ? store.get('diff', 'normal') : 'normal',
  };
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const App = { sel, inGame: false, account: null, accountsEnabled: true };
  window.App = App;

  /* ============================== transitions ============================= */
  const curtain = $('curtain'), bars = curtain.querySelectorAll('i'), curtainMsg = $('curtainMsg');
  function curtainIn() {
    curtain.classList.add('on');
    if (reduce) { gsap.set(bars, { scaleY: 1, transformOrigin: 'top' }); return Promise.resolve(); }
    return new Promise((res) => gsap.fromTo(bars, { scaleY: 0, transformOrigin: 'top' }, { scaleY: 1, duration: 0.42, ease: 'power3.inOut', stagger: 0.045, onComplete: res }));
  }
  function curtainOut() {
    gsap.to(curtainMsg, { opacity: 0, duration: 0.15 });
    const done = () => curtain.classList.remove('on');
    if (reduce) { gsap.set(bars, { scaleY: 0 }); done(); return Promise.resolve(); }
    return new Promise((res) => gsap.to(bars, { scaleY: 0, transformOrigin: 'bottom', duration: 0.5, ease: 'power3.inOut', stagger: 0.045, onComplete: () => { done(); res(); } }));
  }
  App.curtainMsg = (m) => { curtainMsg.textContent = m || ''; gsap.to(curtainMsg, { opacity: m ? 1 : 0, duration: 0.3 }); };

  /* ================================ the form =============================== */
  const form = $('joinForm'), nameEl = $('name'), errEl = $('formErr'), fieldEl = nameEl.parentElement;
  nameEl.value = sel.name;
  const updCount = () => { $('nameCount').textContent = nameEl.value.length + '/14'; };
  updCount();
  function showErr(m) {
    errEl.textContent = m || ''; fieldEl.classList.toggle('bad', !!m);
    if (m && !reduce) gsap.fromTo(fieldEl, { x: -10 }, { x: 0, duration: 0.5, ease: 'elastic.out(1.2, .25)', clearProps: 'transform' });
  }
  nameEl.addEventListener('input', () => { sel.name = nameEl.value; updCount(); showErr(''); store.set('name', nameEl.value.trim()); });

  const seg = $('diff');
  function paintDiff() { seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.d === sel.diff))); }
  seg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; sel.diff = b.dataset.d; store.set('diff', sel.diff); paintDiff(); Sfx.play('click'); });
  paintDiff();

  let busy = false;
  async function start(mode) {
    if (busy) return;
    if (!(await check(mode))) return;
    if (mode === 'online') return openServers();
    go(mode, {});
  }
  async function check(mode) {
    const acct = App.account;
    const v = acct ? { ok: true, name: acct.username } : C.validateName(nameEl.value);
    if (!v.ok) { showErr(v.err); nameEl.focus(); return; }
    if (!owns(sel.c) && mode !== 'bots') {
      const d = CHARS[sel.c];
      showErr(acct ? `${d.species} is locked. Unlock it in the shop for ${d.price} wins.` : `${d.species} is locked. Log in and win rounds to unlock more characters.`);
      Sfx.play('deny'); return;
    }
    showErr('');
    if (!acct) { sel.name = v.name; store.set('name', v.name); }
    return true;
  }
  async function go(mode, extra) {
    if (busy) return;
    const acct = App.account, name = acct ? acct.username : C.validateName(nameEl.value).name;
    busy = true; $('btnPlay').disabled = $('btnBots').disabled = true;
    Sfx.unlock(); Sfx.play('ready');
    await curtainIn();
    const slow = setTimeout(() => App.curtainMsg('Waking the server up… free hosting can take up to a minute.'), 3500);
    const res = await Game.join(Object.assign({ mode, diff: sel.diff, name, c: sel.c, k: sel.k }, extra));
    clearTimeout(slow); App.curtainMsg('');
    if (!res.ok) { await curtainOut(); busy = false; $('btnPlay').disabled = $('btnBots').disabled = false; if (mode === 'online') { if (extra.server && extra.pass !== undefined && /password/i.test(res.err) && lockedSv) { openModal('serverModal'); askPass(lockedSv, res.err); } else openServers(res.err); } else showErr(res.err); return; }
    enterGame();
    await curtainOut();
    Game.begin();
    busy = false; $('btnPlay').disabled = $('btnBots').disabled = false;
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); start('online'); });
  $('btnBots').addEventListener('click', () => start('bots'));

  /* ---- server browser ---- */
  const svList = $('svList'), svErr = $('svErr'), svForm = $('svForm'), svPick = $('svPick'), svFormErr = $('svFormErr');
  const fmtTime = (s) => (s % 60 ? s + 's' : (s / 60) + ' min');
  let svTimer = 0, svMapsDone = false;
  const svPassForm = $('svPassForm');
  function svView(create, pass) {
    svPick.classList.toggle('hidden', !!create || !!pass); svForm.classList.toggle('hidden', !create); svPassForm.classList.toggle('hidden', !pass);
    $('serverTitle').textContent = create ? 'Create a server' : pass ? 'Password needed' : 'Pick a server';
    if (create) setTimeout(() => $('svName').focus(), 30);
  }
  let lockedSv = null;
  function askPass(s, err) { lockedSv = s; $('svPassFor').textContent = `"${s.name}" is private.`; $('svPassIn').value = ''; $('svPassErr').textContent = err || ''; svView(false, true); setTimeout(() => $('svPassIn').focus(), 30); }
  svPassForm.addEventListener('submit', (e) => { e.preventDefault(); const pass = $('svPassIn').value; if (!pass) { $('svPassErr').textContent = 'Type the password.'; return; } closeModal(); go('online', { server: lockedSv.id, pass }); });
  $('svPassBack').addEventListener('click', () => { svView(false); Sfx.play('click'); });
  function paintServers(d) {
    if (!svMapsDone && d.maps) { for (const m of d.maps) { const o = el('option', null, m.name); o.value = m.id; $('svMap').appendChild(o); } svMapsDone = true; }
    svList.replaceChildren();
    for (const s of d.servers) {
      const li = el('li', 'sv' + (s.regular ? ' reg' : '') + (s.full ? ' full' : ''));
      const info = el('div', 'sv-info');
      info.append(el('b', 'sv-name', (s.lock ? '🔒 ' : '') + s.name), el('span', 'sv-meta mono', s.regular ? 'always on · standard rules · earns wins' : fmtTime(s.time) + ' games · ' + (s.bots ? s.bots + ' bots' : 'no bots') + ' · ' + (s.state === 2 ? 'round in progress' : 'lobby')));
      const cnt = el('span', 'sv-count mono', s.regular ? s.players + ' playing' : s.players + '/' + s.max);
      const b = el('button', 'btn ' + (s.regular ? 'btn-primary' : 'btn-ghost'), null);
      b.type = 'button'; b.disabled = !!s.full; b.append(el('span', 'btn-label', s.full ? 'Full' : 'Join'));
      b.addEventListener('click', () => { if (s.lock) return askPass(s); closeModal(); go('online', { server: s.id }); });
      li.append(info, cnt, b); svList.appendChild(li);
    }
    if (d.servers.length === 1) svList.appendChild(el('li', 'sv empty', 'No player-made servers yet. Be the first!'));
  }
  async function loadServers() {
    try { const r = await fetch('/api/servers', { cache: 'no-store' }); if (r.ok) paintServers(await r.json()); } catch (e) { svErr.textContent = 'Could not load the server list.'; }
  }
  function openServers(err) {
    svErr.textContent = err || ''; svFormErr.textContent = ''; svView(false);
    svList.replaceChildren(el('li', 'sv empty', 'Loading…'));
    openModal('serverModal'); loadServers();
    clearInterval(svTimer); svTimer = setInterval(() => { if (!$('serverModal').hidden && !svPick.classList.contains('hidden')) loadServers(); else if ($('serverModal').hidden) clearInterval(svTimer); }, 4000);
  }
  $('svNew').addEventListener('click', () => { svView(true); Sfx.play('click'); });
  $('svBack').addEventListener('click', () => { svView(false); Sfx.play('click'); });
  svForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const o = { name: $('svName').value, time: Number($('svTime').value), max: Number($('svMax').value), map: $('svMap').value, bots: Number($('svBots').value) || 0, diff: $('svDiff').value, pass: $('svPassNew').value };
    const v = C.validateServer(o);
    if (!v.ok) { svFormErr.textContent = v.err; Sfx.play('deny'); return; }
    svFormErr.textContent = ''; closeModal(); go('online', { create: o });
  });

  function enterGame() {
    App.inGame = true;
    $('site').classList.add('hidden'); $('app').classList.remove('hidden');
    document.body.classList.add('in-game'); document.body.classList.remove('is-site');
    document.documentElement.style.background = '#0b0d1f';
    Game.show();
  }
  App.leave = async function () {
    if (!App.inGame || busy) return;
    busy = true;
    await curtainIn();
    Game.leave();
    App.inGame = false;
    $('app').classList.add('hidden'); $('site').classList.remove('hidden');
    document.body.classList.remove('in-game'); document.body.classList.add('is-site');
    document.documentElement.style.background = '';
    window.scrollTo(0, 0); ScrollTrigger.refresh(); pollStats(); loadMe();
    await curtainOut();
    busy = false;
  };

  /* ============================= character stage =========================== */
  const pvc = $('preview'), pv = pvc.getContext('2d');
  const pic = $('picker'), sw = $('swatches');
  const hop = { air: 0, sq: 0 };
  const LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
  const owns = (i) => C.ownsChar(App.account ? App.account.owned : [], CHARS[i].id);
  const firstOwned = () => CHARS.findIndex((_, i) => owns(i));

  function buildPicker() {
    CHARS.forEach((def, i) => {
      const b = el('button', 'pick'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.i = i; b.setAttribute('aria-label', def.species);
      const img = new Image(); img.alt = ''; b.appendChild(img);
      const lk = el('span', 'lk'); lk.innerHTML = LOCK; b.appendChild(lk);
      b.addEventListener('click', () => pick(i));
      pic.appendChild(b);
    });
    COLORS.forEach((_, k) => {
      const b = el('button', 'swatch'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.k = k; b.title = C.COLOR_NAMES[k]; b.setAttribute('aria-label', C.COLOR_NAMES[k]);
      b.addEventListener('click', () => { sel.k = k; store.set('k', k); Sfx.play('click'); paintStage(false); bounce(); });
      sw.appendChild(b);
    });
  }
  function paintStage(animate) {
    const def = CHARS[sel.c];
    pic.querySelectorAll('.pick').forEach((b, i) => { b.setAttribute('aria-checked', String(i === sel.c)); b.classList.toggle('locked', !owns(i)); b.setAttribute('aria-label', CHARS[i].species + (owns(i) ? '' : ' (locked)')); b.querySelector('img').src = Chars.avatar(i, sel.k, 96); });
    paintLockSticker();
    sw.querySelectorAll('.swatch').forEach((b, k) => { b.style.background = Chars.colorOf(sel.c, k); b.setAttribute('aria-checked', String(k === sel.k)); });
    $('stage').style.setProperty('--stage', STAGE[sel.c]);
    $('stRole').textContent = def.role;
    $('stAb').textContent = def.ability; $('stCd').textContent = def.cd + 's recharge';
    $('stIcon').innerHTML = Chars.icon(def.fx);
    const swap = () => { $('stName').textContent = `${def.name} the ${def.species}`; $('stDesc').textContent = def.desc; };
    if (animate && !reduce) {
      gsap.to(['#stName', '#stDesc'], { yPercent: -30, opacity: 0, duration: 0.12, ease: 'power2.in', onComplete: () => { swap(); gsap.fromTo(['#stName', '#stDesc'], { yPercent: 30, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.3, stagger: 0.04, ease: 'power3.out' }); } });
      gsap.fromTo('#abSticker', { scale: 0.7, rotate: -8 }, { scale: 1, rotate: 2, duration: 0.5, ease: 'back.out(3)' });
      gsap.fromTo('#stRole', { scale: 0.7, rotate: 8 }, { scale: 1, rotate: -3, duration: 0.5, ease: 'back.out(3)' });
    } else swap();
  }
  function paintLockSticker() {
    const def = CHARS[sel.c], locked = !owns(sel.c);
    $('stLock').classList.toggle('hidden', !locked);
    if (locked) $('stLockTxt').textContent = `Locked · ${def.price} wins`;
  }
  $('stLock').addEventListener('click', () => { Sfx.play('click'); openShop(); });
  function bounce() {
    if (reduce) return;
    gsap.killTweensOf(hop);
    gsap.timeline().to(hop, { sq: 0.12, duration: 0.09, ease: 'power2.out' }).to(hop, { sq: -0.1, air: 0.22, duration: 0.2, ease: 'power2.out' }).to(hop, { sq: 0.1, air: 0, duration: 0.18, ease: 'power2.in' }).to(hop, { sq: 0, duration: 0.5, ease: 'elastic.out(1.4,.35)' });
  }
  function pick(i, fromCast) {
    if (i === sel.c && !fromCast) { bounce(); return; }
    sel.c = i; store.set('c', i); Sfx.play('click'); paintStage(true); bounce();
  }
  App.pick = pick;

  const mouse = { x: 0.5, y: 0.5 };
  window.addEventListener('pointermove', (e) => { mouse.x = e.clientX / innerWidth; mouse.y = e.clientY / innerHeight; }, { passive: true });
  pvc.addEventListener('pointerdown', () => { bounce(); Sfx.play('click'); });
  let stageVisible = true, blink = { next: 2, t: 0 };
  new IntersectionObserver((en) => { stageVisible = en[0].isIntersecting; }).observe($('stage'));
  function drawPreview(dt, t) {
    if (App.inGame || !stageVisible) return;
    pv.clearRect(0, 0, 560, 560);
    blink.next -= dt; if (blink.next < 0) { blink.t = 0.16; blink.next = 2 + Math.random() * 3; }
    blink.t = Math.max(0, blink.t - dt);
    const b = blink.t > 0 ? Math.sin((1 - blink.t / 0.16) * Math.PI) : 0;
    const r = pvc.getBoundingClientRect(), cx = (r.left + r.width / 2) / innerWidth, cy = (r.top + r.height / 2) / innerHeight;
    const lx = clamp((mouse.x - cx) * 4, -1, 1), ly = clamp((mouse.y - cy) * 4, -1, 1);
    Chars.draw(pv, sel.c, { x: 280, y: 470, s: 6.6, color: sel.k ? COLORS[sel.k] : null, face: 1, lx: lx || 0.001, ly, t, spd: 0, blink: b, air: hop.air, stretch: hop.sq });
  }

  /* ============================== content blocks =========================== */
  function buildCast() {
    const grid = $('castGrid');
    CHARS.forEach((def, i) => {
      const card = el('button', 'cast-card card'); card.type = 'button'; card.style.setProperty('--c', STAGE[i]); card.setAttribute('aria-label', `Play as ${def.species}`);
      const art = el('div', 'cast-art'); const img = new Image(); img.alt = def.species; img.loading = 'lazy'; img.src = Chars.avatar(i, 0, 240); art.appendChild(img);
      const info = el('div', 'cast-info');
      const top = el('div', 'cast-top'); top.append(el('h3', 'cast-name', def.species), el('span', 'cast-role mono', def.role));
      const ab = el('div', 'cast-ab'); ab.innerHTML = Chars.icon(def.fx, 'ico'); ab.append(el('span', '', def.ability), el('small', '', `${def.cd}s`));
      info.append(top, ab, el('p', 'cast-desc', def.desc));
      const badge = el('span', 'cast-lock'); badge.dataset.i = i; card.append(badge, art, info);
      card.addEventListener('click', () => { pick(i, true); window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); });
      grid.appendChild(card);
    });
  }
  function paintCast() {
    document.querySelectorAll('#castGrid .cast-card').forEach((card, i) => {
      const def = CHARS[i], mine = owns(i), b = card.querySelector('.cast-lock');
      card.classList.toggle('locked', !mine); card.classList.toggle('free', mine);
      if (mine) { b.textContent = def.starter ? 'Starter' : 'Owned'; } else { b.innerHTML = LOCK + `<span>${def.price} wins</span>`; }
    });
  }
  function buildArenas() {
    const grid = $('arenaGrid');
    C.MAPS.forEach((m) => {
      const card = el('article', 'arena-card card'); const cv = document.createElement('canvas');
      const base = MapRender.miniBase(m, 640, true); cv.width = base.width; cv.height = base.height; cv.getContext('2d').drawImage(base, 0, 0);
      cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', m.name + ' map');
      const d = el('div'); d.append(el('h3', '', m.name), el('p', '', m.blurb));
      card.append(cv, d); grid.appendChild(card);
    });
  }
  function buildMarquee() {
    const words = ['Dash', 'Leap', 'Phase', 'Cloak', 'Stomp', 'Goo Trap', 'Decoy', 'Shield', "Don't be IT"];
    const track = $('marquee');
    const set = () => { const s = el('span'); s.innerHTML = words.map((w) => `${w}<i></i>`).join(''); return s; };
    for (let i = 0; i < 4; i++) track.appendChild(set());
    track.querySelectorAll('span').forEach((s) => { s.style.display = 'inline-flex'; });
  }
  function buildStickers() {
    const wrap = $('stickers');
    const star = '<svg viewBox="0 0 100 100"><path d="M50 4l11 29 31 2-24 20 8 30-26-17-26 17 8-30L8 35l31-2z" fill="#ffd23f" stroke="#14122b" stroke-width="5" stroke-linejoin="round"/></svg>';
    const squig = '<svg viewBox="0 0 140 50"><path d="M5 30c14-28 22 20 36-4s22 20 36-4 22 18 36-2" fill="none" stroke="#ff4d5e" stroke-width="9" stroke-linecap="round"/></svg>';
    const plus = '<svg viewBox="0 0 60 60"><path d="M30 6v48M6 30h48" stroke="#14122b" stroke-width="12" stroke-linecap="round"/><path d="M30 6v48M6 30h48" stroke="#2fd18b" stroke-width="5" stroke-linecap="round"/></svg>';
    const ring = '<svg viewBox="0 0 80 80"><circle cx="40" cy="40" r="28" fill="none" stroke="#14122b" stroke-width="16"/><circle cx="40" cy="40" r="28" fill="none" stroke="#4a7cff" stroke-width="9"/></svg>';
    const items = [
      { h: star, x: '46%', y: '4%', w: 64, r: 12 }, { h: squig, x: '2%', y: '84%', w: 120, r: -8 }, { h: plus, x: '95%', y: '40%', w: 44, r: 10 },
      { h: ring, x: '38%', y: '90%', w: 56, r: 0 }, { h: star, x: '90%', y: '92%', w: 40, r: -14 },
    ];
    items.forEach((it) => { const d = el('div', 'sticker'); d.innerHTML = it.h; Object.assign(d.style, { left: it.x, top: it.y, width: it.w + 'px' }); d.dataset.r = it.r; d.style.transform = `rotate(${it.r}deg)`; wrap.appendChild(d); });
  }

  /* ============================ online counter ============================ */
  async function pollStats() {
    if (App.inGame) return;
    try {
      const r = await fetch('/api/stats', { cache: 'no-store' }), s = await r.json();
      $('onlineNav').textContent = s.players ? `${s.players} playing now` : 'Be the first in';
      const bn = $('siteBanner'), txt = s.banner || '';
      if ($('siteBannerTxt').textContent !== txt) $('siteBannerTxt').textContent = txt;
      bn.classList.toggle('hidden', !txt);
    } catch (e) { $('onlineNav').textContent = 'Online'; }
  }

  /* ================================ animation ============================== */
  // CSS transitions on transform fight GSAP's per-frame writes (the element crawls toward its target),
  // so disable them while a tween owns the element and hand them back afterwards.
  const own = (els) => { const l = gsap.utils.toArray(els); l.forEach((e) => { e.style.transition = 'none'; }); return () => l.forEach((e) => { e.style.transition = ''; }); };
  function intro() {
    const releasePick = own('.pick');
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    const a = SplitText.create('#h1a', { type: 'chars', mask: 'chars' }), b = SplitText.create('#h1b', { type: 'chars', mask: 'chars' });
    tl.from('.nav', { yPercent: -100, duration: 0.7 }, 0)
      .from('.eyebrow span', { y: 20, opacity: 0, rotate: -6, stagger: 0.08, duration: 0.6 }, 0.15)
      .from(a.chars, { yPercent: 115, rotate: 10, duration: 0.9, ease: 'expo.out', stagger: 0.035 }, 0.2)
      .from(b.chars, { yPercent: 130, scale: 0.4, rotate: -14, duration: 1.1, ease: 'back.out(2.2)', stagger: 0.09 }, 0.45)
      .from('.lede', { y: 24, opacity: 0, duration: 0.7 }, 0.7)
      .from('.join', { y: 50, opacity: 0, scale: 0.96, duration: 0.8 }, 0.8)
      .from('.stage', { x: 80, y: 20, opacity: 0, rotate: 4, duration: 1, ease: 'expo.out' }, 0.45)
      .from('.pick', { scale: 0, rotate: -20, stagger: 0.04, duration: 0.5, ease: 'back.out(3)', onComplete: () => { gsap.set('.pick', { clearProps: 'transform' }); releasePick(); } }, 1)
      .from('.sticker', { scale: 0, rotate: '+=120', stagger: 0.08, duration: 0.8, ease: 'back.out(2)' }, 0.9);
    return tl;
  }

  function scrollAnims() {
    // headings: line-by-line mask reveal
    document.querySelectorAll('[data-split]').forEach((h) => {
      SplitText.create(h, {
        type: 'lines', mask: 'lines', autoSplit: true,
        onSplit: (self) => gsap.from(self.lines, { yPercent: 110, duration: 1, stagger: 0.09, ease: 'expo.out', scrollTrigger: { trigger: h, start: 'top 88%', once: true } }),
      });
    });
    gsap.utils.toArray('.section-lede, .kicker').forEach((e) => gsap.from(e, { y: 24, opacity: 0, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: e, start: 'top 92%', once: true } }));
    const batch = (sel, vars) => ScrollTrigger.batch(sel, { start: 'top 92%', once: true, onEnter: (els) => { const rel = own(els); gsap.from(els, Object.assign({ stagger: 0.09, ease: 'power3.out', duration: 0.8, clearProps: 'transform,opacity', onComplete: rel }, vars)); } });
    batch('.cast-card', { y: 70, opacity: 0, rotate: 2 });
    batch('.arena-card', { y: 60, opacity: 0, scale: 0.95 });
    batch('.step', { y: 60, opacity: 0, rotate: -2 });
    gsap.from('#controls', { y: 40, opacity: 0, duration: 0.8, ease: 'power3.out', scrollTrigger: { trigger: '#controls', start: 'top 92%', once: true } });
    gsap.from('#final .h2', { scale: 0.85, opacity: 0, duration: 1, ease: 'expo.out', scrollTrigger: { trigger: '#final', start: 'top 80%', once: true } });
    gsap.from('#btnTop', { y: 30, opacity: 0, duration: 0.8, ease: 'back.out(2)', scrollTrigger: { trigger: '#final', start: 'top 70%', once: true } });
    // step numbers spin in
    gsap.utils.toArray('.step-n').forEach((n) => gsap.from(n, { rotate: -180, scale: 0, duration: 0.8, ease: 'back.out(2)', scrollTrigger: { trigger: n, start: 'top 92%', once: true } }));
    // dark section: arenas panel grows in
    gsap.fromTo('#arenas', { borderRadius: 120, scale: 0.96 }, { borderRadius: 40, scale: 1, ease: 'none', scrollTrigger: { trigger: '#arenas', start: 'top 100%', end: 'top 55%', scrub: true } });
    // hero decoration drifts as you scroll
    gsap.to('.stickers', { yPercent: 25, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
    gsap.to('.stage', { y: -30, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
    // marquee: infinite loop that speeds up with scroll velocity
    const track = $('marquee');
    const loop = gsap.to(track, { xPercent: -25, duration: 22, ease: 'none', repeat: -1 });
    ScrollTrigger.create({ trigger: '.marquee', start: 'top bottom', end: 'bottom top', onUpdate: (s) => { const v = clamp(s.getVelocity() / 300, -6, 6); gsap.to(loop, { timeScale: 1 + Math.abs(v) * (s.direction > 0 ? 1 : 1), duration: 0.25, overwrite: true }); gsap.to(loop, { timeScale: 1, duration: 1.2, delay: 0.25 }); } });
    // the ring of text around the character slowly turns
    gsap.to('#ring', { rotate: 360, duration: 40, ease: 'none', repeat: -1, transformOrigin: '50% 50%' });
    // nav pill shadow after scrolling
    ScrollTrigger.create({ start: 60, onToggle: (s) => document.querySelector('.nav').style.boxShadow = s.isActive ? '0 4px 0 rgba(20,18,43,.9)' : 'none' });
  }

  function floaty() {
    if (!fine) return;
    // magnetic buttons
    document.querySelectorAll('.magnetic').forEach((b) => {
      const xt = gsap.quickTo(b, 'x', { duration: 0.5, ease: 'elastic.out(1,.5)' }), yt = gsap.quickTo(b, 'y', { duration: 0.5, ease: 'elastic.out(1,.5)' });
      b.addEventListener('pointermove', (e) => { const r = b.getBoundingClientRect(); xt((e.clientX - (r.left + r.width / 2)) * 0.18); yt((e.clientY - (r.top + r.height / 2)) * 0.28); });
      b.addEventListener('pointerleave', () => { xt(0); yt(0); });
    });
    // stickers follow the mouse a little (parallax)
    const st = gsap.utils.toArray('.sticker').map((s, i) => ({ x: gsap.quickTo(s, 'x', { duration: 0.9, ease: 'power3.out' }), y: gsap.quickTo(s, 'y', { duration: 0.9, ease: 'power3.out' }), d: 14 + i * 7 }));
    window.addEventListener('pointermove', (e) => { const nx = e.clientX / innerWidth - 0.5, ny = e.clientY / innerHeight - 0.5; st.forEach((s) => { s.x(nx * s.d * 2); s.y(ny * s.d * 2); }); }, { passive: true });
    // cast cards tilt toward the pointer
    document.querySelectorAll('.cast-card').forEach((c) => {
      const art = c.querySelector('.cast-art img');
      const rx = gsap.quickTo(art, 'x', { duration: 0.4, ease: 'power3.out' }), ry = gsap.quickTo(art, 'y', { duration: 0.4, ease: 'power3.out' });
      c.addEventListener('pointermove', (e) => { const r = c.getBoundingClientRect(); rx(((e.clientX - r.left) / r.width - 0.5) * 22); ry(((e.clientY - r.top) / r.height - 0.5) * 14); });
      c.addEventListener('pointerenter', () => gsap.to(art, { scale: 1.1, rotate: -4, duration: 0.45, ease: 'back.out(2)', overwrite: 'auto' }));
      c.addEventListener('pointerleave', () => { rx(0); ry(0); gsap.to(art, { scale: 1, rotate: 0, duration: 0.4, ease: 'power3.out', overwrite: 'auto' }); });
    });
  }


  /* ============================ accounts, modals, shop ============================ */
  const nav = { slot: $('acctSlot') };
  let toastTimer = null;
  function siteToast(msg) {
    let t = document.querySelector('.site-toast');
    if (!t) { t = el('div', 'site-toast'); document.body.appendChild(t); }
    t.textContent = msg; clearTimeout(toastTimer);
    gsap.fromTo(t, { y: 30, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.4, ease: 'back.out(2.4)', overwrite: true });
    toastTimer = setTimeout(() => gsap.to(t, { y: 20, opacity: 0, duration: 0.3 }), 3200);
  }
  App.toast = siteToast;

  async function api(url, body) {
    try {
      const r = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, j };
    } catch (e) { return { ok: false, status: 0, j: { error: 'Could not reach the server. Check your connection.' } }; }
  }

  let firstMe = true;
  async function loadMe() {
    const r = await api('/api/me');
    if (!r.ok) return;
    App.accountsEnabled = r.j.accounts !== false;
    setAccount(r.j.user || null, firstMe);
    firstMe = false;
  }
  function setAccount(u, restoreChar) {
    App.account = u;
    if (u && restoreChar && u.settings) {
      const i = CHARS.findIndex((c) => c.id === u.settings.c);
      if (i >= 0 && owns(i)) { sel.c = i; store.set('c', i); }
      if (Number.isInteger(u.settings.k) && u.settings.k >= 0 && u.settings.k < COLORS.length) { sel.k = u.settings.k; store.set('k', sel.k); }
    }
    if (!u && !owns(sel.c)) { sel.c = firstOwned(); store.set('c', sel.c); }
    paintAccount();
  }
  function paintAccount() {
    const u = App.account, on = App.accountsEnabled;
    // nav
    nav.slot.classList.toggle('hidden', !on);
    nav.slot.replaceChildren();
    if (on && u) {
      const chip = el('button', 'acct-chip'); chip.type = 'button'; chip.setAttribute('aria-label', 'Your account');
      chip.append(el('span', 'av', u.username[0].toUpperCase()), el('span', '', u.username), el('span', 'wins-badge', String(u.balance)));
      chip.addEventListener('click', openAcct); nav.slot.appendChild(chip);
    } else if (on) {
      const a = el('button', 'btn-nav', 'Log in'), b = el('button', 'btn-nav solid', 'Sign up'); a.type = b.type = 'button'; a.id = 'navLogin'; b.id = 'navSignup';
      a.addEventListener('click', () => openAuth('login')); b.addEventListener('click', () => openAuth('signup')); nav.slot.append(a, b);
    }
    // join form
    form.classList.toggle('is-acct', !!u);
    $('acctLine').classList.toggle('hidden', !u);
    $('guestNote').classList.toggle('hidden', !!u || !on);
    if (u) { $('acctName').textContent = u.username; $('acctWins').textContent = `${u.balance}`; }
    const adm = !!(u && u.admin); $('navAdmin').classList.toggle('hidden', !adm); $('acctAdmin').classList.toggle('hidden', !adm);
    paintStage(false); paintCast();
    if (shopOpen) paintShop();
    if (acctOpen) paintAcctModal();
  }
  App.onAward = (m) => { if (App.account) { App.account.wins = m.wins; App.account.balance = m.balance; App.account.spent = m.wins - m.balance; } };
  $('acctOut').addEventListener('click', logout);
  $('noteSignup').addEventListener('click', () => openAuth('signup'));
  $('navShop').addEventListener('click', () => openShop());
  async function logout() {
    await api('/api/logout', {});
    closeModal(); setAccount(null); siteToast('Logged out. See you next round!');
  }

  /* ---- modal plumbing ---- */
  const root = $('modalRoot'), back = $('modalBack');
  let modalId = null, opener = null, shopOpen = false, acctOpen = false;
  function openModal(id, focusEl) {
    if (modalId === id) return;
    if (modalId) { $(modalId).hidden = true; } else opener = document.activeElement;
    modalId = id; shopOpen = id === 'shopModal'; acctOpen = id === 'acctModal';
    const m = $(id); root.classList.remove('hidden'); m.hidden = false;
    document.body.style.overflow = 'hidden';
    if (!reduce) {
      gsap.fromTo(back, { opacity: 0 }, { opacity: 1, duration: 0.25 });
      gsap.fromTo(m, { y: 50, scale: 0.92, rotate: -1.5, opacity: 0 }, { y: 0, scale: 1, rotate: 0, opacity: 1, duration: 0.5, ease: 'back.out(1.8)', clearProps: 'transform,opacity' });
    }
    Sfx.play('click');
    setTimeout(() => (focusEl || m.querySelector('input, button:not(.modal-x)') || m).focus({ preventScroll: true }), 60);
  }
  function closeModal() {
    if (!modalId) return;
    const m = $(modalId); modalId = null; shopOpen = acctOpen = false; document.body.style.overflow = '';
    const done = () => { m.hidden = true; if (!modalId) root.classList.add('hidden'); };
    if (reduce) done(); else { gsap.to(m, { y: 24, scale: 0.96, opacity: 0, duration: 0.2, onComplete: () => { done(); gsap.set(m, { clearProps: 'all' }); } }); gsap.to(back, { opacity: 0, duration: 0.2 }); }
    if (opener && opener.focus) { try { opener.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }
  root.addEventListener('click', (e) => { if (e.target === back || e.target === root || e.target.closest('[data-close]')) closeModal(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modalId) closeModal(); });

  /* ---- log in / sign up ---- */
  const aForm = $('authForm'), aUser = $('authUser'), aPass = $('authPass'), aErr = $('authErr'), aGo = $('authGo');
  let mode = 'login', authBusy = false;
  function setAuthMode(m) {
    mode = m; const up = m === 'signup';
    $('authTitle').textContent = up ? 'Join Tag Rush' : 'Welcome back';
    aGo.querySelector('.btn-label').textContent = up ? 'Create account' : 'Log in';
    aPass.autocomplete = up ? 'new-password' : 'current-password';
    $('authFine').textContent = up ? 'Your username is your name in the game (3–14 letters or numbers). No email needed, so keep your password safe: there is no reset.' : 'Your username is your name in the game. Wins and unlocked characters are saved to it.';
    $('authTabs').querySelectorAll('button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.t === m)));
    aErr.textContent = '';
  }
  function openAuth(m) { setAuthMode(m || 'login'); aPass.value = ''; openModal('authModal', aUser); }
  $('authTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { setAuthMode(b.dataset.t); Sfx.play('click'); } });
  aForm.addEventListener('submit', async (e) => {
    e.preventDefault(); if (authBusy) return;
    const username = aUser.value.trim(), password = aPass.value;
    let err = '';
    if (mode === 'signup') { const v = C.validateUsername(username); if (!v.ok) err = v.err; else { const pv = C.validatePassword(password); if (!pv.ok) err = pv.err; } }
    else if (!username || !password) err = 'Enter your username and password.';
    if (err) { aErr.textContent = err; if (!reduce) gsap.fromTo(aGo, { x: -8 }, { x: 0, duration: 0.45, ease: 'elastic.out(1.2,.3)', clearProps: 'transform' }); Sfx.play('deny'); return; }
    authBusy = true; aGo.disabled = true; aErr.textContent = '';
    const r = await api(mode === 'signup' ? '/api/register' : '/api/login', { username, password });
    authBusy = false; aGo.disabled = false;
    if (!r.ok || !r.j.user) { aErr.textContent = r.j.error || 'Something went wrong.'; Sfx.play('deny'); return; }
    aPass.value = ''; closeModal(); setAccount(r.j.user, true);
    Sfx.play('ready'); siteToast(mode === 'signup' ? `Welcome, ${r.j.user.username}! You start with Fox, Ghost and Bear.` : `Welcome back, ${r.j.user.username}!`);
  });

  /* ---- account modal ---- */
  function paintAcctModal() {
    const u = App.account; if (!u) return;
    $('acctTitle').textContent = u.username; $('stWins').textContent = u.wins; $('stBal').textContent = u.balance;
    $('stOwned').textContent = `${CHARS.filter((_, i) => owns(i)).length}/${CHARS.length}`;
  }
  function openAcct() { if (!App.account) return openAuth('login'); paintAcctModal(); openModal('acctModal'); }
  $('acctShop').addEventListener('click', () => openShop());
  $('acctLogout').addEventListener('click', logout);

  /* ---- shop (data-driven: C.SHOP lists items; each type knows how to draw itself) ---- */
  const grid = $('shopGrid');
  const ownsItem = (item) => !!App.account && App.account.owned.includes(item.id);
  function shopCard(item) {
    const card = el('article', 'shop-item'); card.dataset.id = item.id;
    const art = el('div', 'shop-art'), body = el('div', 'shop-body'), buy = el('div', 'shop-buy');
    if (item.type === 'character') {
      const i = CHARS.findIndex((c) => c.id === item.ref), def = CHARS[i];
      art.style.setProperty('--c', STAGE[i]); const img = new Image(); img.alt = def.species; img.src = Chars.avatar(i, sel.k, 192); art.append(el('span', 'tag', 'Character'), img);
      const ab = el('div', 'ab'); ab.innerHTML = Chars.icon(def.fx); ab.append(el('span', '', `${def.ability} · ${def.cd}s`));
      body.append(el('h3', '', `${def.name} the ${def.species}`), ab, el('p', '', def.desc));
    } else { body.append(el('h3', '', item.name), el('p', '', item.blurb || '')); }
    const price = el('span', 'price', String(item.price)), btn = el('button', 'buy-btn'); btn.type = 'button';
    buy.append(price, btn); card.append(art, body, buy);
    btn.addEventListener('click', () => buyItem(item, card));
    return card;
  }
  function paintShop() {
    const u = App.account, items = App.shop || C.SHOP;
    $('shopBalance').querySelector('b').textContent = u ? u.balance : '–';
    $('shopNote').textContent = !App.accountsEnabled ? 'Accounts are offline right now, so the shop is closed.'
      : u ? 'You earn 1 ★ for every round you win in an online lobby with 3 or more players. New items will show up here over time.'
      : 'Log in or sign up to earn ★ wins and buy new characters. Guests can only play Fox, Ghost and Bear.';
    if (grid.children.length !== items.length) { grid.replaceChildren(...items.map(shopCard)); }
    grid.querySelectorAll('.shop-item').forEach((card) => {
      const item = items.find((x) => x.id === card.dataset.id), btn = card.querySelector('.buy-btn'), owned = ownsItem(item);
      card.classList.toggle('sold', owned); btn.className = 'buy-btn'; btn.disabled = false;
      if (owned) { btn.textContent = 'Owned ✓'; btn.classList.add('owned'); }
      else if (!u) btn.textContent = App.accountsEnabled ? 'Log in' : 'Locked';
      else if (u.balance < item.price) { btn.textContent = `${item.price - u.balance} more`; btn.classList.add('no'); }
      else btn.textContent = 'Buy';
    });
  }
  App.shop = C.SHOP;
  function openShop() { paintShop(); openModal('shopModal'); }
  let buying = false;
  async function buyItem(item, card) {
    if (buying || ownsItem(item)) return;
    if (!App.account) { if (App.accountsEnabled) openAuth('login'); return; }
    if (App.account.balance < item.price) { Sfx.play('deny'); if (!reduce) gsap.fromTo(card, { x: -6 }, { x: 0, duration: 0.4, ease: 'elastic.out(1.2,.3)', clearProps: 'transform' }); return; }
    buying = true;
    const r = await api('/api/shop/buy', { item: item.id });
    buying = false;
    if (r.j.user) App.account = r.j.user;
    if (!r.ok) { siteToast(r.j.error || 'Could not buy that.'); Sfx.play('deny'); paintAccount(); return; }
    Sfx.play('buy');
    if (item.type === 'character') { const i = CHARS.findIndex((c) => c.id === item.ref); if (i >= 0) { sel.c = i; store.set('c', i); } }
    paintAccount();
    if (!reduce) {
      const c2 = grid.querySelector(`[data-id="${item.id}"]`);
      if (c2) gsap.fromTo(c2, { scale: 0.92, rotate: -2 }, { scale: 1, rotate: 0, duration: 0.7, ease: 'elastic.out(1.2,.4)', clearProps: 'transform' });
    }
    siteToast(`Unlocked ${item.name}! It's selected for your next game.`);
  }


  /* ============================== news + leaderboard ============================== */
  const NEWS_VERSION = 'update-4';
  const NEWS = [
    { v: 'Update 4', tag: 'Newest', items: [
      ['A chat you can’t miss', 'A big Chat button with an unread badge (or just press Enter), quick-chat phrases like GG! and Run!, and a log that sticks around longer.'],
      ['Leaderboard', 'See the top 10 players by total wins. Open it from the menu or your account.'],
      ['Admin tools', 'Admins can announce messages in games, mute or ban troublemakers and show a banner on this page. Admin messages carry an ADMIN tag.'],
      ['This notice', 'Updates will be listed here from now on.'],
    ] },
    { v: 'Update 3', items: [
      ['Accounts', 'Sign up with a username and password to save your name, wins and characters. Guests can still jump straight in with Fox, Ghost and Bear.'],
      ['Shop', 'Win rounds in online lobbies (3+ players) to earn ★, then spend them on new characters. More shop items are coming.'],
      ['Chat replaces emotes', 'Press Enter to talk. Messages show above heads and in a log. Click a name to mute someone.'],
      ['3 new characters', 'Penguin (Belly Slide bowls people over), Raccoon (Swap places) and Bat (Echo Beacon: snap back to where you were).'],
      ['Character tweaks', 'Cat can pounce out of its cloak, Frog leaves a sticky splash when it lands, plus a balance pass on everyone.'],
      ['Smoother for far-away players', 'Bigger tag reach, lag compensation and faster updates make the game feel better with a high ping (like Australia to Singapore).'],
    ] },
  ];
  function buildNews() {
    const box = $('newsBody'); box.replaceChildren();
    for (const rel of NEWS) {
      const d = el('div', 'news-rel'), h = el('h3', '', rel.v); if (rel.tag) h.append(el('span', 'tag', rel.tag));
      const ul = el('ul');
      for (const [t, b] of rel.items) { const li = el('li'); li.append(el('b', '', t), document.createTextNode(b)); ul.append(li); }
      d.append(h, ul); box.append(d);
    }
  }
  const seenKey = 'newsSeen';
  const markSeen = () => { store.set(seenKey, NEWS_VERSION); $('newsDot').classList.add('hidden'); hideNewsCard(); };
  function hideNewsCard() { const c = $('newsCard'); if (c.classList.contains('hidden')) return; if (reduce) c.classList.add('hidden'); else gsap.to(c, { y: 30, opacity: 0, duration: 0.3, onComplete: () => c.classList.add('hidden') }); }
  function openNews() { buildNews(); markSeen(); openModal('newsModal'); }
  function initNews() {
    $('navNews').addEventListener('click', openNews); $('newsOpen').addEventListener('click', openNews);
    $('newsClose').addEventListener('click', markSeen);
    if (store.get(seenKey) !== NEWS_VERSION) {
      $('newsDot').classList.remove('hidden');
      setTimeout(() => {
        if (App.inGame || store.get(seenKey) === NEWS_VERSION) return;
        const c = $('newsCard'); c.classList.remove('hidden'); if (!reduce) gsap.fromTo(c, { y: 40, opacity: 0, scale: 0.92 }, { y: 0, opacity: 1, scale: 1, duration: 0.6, ease: 'back.out(1.8)' });
        setTimeout(hideNewsCard, 14000);          // tuck away on its own; the red dot on "What's new" stays until opened
      }, 3200);
    }
  }
  async function openBoard() {
    const list = $('boardList'); list.replaceChildren(el('li', 'empty', 'Loading…')); openModal('boardModal');
    const r = await api('/api/leaderboard');
    list.replaceChildren();
    const top = (r.j && r.j.top) || [];
    if (!top.length) list.append(el('li', 'empty', 'Nobody has won a round yet. Be the first!'));
    for (const t of top) { const li = el('li', App.account && App.account.username === t.username ? 'me' : ''); li.append(el('span', '', t.username), el('span', 'w', String(t.wins))); list.append(li); }
  }
  $('footNews').addEventListener('click', openNews); $('footBoard').addEventListener('click', openBoard);
  $('navBoard').addEventListener('click', openBoard); $('acctBoard').addEventListener('click', openBoard); $('newsBoard').addEventListener('click', openBoard);

  /* ================================== boot ================================== */
  function boot() {
    buildPicker(); buildCast(); buildArenas(); buildMarquee(); buildStickers();
    paintStage(false); paintCast();
    $('btnTop').addEventListener('click', () => { window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); setTimeout(() => nameEl.focus({ preventScroll: true }), 700); });
    document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => { const t = document.querySelector(a.getAttribute('href')); if (!t) return; e.preventDefault(); t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' }); }));
    let last = performance.now();
    gsap.ticker.add(() => { const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; drawPreview(dt, now / 1000); });
    if (!reduce) { scrollAnims(); floaty(); intro(); }
    loadMe(); pollStats(); setInterval(pollStats, 8000); initNews();
    gsap.ticker.lagSmoothing(0);
  }
  // wait for the fonts so SplitText measures the real line breaks
  const ready = (document.fonts && document.fonts.ready) ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]) : Promise.resolve();
  ready.then(boot);
})();
