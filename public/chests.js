/* Chests, locker and the opening show. All the rules live on the server (src/chests.js); this file only draws them.
   Needs: shared.js (TagShared), chars.js, audio.js, site.js (App helpers), gsap. */
(() => {
  'use strict';
  const C = window.TagShared, CHARS = C.CHARS, A = window.App, el = A.el;
  const $ = (id) => document.getElementById(id);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const RAR = C.RARITIES;
  const st = { tab: 'chests', ch: 0, busy: false, tick: 0 };
  const acct = () => A.account;
  const owned = () => (acct() ? acct().owned : []);
  const chest = () => (acct() && acct().chest) || null;
  const modalOpen = () => !$('chestModal').hidden;
  const ROMAN = ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary'];

  /* ================================ chest art ================================ */
  const ART = {
    wood:   { body: '#c0803f', band: '#7a4a1f', lid: '#d29450', lock: '#ffd23f', gem: null },
    silver: { body: '#c4cde0', band: '#7b88a6', lid: '#dfe6f4', lock: '#6bb5ff', gem: '#6bb5ff' },
    gold:   { body: '#ffc928', band: '#b8780a', lid: '#ffdb5c', lock: '#ff4d5e', gem: '#ff4d5e' },
  };
  /** One chest as an inline SVG: the lid is its own group (class "lid") so it can swing open. */
  function chestSVG(tier, uid) {
    const a = ART[tier] || ART.wood, ink = '#1b1630';
    return `<svg class="cs" viewBox="0 0 200 170" aria-hidden="true" focusable="false">
      <ellipse cx="100" cy="162" rx="78" ry="8" fill="rgba(0,0,0,.22)"/>
      <g class="body">
        <rect x="22" y="82" width="156" height="76" rx="10" fill="${a.body}" stroke="${ink}" stroke-width="5"/>
        <rect x="52" y="82" width="16" height="76" fill="${a.band}" stroke="${ink}" stroke-width="4"/>
        <rect x="132" y="82" width="16" height="76" fill="${a.band}" stroke="${ink}" stroke-width="4"/>
        <rect x="22" y="132" width="156" height="8" fill="${a.band}" opacity=".35"/>
      </g>
      <g class="glow"><ellipse class="inner" cx="100" cy="84" rx="72" ry="10" fill="#fff" opacity="0"/></g>
      <g class="lid">
        <path d="M22 84 V62 Q22 28 100 28 Q178 28 178 62 V84 Z" fill="${a.lid}" stroke="${ink}" stroke-width="5" stroke-linejoin="round"/>
        <rect x="52" y="31" width="16" height="53" fill="${a.band}" stroke="${ink}" stroke-width="4" opacity=".95"/>
        <rect x="132" y="31" width="16" height="53" fill="${a.band}" stroke="${ink}" stroke-width="4" opacity=".95"/>
        <path d="M44 48 Q70 34 100 34" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" opacity=".45"/>
        <rect x="86" y="68" width="28" height="26" rx="6" fill="${a.lock}" stroke="${ink}" stroke-width="4.5"/>
        <circle cx="100" cy="79" r="4" fill="${ink}"/><rect x="98" y="80" width="4" height="9" rx="2" fill="${ink}"/>
        ${a.gem ? `<circle cx="38" cy="66" r="5" fill="${a.gem}" stroke="${ink}" stroke-width="3"/><circle cx="162" cy="66" r="5" fill="${a.gem}" stroke="${ink}" stroke-width="3"/>` : ''}
      </g>
    </svg>`;
  }
  const chestEl = (tier, cls) => { const d = el('div', 'chest-art ' + (cls || '')); d.innerHTML = chestSVG(tier); d.dataset.tier = tier; return d; };

  /* ================================= helpers ================================== */
  const skinImg = (ci, theme, size) => { const i = new Image(); i.alt = ''; i.draggable = false; i.src = Chars.avatar(ci, theme ? 0 : (A.sel.ks[ci] | 0), size, 0, theme || ''); return i; };
  const fmtLeft = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
  const oddsLine = (tier) => { const w = el('div', 'odds'); tier.odds.forEach((p, r) => { if (!p) return; const c = el('span', 'odd'); c.style.setProperty('--rc', RAR[r].col); c.title = RAR[r].name; c.append(el('i'), el('b', '', (p % 1 ? p.toFixed(1) : p) + '%')); w.appendChild(c); }); return w; };
  const need = (price) => { const u = acct(); return u ? Math.max(0, price - u.balance) : price; };
  function shake(node) { if (!reduce) gsap.fromTo(node, { x: -6 }, { x: 0, duration: 0.4, ease: 'elastic.out(1.2,.3)', clearProps: 'transform' }); }

  /* ================================== panels ================================== */
  function paintBank() {
    const u = acct(), c = chest();
    $('chWins').textContent = u ? u.balance : '–';
    $('chGlit').textContent = c ? c.glitter : '–';
  }

  function paintChests(panel) {
    const u = acct(), c = chest();
    // ---- daily
    const day = c ? c.dailyDay : 1, dTier = c ? c.dailyTier : 'wood', ready = !!(c && c.dailyReady);
    const daily = el('article', 'ch-daily' + (ready ? ' ready' : ''));
    const left = chestEl(dTier, 'sm' + (ready ? ' wiggle' : ''));
    const mid = el('div', 'ch-daily-mid');
    mid.append(el('p', 'mono kicker', 'Free every day'), el('h3', '', 'Daily chest'));
    const pips = el('div', 'pips'); pips.setAttribute('aria-label', `Day ${day} of ${C.DAILY.tiers.length}`);
    C.DAILY.tiers.forEach((t, i) => { const p = el('i', 'pip ' + t + (i + 1 < day ? ' done' : i + 1 === day ? ' now' : '')); p.title = `Day ${i + 1}: ${C.CHEST_TIERS[t].name}`; pips.appendChild(p); });
    mid.append(pips, el('p', 'ch-sub', c && c.streak ? `${c.streak}-day streak. Come back every day: day 7 is a Golden Chest.` : 'Claim one every day. Keep a streak going and the chest gets better: day 7 is a Golden Chest.'));
    const go = el('button', 'buy-btn ch-claim'); go.type = 'button';
    if (!u) go.textContent = 'Log in'; else if (ready) go.textContent = 'Claim'; else { go.classList.add('no'); go.dataset.cd = '1'; go.textContent = fmtLeft(c.nextDaily - Date.now()); }
    go.addEventListener('click', () => { if (!u) return A.openAuth('login'); if (ready) doOpen('daily'); });
    daily.append(left, mid, go); panel.appendChild(daily);

    // ---- paid chests
    const grid = el('div', 'ch-grid');
    for (const id of C.CHEST_ORDER) {
      const t = C.CHEST_TIERS[id], card = el('article', 'ch-card ' + id);
      const art = chestEl(id, 'lg');
      const btn = el('button', 'buy-btn'); btn.type = 'button';
      const price = el('span', 'price', String(t.price));
      if (!u) btn.textContent = 'Log in'; else if (u.balance < t.price) { btn.textContent = `${need(t.price)} more`; btn.classList.add('no'); } else btn.textContent = 'Open';
      btn.addEventListener('click', () => { if (!u) return A.openAuth('login'); if (u.balance < t.price) { Sfx.play('deny'); shake(card); return; } doOpen(id); });
      const foot = el('div', 'shop-buy'); foot.append(price, btn);
      const gifts = c ? c.gifts[id] : 0;
      if (gifts > 0) { const gb = el('button', 'buy-btn gift'); gb.type = 'button'; gb.textContent = `Open gift ×${gifts}`; gb.addEventListener('click', () => doOpen(id, true)); card.classList.add('has-gift'); foot.append(gb); }
      card.append(art, el('h3', '', t.name), el('p', 'ch-sub', t.blurb), oddsLine(t), el('p', 'ch-bonus', `+${t.glitter} glitter every time`), foot);
      grid.appendChild(card);
    }
    panel.appendChild(grid);

    // ---- pity + focus
    const info = el('div', 'ch-info');
    const bars = el('div', 'ch-pity');
    const bar = (label, v, max, col) => { const b = el('div', 'bar'); b.append(el('span', 'mono', label), (() => { const t = el('div', 'track'); const f = el('i'); f.style.width = Math.min(100, (v / max) * 100) + '%'; f.style.background = col; t.appendChild(f); return t; })(), el('b', '', `${Math.min(v, max)}/${max}`)); return b; };
    bars.append(bar('Epic guarantee', c ? c.sinceE : 0, C.PITY.epic, RAR[3].col), bar('Legendary guarantee', c ? c.sinceL : 0, C.PITY.legendary, RAR[4].col),
      el('p', 'ch-sub', 'Every chest fills the bars (wooden 1, silver 2, golden 4). When a bar is full, your next chest is guaranteed to have an epic or better (or a legendary). Pulling one empties the bar.'));
    const foc = el('label', 'ch-focus'); foc.append(el('span', 'mono', 'Aim your chests at'));
    const sl = el('select'); sl.setAttribute('aria-label', 'Favourite character'); sl.disabled = !u;
    sl.append(new Option('Any character', ''), ...CHARS.map((d) => new Option(`${d.name} the ${d.species}`, d.id)));
    sl.value = c ? c.focus : ''; sl.addEventListener('change', async () => { const r = await A.api('/api/chest/focus', { char: sl.value }); if (r.j.user) A.account = r.j.user; if (!r.ok) A.toast(r.j.error || 'Could not set that.'); else { A.toast(sl.value ? 'Chests now favour that character (4x as likely).' : 'Chests are open to every character again.'); Sfx.play('click'); } paintAll(); });
    foc.append(sl, el('em', '', 'The character you pick shows up 4x as often in what you pull.'));
    info.append(bars, foc); panel.appendChild(info);
  }

  /** locker: pick a character on top, then its 12 skins */
  function paintLocker(panel) {
    const u = acct(), have = owned();
    const strip = el('div', 'lk-strip'); strip.setAttribute('role', 'tablist'); strip.setAttribute('aria-label', 'Character');
    CHARS.forEach((d, i) => {
      const n = C.SKIN_THEMES.filter((t) => C.ownsSkin(have, d.id, t.id)).length;
      const b = el('button', 'lk-char' + (i === st.ch ? ' on' : '')); b.type = 'button'; b.setAttribute('aria-label', `${d.species}, ${n} of ${C.SKIN_THEMES.length} skins`); b.setAttribute('aria-selected', String(i === st.ch));
      b.append(skinImg(i, A.sel.skinOf(i), 72), el('em', n ? 'has' : '', `${n}/${C.SKIN_THEMES.length}`));
      b.addEventListener('click', () => { st.ch = i; Sfx.play('click'); paintAll(); });
      strip.appendChild(b);
    });
    panel.appendChild(strip);
    const d = CHARS[st.ch], cur = A.sel.skinOf(st.ch);
    const head = el('div', 'lk-head'); head.append(el('h3', '', `${d.name} the ${d.species}`), el('p', 'ch-sub', u ? 'Tap a skin you own to wear it. Locked ones can be crafted with glitter.' : 'Log in to collect skins. Here is everything you can win.'));
    panel.appendChild(head);
    const grid = el('div', 'lk-grid');
    const card = (theme) => {
      const th = theme ? C.SKIN_THEME_BY_ID[theme] : null, own = !theme || C.ownsSkin(have, d.id, theme), on = cur === (theme || '');
      const rc = th ? RAR[th.rarity].col : '#9fb0d8';
      const k = el('article', 'lk-card' + (own ? ' own' : ' locked') + (on ? ' on' : '')); k.style.setProperty('--rc', rc);
      const art = el('div', 'lk-art'); art.appendChild(skinImg(st.ch, theme, 120));
      if (!own) art.appendChild(el('span', 'lk-lock', '🔒'));
      const nm = el('h4', '', theme ? C.skinName(d.id, theme) : 'Default'); const rr = el('span', 'lk-rar', theme ? RAR[th.rarity].name : 'Free');
      const btn = el('button', 'buy-btn'); btn.type = 'button';
      if (own) { btn.textContent = on ? 'Wearing ✓' : 'Wear'; if (on) btn.classList.add('owned'); btn.addEventListener('click', () => { if (on) return; A.equipSkin(st.ch, theme); Sfx.play('equip'); A.toast(theme ? `${C.skinName(d.id, theme)} equipped.` : 'Back to the default look.'); paintAll(); }); }
      else {
        const cost = C.GLITTER_CRAFT[th.rarity], g = chest() ? chest().glitter : 0;
        btn.textContent = `Craft ✦${cost}`; if (!u || g < cost) btn.classList.add('no');
        btn.addEventListener('click', () => { if (!u) return A.openAuth('login'); if (g < cost) { Sfx.play('deny'); shake(k); A.toast(`${cost - g} more glitter needed. Duplicates and every chest give you some.`); return; } doCraft(C.skinId(d.id, theme), k); });
      }
      k.append(art, nm, rr, btn); return k;
    };
    grid.appendChild(card(''));
    C.SKIN_THEMES.slice().sort((a, b) => a.rarity - b.rarity).forEach((t) => grid.appendChild(card(t.id)));
    panel.appendChild(grid);
    panel.appendChild(el('p', 'ch-sub lk-foot', `Crafting costs ✦${C.GLITTER_CRAFT.join(' / ✦')} glitter (common to legendary). A duplicate skin turns into ✦${C.GLITTER_DUP.join(' / ✦')}.`));
  }

  function paintAll() {
    paintBank();
    const dot = $('chestDot'); if (dot) dot.classList.toggle('hidden', !(chest() && (chest().dailyReady || chest().gifts.wood + chest().gifts.silver + chest().gifts.gold > 0) && !A.inGame));
    if (!modalOpen()) return;
    const panel = $('chPanel');
    $('chTabs').querySelectorAll('button').forEach((b) => { const on = b.dataset.t === st.tab; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    const keep = panel.scrollTop;
    panel.replaceChildren();
    if (st.tab === 'locker') paintLocker(panel); else paintChests(panel);
    panel.scrollTop = keep;
    startTick();
  }
  function startTick() {
    clearInterval(st.tick); st.tick = 0;
    const c = chest(); if (!modalOpen() || !c || c.dailyReady) return;
    st.tick = setInterval(() => {
      if (!modalOpen()) { clearInterval(st.tick); return; }
      const b = document.querySelector('.ch-claim[data-cd]'), left = chest() ? chest().nextDaily - Date.now() : 0;
      if (left <= 0) { clearInterval(st.tick); refreshMe(); } else if (b) b.textContent = fmtLeft(left);
    }, 1000);
  }
  async function refreshMe() { const r = await A.api('/api/me'); if (r.ok && r.j.user) { A.account = r.j.user; A.repaint(); } }

  /* ================================== actions ================================== */
  async function doOpen(tierId, gift) {
    if (st.busy) return; st.busy = true;
    const r = await A.api(tierId === 'daily' ? '/api/chest/daily' : '/api/chest/open', tierId === 'daily' ? {} : { tier: tierId, gift: !!gift });
    st.busy = false;
    if (r.j.user) A.account = r.j.user;
    if (!r.ok) { A.toast(r.j.error || 'Could not open that.'); Sfx.play('deny'); A.repaint(); return; }
    const tier = r.j.result.tier;
    reveal(r.j, { again: tierId === 'daily' ? null : tierId, tier, daily: tierId === 'daily', gift: !!gift });
  }
  async function doCraft(skinId, node) {
    if (st.busy) return; st.busy = true;
    const r = await A.api('/api/chest/craft', { skin: skinId });
    st.busy = false;
    if (r.j.user) A.account = r.j.user;
    if (!r.ok) { A.toast(r.j.error || 'Could not craft that.'); Sfx.play('deny'); A.repaint(); return; }
    Sfx.play('craft');
    const sk = C.SKIN_BY_ID[skinId];
    A.repaint();
    reveal({ result: { tier: 'craft', rarity: sk.rarity, skin: skinId, dup: false, glitter: 0, pity: '' }, user: r.j.user, chest: r.j.chest, crafted: true }, { again: null, tier: 'craft' });
  }

  /* ================================= the show ================================== */
  let live = null;
  function reveal(res, o) {
    if (live) live.kill();
    const r = res.result, sk = C.SKIN_BY_ID[r.skin], th = C.SKIN_THEME_BY_ID[sk.theme], rar = RAR[r.rarity], ci = CHARS.findIndex((d) => d.id === sk.char);
    const crafted = !!res.crafted, tier = crafted ? 'gold' : o.tier;
    const ov = el('div', 'cr'); ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-label', 'Chest opening'); ov.style.setProperty('--rc', rar.col);
    const rays = el('div', 'cr-rays'), flash = el('div', 'cr-flash'), fx = el('div', 'cr-fx'), stage = el('div', 'cr-stage');
    const chestNode = chestEl(tier, 'cr-chest'), glow = el('div', 'cr-glow');
    const card = el('div', 'cr-card'), inner = el('div', 'cr-card-in'); card.appendChild(inner);
    const cv = el('canvas', 'cr-cv'); cv.width = 320; cv.height = 300;
    const badge = el('span', 'cr-badge', rar.name), nm = el('h3', 'cr-name', sk.name);
    const sub = el('p', 'cr-sub', crafted ? 'Crafted!' : r.dup ? 'Duplicate' : 'New skin!');
    const gl = el('p', 'cr-gl'); const glNum = el('b', '', '0');
    if (r.glitter) { gl.append('✦ ', glNum, ' glitter', el('span', '', r.dup ? ` (duplicate bonus included)` : '')); }
    const pity = el('p', 'cr-pity', r.pity ? (r.pity === 'legendary' ? 'Legendary guarantee!' : 'Epic guarantee!') : '');
    inner.append(badge, cv, nm, sub, gl, pity);
    const btns = el('div', 'cr-btns');
    const mk = (cls, txt, fn) => { const b = el('button', cls, txt); b.type = 'button'; b.addEventListener('click', fn); return b; };
    const wearing = () => A.sel.skinOf(ci) === th.id;
    const eq = mk('buy-btn eq', 'Wear it', () => { A.equipSkin(ci, th.id); Sfx.play('equip'); eq.textContent = 'Wearing ✓'; eq.classList.add('owned'); });
    const giftsLeft = o.gift && chest() ? chest().gifts[o.again] : 0;
    const again = o.gift ? (giftsLeft > 0 ? mk('buy-btn again', `Open another gift · ${giftsLeft} left`, () => { close(true); doOpen(o.again, true); }) : null) : o.again && acct() && acct().balance >= C.CHEST_TIERS[o.again].price ? mk('buy-btn again', `Open another · ★${C.CHEST_TIERS[o.again].price}`, () => { close(true); doOpen(o.again); }) : null;
    const done = mk('btn-nav done', 'Done', () => close());
    btns.append(...[!r.dup || crafted ? eq : null, again, done].filter(Boolean));
    stage.append(glow, chestNode, card);
    ov.append(el('div', 'cr-bg'), rays, stage, fx, flash, btns);
    const hint = el('p', 'cr-hint mono', crafted ? '' : 'tap to skip'); ov.appendChild(hint);
    document.body.appendChild(ov); document.body.style.overflow = 'hidden';
    const prevFocus = document.activeElement;

    // the character on the card, drawn live so the skin animates
    const g = cv.getContext('2d'), vis = { pose: { up: 0, rot: 0, sq: 0 } }, f = Chars.fit(ci, 0), sc = Math.min(5.2, 280 / f.w, 230 / -f.y0), t0 = performance.now();
    let raf = 0, alive = true, shown = false;
    const lop = () => {
      if (!alive) return;
      g.clearRect(0, 0, 320, 300);
      if (shown) { const t = (performance.now() - t0) / 1000; g.save(); Chars.draw(g, ci, { x: 160 - f.cx * sc, y: 262, s: sc, face: 1, lx: Math.sin(t * 0.8) * 0.5, ly: 0.05, t, spd: 0, skin: th.id, pose: vis.pose }); g.restore(); }
      raf = requestAnimationFrame(lop);
    };
    lop();

    const burst = (n, spread) => {
      const cols = [rar.col, '#fff', ...th.trail.c, rar.col];
      for (let i = 0; i < n; i++) {
        const p = el('i', 'cr-p'), s = 6 + Math.random() * 9; p.style.cssText = `width:${s}px;height:${s * (Math.random() < 0.5 ? 1 : 0.5)}px;background:${cols[i % cols.length]}`;
        fx.appendChild(p);
        const a = Math.random() * Math.PI * 2, d = (0.35 + Math.random() * 0.65) * spread;
        gsap.fromTo(p, { x: 0, y: 40, rotation: 0, autoAlpha: 1, scale: 1 }, { x: Math.cos(a) * d, y: Math.sin(a) * d * 0.8 - 120, rotation: (Math.random() - 0.5) * 720, scale: 0.3, autoAlpha: 0, duration: 1 + Math.random() * 0.9, ease: 'power3.out', onComplete: () => p.remove() });
      }
    };
    const tick = (name, a) => Sfx.play(name, a);

    function finish() {
      shown = true; Chars.pose(vis, CHARS[ci].fx, 1);
      if (r.glitter) { const v = { n: 0 }; gsap.to(v, { n: r.glitter, duration: Math.min(1.4, 0.4 + r.glitter / 80), ease: 'power1.out', onUpdate: () => { glNum.textContent = String(Math.round(v.n)); }, onComplete: () => { glNum.textContent = String(r.glitter); } }); for (let i = 0; i < 4; i++) setTimeout(() => tick('glitter'), i * 140); }
    }

    let tl;
    if (reduce) {
      gsap.set([chestNode, glow, rays, flash], { autoAlpha: 0 }); gsap.set(card, { autoAlpha: 1, y: -30 }); gsap.set(btns, { autoAlpha: 1 });
      tick('reveal' + r.rarity); finish();
    } else {
      const lid = chestNode.querySelector('.lid'), inn = chestNode.querySelector('.inner');
      const shakes = 3 + r.rarity, cols = RAR.map((x) => x.col);
      gsap.set(lid, { svgOrigin: '24 84' }); gsap.set(card, { autoAlpha: 0, transformPerspective: 900 }); gsap.set([nm, sub, gl, pity, badge], { autoAlpha: 0 }); gsap.set(btns, { autoAlpha: 0 }); gsap.set(rays, { autoAlpha: 0, scale: 0.3 }); gsap.set(flash, { autoAlpha: 0 });
      gsap.set(glow, { autoAlpha: 0, scale: 0.4 }); gsap.set(hint, { autoAlpha: 0 });
      tl = gsap.timeline();
      tl.fromTo(chestNode, { y: -520, scale: 0.9, rotation: -6 }, { y: 0, scale: 1, rotation: 0, duration: 0.6, ease: 'bounce.out' })
        .call(() => tick('chestThud'), null, 0.32)
        .to(hint, { autoAlpha: 0.7, duration: 0.3 }, 0.4)
        .to(glow, { autoAlpha: 0.5, scale: 1, duration: 0.5, ease: 'power2.out' }, 0.5);
      for (let i = 0; i < shakes; i++) {
        const k = i / shakes, a = 4 + i * 2.4, last = i === shakes - 1, col = last ? rar.col : cols[(i * 2 + 1) % cols.length];
        tl.call(() => { tick('chestShake', i); glow.style.setProperty('--gc', col); }, null, '+=0.1')
          .to(chestNode, { rotation: a, y: -4 - i, scale: 1 + k * 0.04, duration: 0.07, ease: 'power1.out' })
          .to(chestNode, { rotation: -a, duration: 0.09, yoyo: true, repeat: 3 + i, ease: 'sine.inOut' })
          .to(chestNode, { rotation: 0, y: 0, duration: 0.1, ease: 'power2.out' })
          .to(glow, { scale: 1 + k * 0.7, autoAlpha: 0.45 + k * 0.5, duration: 0.2 }, '<');
      }
      tl.addLabel('open', '+=0.22')
        .call(() => { tick('chestOpen'); burst([16, 26, 40, 60, 90][r.rarity], [260, 320, 400, 480, 560][r.rarity]); }, null, 'open')
        .to(lid, { rotation: -108, duration: 0.34, ease: 'back.out(2.2)' }, 'open')
        .to(inn, { opacity: 1, duration: 0.1 }, 'open')
        .to(chestNode, { scale: 1.12, duration: 0.12, yoyo: true, repeat: 1 }, 'open')
        .fromTo(flash, { autoAlpha: 0.95 }, { autoAlpha: 0, duration: 0.55, ease: 'power2.out', immediateRender: false }, 'open')
        .to(rays, { autoAlpha: 1, scale: 1, duration: 0.5, ease: 'power2.out' }, 'open')
        .to(glow, { autoAlpha: 1, scale: 2.1, duration: 0.5, ease: 'power2.out' }, 'open');
      if (r.rarity >= 3) tl.to(stage, { x: 'random(-9,9)', y: 'random(-7,7)', duration: 0.05, repeat: 9, yoyo: true, clearProps: 'x,y' }, 'open+=0.05');
      tl.set(card, { autoAlpha: 1 }, 'open+=0.3')
        .fromTo(card, { y: 40, scale: 0.25, rotationY: 180 }, { y: -36, scale: 1, rotationY: 0, duration: 0.85, ease: 'back.out(1.5)' }, 'open+=0.3')
        .to(chestNode, { y: 70, autoAlpha: 0, duration: 0.5, ease: 'power2.in' }, 'open+=0.5')
        .call(() => { tick('reveal' + r.rarity); finish(); if (r.rarity >= 3) burst(r.rarity === 4 ? 70 : 40, 520); }, null, 'open+=0.95')
        .fromTo(badge, { autoAlpha: 0, y: -14, scale: 0.6 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.4, ease: 'back.out(3)' }, 'open+=1')
        .fromTo(nm, { autoAlpha: 0, y: 14 }, { autoAlpha: 1, y: 0, duration: 0.35 }, 'open+=1.12')
        .fromTo(sub, { autoAlpha: 0, scale: 0.7 }, { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'back.out(3)' }, 'open+=1.25')
        .fromTo(gl, { autoAlpha: 0, y: 10 }, { autoAlpha: 1, y: 0, duration: 0.35 }, 'open+=1.45')
        .fromTo(pity, { autoAlpha: 0, scale: 0.6 }, { autoAlpha: 1, scale: 1, duration: 0.4, ease: 'back.out(3)' }, 'open+=1.6')
        .to(btns, { autoAlpha: 1, duration: 0.3 }, 'open+=1.8')
        .to(hint, { autoAlpha: 0, duration: 0.2 }, 'open')
        .to(rays, { rotation: 360, duration: 24, ease: 'none', repeat: -1 }, 'open');
      ov.addEventListener('click', (e) => { if (!e.target.closest('.cr-btns') && tl && tl.time() < tl.labels.open + 1.8) tl.timeScale(4); });
    }
    function close(quiet) {
      alive = false; cancelAnimationFrame(raf); if (tl) tl.kill(); live = null;
      gsap.to(ov, { autoAlpha: 0, duration: quiet || reduce ? 0.01 : 0.25, onComplete: () => { ov.remove(); if (!document.querySelector('.cr')) document.body.style.overflow = modalOpen() || $('modalRoot') && !$('modalRoot').classList.contains('hidden') ? 'hidden' : ''; } });
      window.removeEventListener('keydown', onKey, true);
      try { prevFocus && prevFocus.focus({ preventScroll: true }); } catch (e) { /* gone */ }
      A.repaint();
    }
    const onKey = (e) => { if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (tl && tl.time() < tl.labels.open + 1.8) tl.timeScale(4); else if (e.key === 'Escape') close(); } };
    window.addEventListener('keydown', onKey, true);
    live = { kill: () => close(true) };
    setTimeout(() => (btns.querySelector('.done') || ov).focus && btns.querySelector('.done').focus({ preventScroll: true }), 50);
  }

  /* ================================== wiring ================================== */
  $('chTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; st.tab = b.dataset.t; Sfx.play('click'); paintAll(); });
  A.chests = {
    open(tab, ci) { st.tab = tab === 'locker' ? 'locker' : 'chests'; if (Number.isInteger(ci)) st.ch = ci; A.openModal('chestModal'); paintAll(); if (!acct() && A.accountsEnabled === false) A.toast('Accounts are offline right now.'); },
    refresh: paintAll,
    reveal: (res, o) => reveal(res, o || {}),   // used by tests
  };
  paintAll();
})();
