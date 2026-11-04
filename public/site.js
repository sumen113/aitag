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
  const App = { sel, inGame: false };
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
    const v = C.validateName(nameEl.value);
    if (!v.ok) { showErr(v.err); nameEl.focus(); return; }
    showErr('');
    busy = true; $('btnPlay').disabled = $('btnBots').disabled = true;
    sel.name = v.name; store.set('name', v.name);
    Sfx.unlock(); Sfx.play('ready');
    await curtainIn();
    const slow = setTimeout(() => App.curtainMsg('Waking the server up… free hosting can take up to a minute.'), 3500);
    const res = await Game.join({ mode, diff: sel.diff, name: v.name, c: sel.c, k: sel.k });
    clearTimeout(slow); App.curtainMsg('');
    if (!res.ok) { await curtainOut(); showErr(res.err); busy = false; $('btnPlay').disabled = $('btnBots').disabled = false; return; }
    enterGame();
    await curtainOut();
    Game.begin();
    busy = false; $('btnPlay').disabled = $('btnBots').disabled = false;
  }
  form.addEventListener('submit', (e) => { e.preventDefault(); start('online'); });
  $('btnBots').addEventListener('click', () => start('bots'));

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
    window.scrollTo(0, 0); ScrollTrigger.refresh(); pollStats();
    await curtainOut();
    busy = false;
  };

  /* ============================= character stage =========================== */
  const pvc = $('preview'), pv = pvc.getContext('2d');
  const pic = $('picker'), sw = $('swatches');
  const hop = { air: 0, sq: 0 };

  function buildPicker() {
    CHARS.forEach((def, i) => {
      const b = el('button', 'pick'); b.type = 'button'; b.setAttribute('role', 'radio'); b.dataset.i = i; b.setAttribute('aria-label', def.species);
      const img = new Image(); img.alt = ''; b.appendChild(img);
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
    pic.querySelectorAll('.pick').forEach((b, i) => { b.setAttribute('aria-checked', String(i === sel.c)); b.querySelector('img').src = Chars.avatar(i, sel.k, 96); });
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
      card.append(art, info);
      card.addEventListener('click', () => { pick(i, true); window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); });
      grid.appendChild(card);
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

  /* ================================== boot ================================== */
  function boot() {
    buildPicker(); buildCast(); buildArenas(); buildMarquee(); buildStickers();
    paintStage(false);
    $('btnTop').addEventListener('click', () => { window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' }); setTimeout(() => nameEl.focus({ preventScroll: true }), 700); });
    document.querySelectorAll('a[href^="#"]').forEach((a) => a.addEventListener('click', (e) => { const t = document.querySelector(a.getAttribute('href')); if (!t) return; e.preventDefault(); t.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' }); }));
    let last = performance.now();
    gsap.ticker.add(() => { const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now; drawPreview(dt, now / 1000); });
    if (!reduce) { scrollAnims(); floaty(); intro(); }
    pollStats(); setInterval(pollStats, 8000);
    gsap.ticker.lagSmoothing(0);
  }
  // wait for the fonts so SplitText measures the real line breaks
  const ready = (document.fonts && document.fonts.ready) ? Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]) : Promise.resolve();
  ready.then(boot);
})();
