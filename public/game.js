/* Tag Rush · game client: netcode (prediction + interpolation), rendering, HUD, input.
   The website layer (site.js) calls Game.join / show / begin / leave. */
(() => {
  'use strict';
  const C = TagShared;
  const { CHARS, STATE, DT } = C;
  const $ = (id) => document.getElementById(id);
  const clamp = C.clamp, TAU = Math.PI * 2;
  const q2 = (v) => Math.round(v * 100) / 100;
  const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
  const DUST = { park: '#d9c58e', neon: '#5cf2ff', frost: '#ffffff', candy: '#ff9cc8', station: '#aab4d8', city: '#b9bcc6', reef: '#e8fdff', factory: '#b9bcc6', pinball: '#ffd666' };
  const FONT = "'Bricolage Grotesque', system-ui, sans-serif";
  const touchy = window.matchMedia && matchMedia('(pointer: coarse)').matches;

  /* ================================ state ================================== */
  const G = {
    ws: null, inGame: false, id: 0, solo: false, diff: 'normal', sel: { name: '', c: 0, k: 0 },
    roster: new Map(), map: null, ctx: { map: null, goos: [] },
    me: null, px: 0, py: 0, pending: [], seq: 0, sendBuf: [], acc: 0, err: { x: 0, y: 0 },
    snaps: [], offset: null, goos: [], decoys: [], decoysAt: 0, seeds: [], seedsAt: 0, uiOff: false,
    state: STATE.WAIT, tl: 0, tlAt: 0, rd: 0, itId: 0, res: null, mode: 'classic', pt: new Map(), ptAt: 0, voteDur: 14,
    cam: { x: 0, y: 0 }, zoom: 1, zoomT: 1, shake: 0, camSnap: true,
    vis: new Map(), bubbles: new Map(), muted: new Set(), acct: false, t: 0, ping: 0, jit: 0, snapInt: 33, lastArr: 0, lastTs: 0, delay: 100, lastSend: 0,
    W: 0, H: 0, dpr: 1, g: null,
    abilityQueued: false, keys: {}, joy: { active: false, id: -1, x: 0, y: 0, ox: 0, oy: 0 },
    lastBoard: 0, lastCount: -1, lastSecTick: -1, sendTimer: 0, boardOrder: '', wasReady: true, kicked: null, joinResolve: null,
  };
  const Game = (window.Game = {});

  /* ============================== networking =============================== */
  function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }
  function send(o) { if (G.ws && G.ws.readyState === 1) G.ws.send(JSON.stringify(o)); }
  function closeWs() { const ws = G.ws; G.ws = null; if (ws) { try { ws.close(); } catch (e) { /* noop */ } } }

  /** Open a socket and join. Resolves {ok:true} once the server says init, or {ok:false, err}. */
  Game.join = (o) => new Promise((resolve) => {
    closeWs();
    G.sel = { name: o.name, c: o.c, k: o.k, h: o.h | 0 }; G.solo = o.mode === 'bots'; G.diff = o.diff; G.kicked = null;
    let ws, settled = false;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(to); G.joinResolve = null; resolve(r); };
    try { ws = new WebSocket(wsUrl()); } catch (e) { return resolve({ ok: false, err: 'Could not connect to the server.' }); }
    const to = setTimeout(() => { if (!settled) { if (G.ws === ws) G.ws = null; try { ws.close(); } catch (e) { /* noop */ } done({ ok: false, err: 'The server took too long to answer. Please try again.' }); } }, 50000);
    G.ws = ws; G.joinResolve = done;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'join', mode: o.mode, diff: o.diff, name: o.name, c: o.c, k: o.k, ks: o.ks, h: o.h | 0, server: o.server, pass: o.pass, create: o.create }));
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch (x) { return; } if (G.ws === ws) onMessage(m); };
    ws.onclose = () => {
      if (G.ws !== ws) return;
      G.ws = null;
      if (!settled) done({ ok: false, err: 'Could not connect to the server.' });
      else if (G.inGame) overlay(G.kicked || 'Connection lost.');
    };
    ws.onerror = () => {};
  });

  function onMessage(m) {
    switch (m.t) {
      case 'init': onInit(m); if (G.joinResolve) G.joinResolve({ ok: true }); break;
      case 'roster': onRoster(m.ps); break;
      case 's': onSnapshot(m); break;
      case 'ev': for (const e of m.e) onEvent(e); break;
      case 'pg': { const rtt = performance.now() - m.ts; G.ping = G.ping ? G.ping * 0.7 + rtt * 0.3 : rtt; $('ping').textContent = Math.round(G.ping); break; }
      case 'err': { const f = G.joinResolve, ws = G.ws; G.ws = null; try { ws && ws.close(); } catch (e) { /* noop */ } if (f) f({ ok: false, err: m.m }); else overlay(m.m); break; }
      case 'kick': G.kicked = m.m; break;
      case 'award': onAward(m); break;
      case 'announce': onAnnounce(m); break;
      default: break;
    }
  }

  function onInit(m) {
    G.sv = m.sv || null;
    G.id = m.id; G.solo = !!m.solo; G.acct = !!m.acct; if (m.name) G.sel.name = m.name;
    G.roster.clear(); onRoster(m.roster);
    G.me = null; G.pending = []; G.seq = 0; G.sendBuf = []; G.snaps = []; G.offset = null; G.err.x = G.err.y = 0; G.acc = 0;
    G.vis.clear(); G.bubbles.clear(); G.muted.clear(); G.res = null; G.jit = 0; G.snapInt = 33; G.lastArr = 0; G.delay = 100; G.lastSend = 0; G.state = STATE.WAIT; G.lastCount = -1; G.boardOrder = ''; G.mode = 'classic'; G.pt = new Map(); hideVote(true); G.goos = []; G.decoys = []; G.ctx.goos = G.goos;
    rowEls.forEach((e) => e.remove()); rowEls.clear();
    setMap(C.MAP_BY_ID[m.map]);
    G.inGame = true; G.camSnap = true;
    const def = CHARS[G.sel.c];
    $('abIcon').innerHTML = Chars.icon(def.fx); $('abName').textContent = def.ability;
    $('feed').innerHTML = ''; $('toasts').innerHTML = ''; $('results').classList.add('hidden'); $('overlay').classList.add('hidden');
    $('chatLog').innerHTML = ''; closeChat(true); setUnread(0); lastAbLabel = '';
    const co = $('chatOpen'); co.classList.remove('nudge'); void co.offsetWidth; co.classList.add('nudge');
  }

  function onRoster(list) {
    const seen = new Set();
    for (const p of list) {
      seen.add(p.id);
      const r = G.roster.get(p.id);
      if (r) Object.assign(r, p); else G.roster.set(p.id, Object.assign({ sc: 0, tg: 0, fl: 0 }, p));
    }
    for (const id of [...G.roster.keys()]) if (!seen.has(id)) { G.roster.delete(id); G.vis.delete(id); }
    const humans = [...G.roster.values()].filter((r) => !r.b).length;
    if (G.solo) { $('lobbyCount').textContent = 'Practice'; $('lobbyLbl').textContent = '· ' + G.diff; }
    else { $('lobbyCount').textContent = humans + '/' + (G.sv ? G.sv.max : C.MAX_PLAYERS); $('lobbyLbl').textContent = G.sv && !G.sv.regular ? '· ' + G.sv.name : 'players'; }
  }

  function setMap(map) {
    G.map = map; G.ctx.map = map; Particles.clear(); G.camSnap = true;
    $('mapName').textContent = map.name;
  }

  function onSnapshot(m) {
    const prev = G.state;
    G.state = m.s; G.tl = m.tl; G.tlAt = performance.now(); G.rd = m.rd; G.itId = m.it; G.res = m.res || null;
    G.mode = m.md || 'classic'; G.pt = new Map((m.pt || []).map((a) => [a[0], a[1]])); G.ptAt = performance.now();
    if (!G.map || G.map.id !== m.m) setMap(C.MAP_BY_ID[m.m]);
    const now = performance.now(), o = m.ts - now;
    if (G.lastArr) {                                    // measure arrival jitter -> adaptive interpolation delay
      const gap = m.ts - G.lastTs, arr = now - G.lastArr;
      if (gap > 0 && gap < 250) { G.snapInt += (clamp(gap, 12, 100) - G.snapInt) * 0.05; G.jit += (Math.min(120, Math.abs(arr - gap)) - G.jit) * 0.05; }
    }
    G.lastArr = now; G.lastTs = m.ts;
    G.delay += (clamp(2 * G.snapInt + 3 * G.jit + 10, 70, 190) - G.delay) * 0.02;
    G.offset = G.offset === null ? o : (o > G.offset ? o : G.offset + (o - G.offset) * 0.03);
    const by = new Map(); for (const e of m.p) by.set(e[0], e);
    G.snaps.push({ ts: m.ts, by }); if (G.snaps.length > 24) G.snaps.shift();
    for (const e of m.p) { const r = G.roster.get(e[0]); if (r) { r.sc = e[9]; r.tg = e[10]; r.fl = e[7]; } }
    G.goos = m.g.map((a) => ({ id: a[0], x: a[1], y: a[2], r: a[3], o: a[4], ttl: a[5], s: a[6] }));
    G.ctx.goos = G.goos;
    G.seeds = (m.sd || []).map((a) => ({ id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], o: a[5] })); G.seedsAt = now;
    G.decoys = m.d.map((a) => ({ id: a[0], x: a[1], y: a[2], vx: a[3], vy: a[4], c: a[5], k: a[6], o: a[7], ttl: a[8] })); G.decoysAt = now;
    if (G.vis.size > 40) { const live = new Set(G.decoys.map((d) => 'd' + d.id)); for (const k of [...G.vis.keys()]) if (typeof k === 'string' && !live.has(k)) G.vis.delete(k); }

    if (!G.me) {
      G.me = C.newSim(G.id, G.sel.c, 0, 0); C.unpackSim(G.me, m.me); G.px = G.me.x; G.py = G.me.y; G.camSnap = true;
    } else {
      while (G.pending.length && G.pending[0].s <= m.ack) G.pending.shift();
      const a = clamp(G.acc / DT, 0, 1);
      const vx = G.px + (G.me.x - G.px) * a + G.err.x, vy = G.py + (G.me.y - G.py) * a + G.err.y;
      C.unpackSim(G.me, m.me);
      const zero = { x: 0, y: 0, a: 0 };
      for (const i of G.pending) C.stepPlayer(G.me, G.state === STATE.COUNT ? zero : i, G.ctx, null);
      G.px = G.me.x; G.py = G.me.y;
      const ex = vx - G.me.x, ey = vy - G.me.y;
      if (Math.hypot(ex, ey) > 140) { G.err.x = G.err.y = 0; G.camSnap = Math.hypot(ex, ey) > 500; } else { G.err.x = ex; G.err.y = ey; }
    }
    if (m.s === STATE.VOTE && m.vc) updateVote(m.vc, m.vt);
    else if (prev === STATE.VOTE) hideVote();
    if (m.s === STATE.RESULTS && prev !== STATE.RESULTS) showResults();
    if (m.s !== STATE.RESULTS && prev === STATE.RESULTS) hideResults();
  }

  const srvNow = () => performance.now() + (G.offset || 0);

  function interp(id, rt) {
    const S = G.snaps; if (!S.length) return null;
    let i = S.length - 1; while (i > 0 && S[i].ts > rt) i--;
    const sa = S[i], sb = S[i + 1], a = sa.by.get(id), b = sb ? sb.by.get(id) : null;
    if (a && b) {
      const t = clamp((rt - sa.ts) / (sb.ts - sa.ts || 1), 0, 1);
      return { x: a[1] + (b[1] - a[1]) * t, y: a[2] + (b[2] - a[2]) * t, vx: a[3] + (b[3] - a[3]) * t, vy: a[4] + (b[4] - a[4]) * t, fx: b[5], fy: b[6], fl: b[7], abT: b[8] };
    }
    const e = a || b; if (!e) return null;
    const dt = a && !b ? clamp((rt - sa.ts) / 1000, 0, 0.15) : 0;
    return { x: e[1] + e[3] * dt, y: e[2] + e[4] * dt, vx: e[3], vy: e[4], fx: e[5], fy: e[6], fl: e[7], abT: e[8] };
  }

  /* ============================ HUD feedback (GSAP) ========================== */
  const rname = (id) => { const r = G.roster.get(id); return r ? r.n : '???'; };

  // enter, hold, leave as ONE timeline (rather than chaining a second tween with `delay`)
  function pop(node, ms, then) {
    gsap.timeline({ onComplete: () => { node.remove(); if (then) then(); } })
      .fromTo(node, { x: -24, opacity: 0 }, { x: 0, opacity: 1, duration: 0.35, ease: 'back.out(2)' })
      .to(node, { opacity: 0, y: -8, duration: 0.4 }, `+=${Math.max(0, ms / 1000 - 0.35)}`);
  }
  function toast(text) {
    const box = $('toasts'), t = el('div', 'toast', text); box.appendChild(t);
    while (box.children.length > 3) box.firstChild.remove();
    gsap.timeline({ onComplete: () => t.remove() })
      .fromTo(t, { y: -14, opacity: 0, scale: 0.9 }, { y: 0, opacity: 1, scale: 1, duration: 0.35, ease: 'back.out(2)' })
      .to(t, { opacity: 0, duration: 0.4 }, '+=2.25');
  }
  function feed(nodes, mine) {
    const box = $('feed'), f = el('div', 'feed-item' + (mine ? ' me' : '')); f.append(...nodes); box.appendChild(f);
    while (box.children.length > 4) box.firstChild.remove();
    pop(f, 4200);
  }
  let bannerTl = null;
  function banner(text, cls) {
    const box = $('banner'); if (bannerTl) bannerTl.kill(); box.innerHTML = '';
    const b = el('div', 'bn ' + (cls || ''), text); box.appendChild(b);
    bannerTl = gsap.timeline()
      .fromTo(b, { scale: 0.3, rotation: -14, y: 60, opacity: 0 }, { scale: 1, rotation: -2, y: 0, opacity: 1, duration: 0.5, ease: 'back.out(2.6)' })
      .to(b, { y: -24, opacity: 0, duration: 0.35, ease: 'power2.in' }, '+=1.1').add(() => b.remove());
  }
  function flash() { gsap.fromTo('#flash', { autoAlpha: 0.45 }, { autoAlpha: 0, duration: 0.45, ease: 'power2.out', overwrite: true }); }
  function countNum(n) {
    const cd = $('countdown'); cd.textContent = n; gsap.killTweensOf(cd);
    gsap.timeline()
      .fromTo(cd, { scale: 2.2, opacity: 0, rotation: -8 }, { scale: 1, opacity: 1, rotation: 0, duration: 0.4, ease: 'back.out(2)' })
      .to(cd, { opacity: 0, scale: 0.8, duration: 0.22 }, 0.72);
  }
  const near = (x, y) => G.me && Math.hypot(x - G.me.x, y - G.me.y) < 900;

  /* =============================== events / fx ============================== */
  function onEvent(e) {
    switch (e.k) {
      case 'tag': {
        const rb = G.roster.get(e.b), mineA = e.a === G.id, mineB = e.b === G.id;
        const zed = !!e.z, pot = G.mode === 'potato';
        Particles.burst(e.x, e.y, zed ? '#7ddc4f' : pot ? '#ff8a3d' : '#ff4d5e', 18, 380, 7, 0.7); Particles.ring(e.x, e.y, 10, 90, zed ? '#b6ff8a' : '#ffd23f', 0.45, 7);
        Chars.pose(visOf(e.b), 'hit', visOf(e.b).face);
        for (let i = 0; i < 4; i++) Particles.star(e.x, e.y - 20, '#ffd23f', 12, 0.7, (Math.random() - 0.5) * 360, -120 - Math.random() * 200);
        if (e.a) feed([el('span', '', rname(e.a)), el('span', '', zed ? ' infected ' : pot ? ' passed the potato to ' : ' tagged '), el('b', '', rb ? rb.n : '???')], mineA || mineB);
        else feed([el('b', '', rb ? rb.n : '???'), el('span', '', ' is the new IT')], mineB);
        if (mineB) { banner(zed ? "YOU'RE INFECTED!" : pot ? 'YOU HAVE THE POTATO!' : "YOU'RE IT!", zed ? 'green' : pot ? 'orange' : 'red'); flash(); G.shake = 14; Sfx.play(zed ? 'infect' : 'youreIt'); Sfx.play('tagged'); }
        else if (mineA) { banner(zed ? 'Infected ' + (rb ? rb.n : '') + '!' : pot ? 'Passed it on!' : 'Tagged ' + (rb ? rb.n : '') + '!', zed ? 'green' : ''); G.shake = 9; Sfx.play('tag'); }
        else if (near(e.x, e.y)) { G.shake = Math.max(G.shake, 4); Sfx.play('tag'); }
        break; }
      case 'st':
        if (e.s === STATE.VOTE) { Sfx.play('voteOpen'); }
        else if (e.s === STATE.COUNT) {
          const md = C.MODE_BY_ID[e.md];
          banner(md && md.id !== 'classic' ? md.name + '!' : `Round ${e.rd}`, md && md.id === 'infection' ? 'green' : md && md.id === 'potato' ? 'orange' : ''); Sfx.play('ready');
        } else if (e.s === STATE.PLAY) {
          const its = e.its || [e.it], mine = its.includes(G.id);
          if (e.md === 'potato') {
            if (mine) { banner('YOU HAVE THE POTATO!', 'orange'); flash(); Sfx.play('youreIt'); }
            else { banner(its.length > 1 ? `${its.map(rname).join(' & ')} have the potato!` : `${rname(its[0])} has the potato!`, 'orange'); Sfx.play('go'); }
          } else if (e.md === 'infection') {
            if (mine) { banner("YOU'RE PATIENT ZERO!", 'green'); flash(); Sfx.play('infect'); }
            else { banner(its.length > 1 ? `${its.map(rname).join(' & ')} are infected!` : `${rname(its[0])} is infected!`, 'green'); Sfx.play('go'); }
          } else if (mine) { banner(its.length > 1 ? "YOU'RE IT! (two taggers)" : "YOU'RE IT!", 'red'); flash(); Sfx.play('youreIt'); }
          else { banner(its.length > 1 ? `${its.map(rname).join(' & ')} are IT!` : `${rname(its[0])} is IT!`, 'red'); Sfx.play('go'); }
        } else if (e.s === STATE.RESULTS) Sfx.play('win');
        break;
      case 'boom': {
        Particles.burst(e.x, e.y, '#ff8a3d', 40, 560, 9, 0.8); Particles.burst(e.x, e.y, '#ffd23f', 24, 420, 7, 0.7); Particles.ring(e.x, e.y, 10, 230, '#fff', 0.5, 14);
        for (let i = 0; i < 8; i++) Particles.puff(e.x, e.y, '#55506a', 24, 0.8);
        const mineE = e.id === G.id;
        if (mineE) { banner("BOOM! You're out", 'red'); flash(); G.shake = 24; Sfx.play('boom'); }
        else if (near(e.x, e.y)) { G.shake = Math.max(G.shake, 12); Sfx.play('boom'); }
        feed([el('b', '', rname(e.id)), el('span', '', ' blew up!')], mineE);
        break; }
      case 'ab': if (SERVER_FX.has(e.n) || e.id !== G.id) abilityFx(e, e.id === G.id); break;
      case 'pop': Particles.burst(e.x, e.y, '#fff', 14, 300, 6, 0.5); Particles.puff(e.x, e.y, '#ddd', 18, 0.5); if (near(e.x, e.y)) Sfx.play('pop'); break;
      case 'chat': onChat(e); break;
      case 'join': toast(`${e.n} joined`); Sfx.play('join'); break;
      case 'leave': toast(`${e.n} left`); break;
      default: break;
    }
  }

  const POSE_FX = new Set(['dash', 'leap', 'phase', 'cloak', 'stomp', 'goo', 'decoy', 'shield', 'shieldhit', 'swap', 'echo', 'recall', 'pounce', 'spin', 'bounce', 'slide', 'gust', 'seed']);
  const SERVER_FX = new Set(['shieldhit', 'swap', 'splash', 'bowl', 'seedhit', 'seedpop']);   // effects the local sim doesn't predict: show them for me too
  function abilityFx(e, local) {
    const id = e.n, x = e.x, y = e.y;
    const loud = local || near(x, y);
    if (POSE_FX.has(id)) { const v = visOf(e.id); Chars.pose(v, id, v.face || 1); }
    switch (id) {
      case 'spin':
        Particles.puff(x, y + 10, '#ffd9c7', 14, 0.45); Particles.ring(x, y + 8, 6, 62, '#ff9a7a', 0.4, 6);
        for (let i = 0; i < 6; i++) Particles.star(x, y, '#ffb199', 9, 0.6, (Math.random() - 0.5) * 300, (Math.random() - 0.5) * 300);
        if (loud) Sfx.play('spin'); break;
      case 'gust':
        Particles.ring(x, y, 10, 270, '#ffffff', 0.55, 7); Particles.ring(x, y, 6, 190, '#bfeaff', 0.45, 5);
        for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2 + Math.random() * 0.3; Particles.streak(x + Math.cos(a) * 26, y + Math.sin(a) * 26, Math.cos(a), Math.sin(a), '#e8f8ff', 70 + Math.random() * 60, 0.4); }
        for (let i = 0; i < 6; i++) Particles.puff(x, y + 6, '#ffffff', 14, 0.5);
        if (loud) { Sfx.play('gust'); if (local) G.shake = Math.max(G.shake, 4); } break;
      case 'seed':
        Particles.puff(x + e.dx * 24, y + e.dy * 24, '#e9f3a8', 10, 0.3); Particles.ring(x + e.dx * 20, y + e.dy * 20, 4, 36, '#8a5a35', 0.25, 4);
        for (let i = 0; i < 4; i++) Particles.streak(x + e.dx * 26, y + e.dy * 26, e.dx, e.dy, '#b88556', 80 + Math.random() * 60, 0.25);
        if (loud) Sfx.play('seed'); break;
      case 'seedhit':
        Particles.burst(x, y, '#8a5a35', 12, 280, 5, 0.45); Particles.ring(x, y, 6, 64, '#ffd23f', 0.35, 6);
        for (let i = 0; i < 5; i++) Particles.star(x, y - 14, '#ffe27a', 8, 0.7, (Math.random() - 0.5) * 220, -80 - Math.random() * 120);
        if (loud) { Sfx.play('seedhit'); G.shake = Math.max(G.shake, 4); } break;
      case 'seedpop':
        Particles.burst(x, y, '#8a5a35', 6, 160, 4, 0.3); Particles.puff(x, y, '#e9f3a8', 6, 0.25); break;
      case 'bounce':
        Particles.burst(x, y, '#ffb199', 10, 260, 5, 0.4); Particles.ring(x, y, 6, 52, '#fff', 0.3, 5);
        for (let i = 0; i < 3; i++) Particles.star(x, y, '#ffe27a', 8, 0.5, (Math.random() - 0.5) * 240, (Math.random() - 0.5) * 240);
        if (loud) { Sfx.play('boing'); if (local) G.shake = Math.max(G.shake, 3); } break;
      case 'dash':
        for (let i = 0; i < 7; i++) Particles.streak(x + (Math.random() - 0.5) * 20, y + (Math.random() - 0.5) * 24, e.dx, e.dy, '#ffcf8a', 60 + Math.random() * 50, 0.28);
        Particles.puff(x, y + 12, '#fff', 14, 0.4); Particles.ring(x, y, 8, 50, '#ff8a3d', 0.3, 5); if (loud) Sfx.play('dash'); break;
      case 'leap': Particles.ring(x, y + 14, 6, 60, '#9dff9d', 0.4, 6); for (let i = 0; i < 6; i++) Particles.puff(x, y + 14, '#cfe', 12, 0.5); if (loud) Sfx.play('leap'); break;
      case 'phase': Particles.ring(x, y, 8, 70, '#c9b8ff', 0.6, 6); for (let i = 0; i < 6; i++) Particles.star(x, y, '#e6dcff', 10, 0.8, (Math.random() - 0.5) * 200, -60 - Math.random() * 100); if (loud) Sfx.play('phase'); break;
      case 'cloak': for (let i = 0; i < 10; i++) Particles.puff(x, y, '#9aa5d6', 18, 0.7); Particles.ring(x, y, 8, 60, '#9aa5d6', 0.5, 5); if (loud) Sfx.play('cloak'); break;
      case 'stomp': Particles.ring(x, y + 10, 10, 175, '#ffd23f', 0.5, 12); Particles.ring(x, y + 10, 6, 120, '#fff', 0.38, 7); Particles.burst(x, y + 10, '#c9a06a', 22, 460, 8, 0.6); if (loud) { Sfx.play('stomp'); G.shake = Math.max(G.shake, local ? 12 : 7); } break;
      case 'goo': Particles.burst(x, y, '#b05cff', 16, 260, 8, 0.6); Particles.ring(x, y, 10, 72, '#b05cff', 0.4, 6); if (loud) Sfx.play('goo'); break;
      case 'decoy': Particles.puff(x, y, '#e6e6ff', 16, 0.5); for (let i = 0; i < 3; i++) Particles.star(x, y - 10, '#ffe27a', 10, 0.6, (Math.random() - 0.5) * 240, -100); if (loud) Sfx.play('decoy'); break;
      case 'shield': Particles.ring(x, y, 10, 64, '#8fd3ff', 0.45, 6); Particles.burst(x, y, '#8fd3ff', 10, 220, 5, 0.45); if (loud) Sfx.play('shield'); break;
      case 'shieldhit':
        Particles.ring(x, y, 12, 110, '#ffffff', 0.4, 8); Particles.ring(x, y, 8, 80, '#8fd3ff', 0.5, 6); Particles.burst(x, y, '#8fd3ff', 20, 420, 6, 0.55);
        for (let i = 0; i < 4; i++) Particles.star(x, y, '#ffffff', 11, 0.6, (Math.random() - 0.5) * 360, (Math.random() - 0.5) * 360);
        if (loud) { Sfx.play('shieldhit'); G.shake = Math.max(G.shake, 8); }
        if (e.id === G.id) toast('Blocked a tag!'); else if (near(x, y)) feed([el('b', '', rname(e.id)), el('span', '', ' blocked a tag')], false);
        break;
      case 'tele': Particles.ring(x, y, 8, 80, '#4cc9f0', 0.5, 6); Particles.burst(x, y, '#4cc9f0', 14, 300, 5, 0.5); if (e.x1 !== undefined) { Particles.ring(e.x1, e.y1, 80, 8, '#ff8fc7', 0.5, 6); Particles.burst(e.x1, e.y1, '#ff8fc7', 14, 300, 5, 0.5); } if (loud) Sfx.play('tele'); break;
      case 'slide':
        Particles.puff(x, y + 14, '#ffffff', 16, 0.5); for (let i = 0; i < 8; i++) Particles.streak(x + (Math.random() - 0.5) * 22, y + 10 + Math.random() * 10, e.dx, e.dy, '#e8f6ff', 50 + Math.random() * 40, 0.3);
        Particles.ring(x, y + 12, 6, 54, '#bfe6ff', 0.35, 5); if (loud) Sfx.play('slide'); break;
      case 'bowl':
        Particles.burst(x, y, '#bfe6ff', 16, 380, 6, 0.5); Particles.ring(x, y, 8, 80, '#ffffff', 0.35, 7); Particles.star(x, y - 18, '#ffd23f', 12, 0.6, 0, -140);
        if (loud) { Sfx.play('bowl'); G.shake = Math.max(G.shake, local ? 8 : 4); } break;
      case 'swap':
        for (const [px, py, c] of [[x, y, '#d8a574'], [e.x1, e.y1, '#8b6a4a']]) { Particles.ring(px, py, 8, 72, c, 0.45, 6); Particles.burst(px, py, c, 12, 280, 5, 0.5); Particles.puff(px, py, '#fff', 16, 0.4); }
        if (loud || near(e.x1, e.y1)) Sfx.play('swap'); if (e.id === G.id) G.shake = Math.max(G.shake, 6); break;
      case 'echo':
        Particles.ring(x, y, 6, 90, '#c4a2ff', 0.7, 4); Particles.ring(x, y, 4, 56, '#e6d6ff', 0.55, 3); for (let i = 0; i < 6; i++) Particles.star(x, y, '#d9c3ff', 9, 0.7, (Math.random() - 0.5) * 220, -50 - Math.random() * 80);
        if (loud) Sfx.play('echo'); break;
      case 'recall':
        Particles.ring(x, y, 70, 6, '#c4a2ff', 0.4, 6); Particles.burst(x, y, '#c4a2ff', 10, 240, 5, 0.45);
        if (e.x1 !== undefined) { Particles.ring(e.x1, e.y1, 8, 80, '#e6d6ff', 0.5, 6); Particles.burst(e.x1, e.y1, '#c4a2ff', 14, 320, 5, 0.5); }
        if (loud) Sfx.play('recall'); break;
      case 'pounce':
        for (let i = 0; i < 8; i++) Particles.streak(x + (Math.random() - 0.5) * 20, y + (Math.random() - 0.5) * 24, e.dx, e.dy, '#aab4e8', 60 + Math.random() * 50, 0.3);
        Particles.puff(x, y, '#9aa5d6', 16, 0.45); Particles.ring(x, y, 8, 60, '#ffd23f', 0.3, 5); if (loud) Sfx.play('pounce'); break;
      case 'splash':
        Particles.burst(x, y + 10, '#5ddc8a', 18, 330, 7, 0.6); Particles.ring(x, y + 10, 8, 64, '#5ddc8a', 0.45, 7); Particles.ring(x, y + 10, 4, 40, '#fff', 0.3, 4);
        if (loud) { Sfx.play('splash'); if (local) G.shake = Math.max(G.shake, 5); } break;
      default: break;
    }
  }

  /* ================================= input ================================= */
  const K = G.keys;
  const MOVE = { KeyW: 'u', ArrowUp: 'u', KeyS: 'd', ArrowDown: 'd', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
  const typing = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'); };
  const live = () => G.inGame && window.App && App.inGame;
  window.addEventListener('keydown', (e) => {
    if (!live()) return;
    if (e.code === 'Escape' && chatOpen) { closeChat(); e.preventDefault(); return; }
    if (typing()) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') { if (G.uiOff) setUi(false); openChat(); e.preventDefault(); return; }
    if (MOVE[e.code]) { K[MOVE[e.code]] = true; e.preventDefault(); }
    else if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.code === 'KeyE') { if (!e.repeat) { G.abilityQueued = true; Sfx.unlock(); } e.preventDefault(); }
    else if (/^Digit[1-6]$/.test(e.code) && !voteEl.classList.contains('hidden')) { const n = +e.code.slice(5) - 1; voteBtns[n < 3 ? 'm' : 'd'][n < 3 ? n : n - 3]?.click(); e.preventDefault(); }
    else if (e.code === 'KeyM') toggleMute();
    else if (e.code === 'KeyH' && !e.repeat) setUi(!G.uiOff);
  });
  window.addEventListener('keyup', (e) => { if (MOVE[e.code]) K[MOVE[e.code]] = false; });
  window.addEventListener('pagehide', () => closeWs());
  const releaseAll = () => { for (const k of Object.keys(K)) K[k] = false; G.joy.active = false; $('joy').classList.add('hidden'); };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { G.acc = 0; if (document.hidden) releaseAll(); });

  const abBtn = $('abilityBtn');
  abBtn.addEventListener('pointerdown', (e) => { G.abilityQueued = true; Sfx.unlock(); e.preventDefault(); e.stopPropagation(); });
  abBtn.addEventListener('contextmenu', (e) => e.preventDefault());

  /* ================================== chat =================================== */
  let chatOpen = false, lastTyping = 0;
  const chatEl = $('chat'), chatForm = $('chatForm'), chatInput = $('chatInput'), chatLog = $('chatLog');
  function openChat() {
    if (chatOpen || !live()) return;
    chatOpen = true; releaseAll(); setUnread(0); chatEl.classList.add('open'); chatForm.classList.remove('hidden'); quick.classList.remove('hidden');
    chatInput.value = ''; chatInput.focus(); setTimeout(() => { if (chatOpen && document.activeElement !== chatInput) chatInput.focus(); }, 30); send({ t: 'typing' });
  }
  function closeChat(silent) {
    if (!chatOpen && !silent) return;
    chatOpen = false; chatEl.classList.remove('open'); chatForm.classList.add('hidden'); quick.classList.add('hidden'); chatInput.value = ''; chatInput.blur();
  }
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const m = chatInput.value.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (m) send({ t: 'chat', m });
    closeChat();
  });
  chatInput.addEventListener('input', () => { const n = performance.now(); if (n - lastTyping > 2500) { lastTyping = n; send({ t: 'typing' }); } });   // keeps you from being marked AFK while typing
  $('chatOpen').addEventListener('click', () => { Sfx.play('click'); openChat(); });
  const QUICK = ['GG!', 'Nice one!', 'So close!', 'Help!', 'Run!', 'Rematch?'];
  const quick = $('quickChat');
  QUICK.forEach((q) => { const b = el('button', '', q); b.type = 'button'; b.addEventListener('click', () => { send({ t: 'chat', m: q }); closeChat(); }); quick.appendChild(b); });
  quick.addEventListener('pointerdown', (e) => e.stopPropagation());
  let unread = 0;
  const badge = $('chatBadge');
  function setUnread(n) { unread = n; badge.textContent = n > 9 ? '9+' : String(n); badge.classList.toggle('hidden', !n); }
  chatForm.addEventListener('pointerdown', (e) => e.stopPropagation());

  function onChat(e) {
    if (G.muted.has(e.id)) return;
    const mine = e.id === G.id, d = el('div', 'msg' + (mine ? ' me' : '')), who = el('b', e.a ? 'reg' : '', e.n);
    who.title = mine ? '' : 'Click to mute / unmute'; if (!mine) who.addEventListener('click', () => muteToggle(e.id, e.n));
    if (e.s) d.classList.add('staff');
    d.append(...(e.s ? [el('span', 'stf', 'ADMIN')] : []), who, el('span', '', e.m)); chatLog.appendChild(d);
    while (chatLog.children.length > 7) chatLog.firstChild.remove();
    gsap.fromTo(d, { x: -30, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: 'back.out(2)' });
    setTimeout(() => d.classList.add('old'), 14000);
    if (!mine && !chatOpen) setUnread(unread + 1);
    G.bubbles.set(e.id, { m: e.m, t: G.t, lines: null });
    if (!mine) Sfx.play('chat');
  }
  function muteToggle(id, name) {
    if (G.muted.has(id)) { G.muted.delete(id); toast(`Unmuted ${name}`); } else { G.muted.add(id); G.bubbles.delete(id); toast(`Muted ${name} (this game only)`); }
  }
  function onAnnounce(m) {
    toast((m.p ? '' : '📢 ') + m.m);
    const d = el('div', 'msg sys' + (m.p ? ' priv' : ''), (m.p ? '' : '📢 ') + m.m); chatLog.appendChild(d);
    while (chatLog.children.length > 7) chatLog.firstChild.remove();
    gsap.fromTo(d, { x: -30, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: 'back.out(2)' });
    setTimeout(() => d.classList.add('old'), 20000);
    if (!m.p) Sfx.play('chat');
  }
  function onAward(m) {
    if (window.App && App.onAward) App.onAward(m);
    const box = $('resWin'); box.className = 'res-win'; box.textContent = `★ +1 win saved · ${m.wins} total · ${m.balance} to spend`;
    if (G.state !== STATE.RESULTS) toast(`+1 win · ${m.balance} to spend`);
    else gsap.fromTo(box, { scale: 0.7, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.5, ease: 'back.out(3)' });
    Sfx.play('win');
  }
  const paintMute = () => { $('btnMute').innerHTML = Sfx.muted
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 9l5 6M22 9l-5 6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9z"/><path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12"/></svg>'; };
  function toggleMute() { Sfx.setMuted(!Sfx.muted); paintMute(); }
  $('btnMute').onclick = toggleMute; paintMute();
  // hide interface: everything but the toggle itself and the touch controls disappears (display:none, so no animation to fight GSAP)
  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>__SLASH__</svg>';
  function setUi(off) {
    G.uiOff = !!off; if (off) closeChat();
    $('app').classList.toggle('ui-off', G.uiOff);
    const b = $('btnUi'); b.innerHTML = EYE.replace('__SLASH__', G.uiOff ? '' : '<path d="M4 20 20 4"/>');
    b.setAttribute('aria-pressed', String(G.uiOff)); b.setAttribute('aria-label', G.uiOff ? 'Show interface' : 'Hide interface'); b.title = (G.uiOff ? 'Show' : 'Hide') + ' interface (H)';
    gsap.fromTo(b, { scale: 0.8 }, { scale: 1, duration: 0.35, ease: 'back.out(3)', clearProps: 'transform' });
  }
  $('btnUi').onclick = () => setUi(!G.uiOff); setUi(false);
  $('btnLeave').onclick = () => App.leave();
  $('overlayBtn').onclick = () => App.leave();

  // touch joystick (anywhere on the left 62% of the screen)
  const joyEl = $('joy'), knob = $('joyKnob');
  window.addEventListener('touchstart', (e) => {
    if (!live()) return;
    for (const t of e.changedTouches) {
      if (G.joy.active || t.clientX > innerWidth * 0.62 || (t.target.closest && t.target.closest('button, .card, input, form, .msg'))) continue;
      G.joy.active = true; G.joy.id = t.identifier; G.joy.ox = t.clientX; G.joy.oy = t.clientY; G.joy.x = G.joy.y = 0;
      joyEl.style.left = t.clientX + 'px'; joyEl.style.top = t.clientY + 'px'; knob.style.transform = ''; joyEl.classList.remove('hidden');
    }
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) if (G.joy.active && t.identifier === G.joy.id) {
      let dx = t.clientX - G.joy.ox, dy = t.clientY - G.joy.oy; const d = Math.hypot(dx, dy), R = 56;
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      G.joy.x = dx / R; G.joy.y = dy / R; knob.style.transform = `translate(${dx}px,${dy}px)`;
    }
  }, { passive: true });
  const joyEnd = (e) => { for (const t of e.changedTouches) if (G.joy.active && t.identifier === G.joy.id) { G.joy.active = false; G.joy.x = G.joy.y = 0; joyEl.classList.add('hidden'); } };
  window.addEventListener('touchend', joyEnd, { passive: true }); window.addEventListener('touchcancel', joyEnd, { passive: true });
  document.addEventListener('contextmenu', (e) => { if (live()) e.preventDefault(); });

  /* ===== avocado aiming: the seed goes where the mouse is (touch screens keep aiming with the move stick) ===== */
  const mouse = { on: false, x: 0, y: 0 };
  window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') { mouse.on = true; mouse.x = e.clientX; mouse.y = e.clientY; } else mouse.on = false; }, { passive: true });
  window.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') { mouse.on = true; mouse.x = e.clientX; mouse.y = e.clientY; } else mouse.on = false; }, { passive: true, capture: true });
  const isAvocado = () => !!G.me && CHARS[G.me.c].id === 'avocado';
  function mouseAim() {
    if (!mouse.on || !isAvocado() || !G.me) return null;
    const dx = G.cam.x + (mouse.x - G.W / 2) / G.zoom - G.me.x, dy = G.cam.y + (mouse.y - G.H / 2) / G.zoom - G.me.y, l = Math.hypot(dx, dy);
    return l < 8 ? null : [Math.round(dx / l * 100) / 100, Math.round(dy / l * 100) / 100];
  }
  $('game').addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button === 0 && live() && isAvocado() && !typing()) { G.abilityQueued = true; Sfx.unlock(); } });

  /* ============================= simulation step ============================ */
  const LOCAL_FX = new Set(['tele', 'dash', 'leap', 'phase', 'cloak', 'stomp', 'goo', 'decoy', 'shield', 'slide', 'echo', 'recall', 'pounce', 'spin', 'bounce', 'gust', 'seed']);
  function simStep() {
    let x = (K.r ? 1 : 0) - (K.l ? 1 : 0), y = (K.d ? 1 : 0) - (K.u ? 1 : 0);
    if (G.joy.active) { const m = Math.hypot(G.joy.x, G.joy.y); if (m > 0.18) { x = q2(G.joy.x); y = q2(G.joy.y); } }
    let a = G.abilityQueued ? 1 : 0; G.abilityQueued = false;
    if (G.state === STATE.COUNT) { x = y = a = 0; }
    const inp = { s: ++G.seq, x, y, a };
    if (a) { const aim = mouseAim(); if (aim) { inp.ax = aim[0]; inp.ay = aim[1]; } }
    G.pending.push(inp); G.sendBuf.push(inp);
    if (G.pending.length > 180) G.pending.shift();
    G.px = G.me.x; G.py = G.me.y;
    const ev = [];
    C.stepPlayer(G.me, inp, G.ctx, ev);
    for (const e of ev) if (LOCAL_FX.has(e.n)) abilityFx(e, true);
  }

  function flushInputs() {
    if (!G.sendBuf.length) return;
    G.lastSend = performance.now();
    send({ t: 'in', i: G.sendBuf.slice(-10).map((i) => (i.ax === undefined ? [i.s, i.x, i.y, i.a] : [i.s, i.x, i.y, i.a, i.ax, i.ay])) });
    G.sendBuf.length = 0;
  }

  /* ================================= render ================================= */
  const cv = $('game');
  function resize() {
    G.W = innerWidth; G.H = innerHeight; G.dpr = Math.min(devicePixelRatio || 1, 2);
    cv.width = Math.round(G.W * G.dpr); cv.height = Math.round(G.H * G.dpr); G.g = cv.getContext('2d');
    G.zoomT = clamp(Math.sqrt((G.W * G.H) / (1300 * 760)), 0.5, 1.8);
    const mini = $('mini'), w = mini.clientWidth || 200, ar = G.map ? G.map.h / G.map.w : 0.65;
    mini.width = Math.round(w * G.dpr); mini.height = Math.round(w * G.dpr * ar); mini.style.height = w * ar + 'px';
    if (G.inGame) G.zoom = G.zoomT;
  }
  window.addEventListener('resize', () => { if (G.inGame) resize(); });

  function visOf(key) {
    let v = G.vis.get(key);
    if (!v) { v = { face: 1, nextBlink: 1 + Math.random() * 3, blinkT: 0, ph: Math.random() * 10, dust: 0, trail: 0, spin: 0, flop: 0, pose: { up: 0, rot: 0, sq: 0 } }; G.vis.set(key, v); }
    return v;
  }
  const project = (x, y) => [(x - G.cam.x) * G.zoom + G.W / 2, (y - G.cam.y) * G.zoom + G.H / 2];
  const HIDE_SEE = 250;                       // bushes and kelp: you only see someone hiding in one from this close
  let hideMap = null, hideZones = [];
  function inHide(x, y) {
    const map = G.map; if (!map) return false;
    if (hideMap !== map) { hideMap = map; hideZones = map.zones.filter((z) => z.k === 'hide'); }
    for (const z of hideZones) if ((x - z.x) * (x - z.x) + (y - z.y) * (y - z.y) < z.r * z.r) return true;
    return false;
  }
  const isCloaked = (e) => (e.abT > 0 && CHARS[e.c].id === 'cat' && !e.isMe) || (!e.isMe && !e.decoy && inHide(e.x, e.y) && G.me && Math.hypot(e.x - G.me.x, e.y - G.me.y) > HIDE_SEE);

  function drawEnt(g, e, t, dt, labels) {
    const def = CHARS[e.c], id = def.id, r = def.radius, s = r / 18, v = visOf(e.key);
    const sp = Math.hypot(e.vx, e.vy), spd = clamp(sp / 250, 0, 1);
    if (Math.abs(e.fx) > 0.3) v.face = e.fx > 0 ? 1 : -1;
    v.nextBlink -= dt; if (v.nextBlink < 0) { v.blinkT = 0.16; v.nextBlink = 2 + Math.random() * 3.5; }
    v.blinkT = Math.max(0, v.blinkT - dt);
    const blink = v.blinkT > 0 ? Math.sin((1 - v.blinkT / 0.16) * Math.PI) : 0;
    const on = e.abT > 0, leap = on && id === 'frog', phase = on && id === 'ghost', cloak = on && id === 'cat', dash = on && id === 'fox';
    const slide = on && id === 'penguin';
    const shield = on && id === 'robot' && !e.it, surge = on && id === 'robot' && e.it;
    const air = leap ? Math.sin(Math.PI * clamp(1 - e.abT / 0.6, 0, 1)) : 0;
    let alpha = 1;
    if (cloak && !e.isMe) return;      // a cloaked cat is fully invisible to everyone else: no body, shadow, marker or name
    if (cloak) alpha = 0.42;
    if (phase) alpha = 0.5;
    if (e.out) alpha *= 0.4;
    if (e.imm && !e.it && !e.decoy) alpha *= 0.55 + 0.45 * Math.abs(Math.sin(t * 13));
    const x = e.x, y = e.y, fyPos = y + r;
    const color = G.mode === 'infection' && e.it && !e.decoy ? '#7ddc4f' : C.colorFor(e.k);      // zombies turn green

    // ground markers
    if (e.it && !e.decoy && !e.out) {
      const danger = G.mode === 'potato' && ptFuse(e.id) < 3, p = 0.5 + 0.5 * Math.sin(t * (danger ? 16 : 6)), a = 1;
      const mc = G.mode === 'infection' ? ['rgba(70,200,90,', 'rgba(160,255,160,.9)'] : G.mode === 'potato' ? [danger ? 'rgba(255,60,60,' : 'rgba(255,138,61,', 'rgba(255,200,130,.9)'] : ['rgba(255,60,90,', 'rgba(255,110,130,.9)'];
      g.globalAlpha = a;
      g.beginPath(); g.ellipse(x, fyPos, r * (1.9 + p * 0.25), r * (0.7 + p * 0.1), 0, 0, TAU);
      g.fillStyle = mc[0] + (0.3 + p * 0.15) + ')'; g.fill(); g.lineWidth = 3; g.strokeStyle = mc[1]; g.stroke();
      g.globalAlpha = 1;
    } else if (e.isMe && !e.out) {
      g.beginPath(); g.ellipse(x, fyPos, r * 1.55, r * 0.55, 0, 0, TAU); g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.75)'; g.stroke();
    }
    // afterimages & trails
    if (slide) { v.trail -= dt; if (v.trail < 0) { v.trail = 0.05; Particles.puff(x - e.vx * 0.03, fyPos - 2, '#ffffff', 6 + Math.random() * 4, 0.4); } }
    if (dash || surge || slide || (e.boost && spd > 0.5)) for (let i = 3; i >= 1; i--) Chars.draw(g, e.c, { x: x - e.vx * 0.012 * i, y: fyPos - e.vy * 0.012 * i, s, color, face: v.face, lx: e.fx, ly: e.fy, t: t + v.ph, spd: 1, alpha: 0.16, shadow: false });
    if (phase) { v.trail -= dt; if (v.trail < 0) { v.trail = 0.07; Particles.star(x, y, '#d9ccff', 8, 0.5, (Math.random() - 0.5) * 60, -40); } }
    v.dust -= dt;
    if (spd > 0.55 && v.dust <= 0 && !air && !phase && !cloak) { v.dust = 0.1; Particles.puff(x - e.vx * 0.04, fyPos - 2, DUST[G.map.theme], 5 + Math.random() * 3, 0.35); }

    // sustained poses ride on top of the timed ones from Chars.pose(): belly-flop while sliding, tumbling while rolling, dizzy sway when stunned
    const pz = v.pose || (v.pose = { up: 0, rot: 0, sq: 0 });
    const rollOn = on && id === 'star';
    if (rollOn) v.spin += dt * 17 * (e.vx >= 0 ? 1 : -1);
    else if (v.spin) { const tgt = Math.round(v.spin / TAU) * TAU; v.spin += (tgt - v.spin) * Math.min(1, dt * 12); if (Math.abs(tgt - v.spin) < 0.02) v.spin = 0; }
    const flopT = slide ? 1.2 : 0; v.flop += (flopT - v.flop) * Math.min(1, dt * 14);
    const dizzy = e.stun ? Math.sin(t * 14) * 0.14 : 0;
    const drawPose = { up: pz.up, sq: pz.sq, rot: pz.rot + v.spin + v.flop + dizzy };
    Chars.draw(g, e.c, { x, y: fyPos, s, color, face: v.face, lx: e.fx, ly: e.fy, t: t + v.ph, spd, air, alpha, blink, lean: clamp(e.vx / 900, -0.18, 0.18), hat: e.h | 0, pose: drawPose });

    if (shield) {
      const rad = r * 1.9, cy = fyPos - r * 1.15, flick = e.abT < 0.6 ? 0.45 + 0.55 * Math.abs(Math.sin(t * 28)) : 1;
      g.save(); g.globalAlpha = flick;
      g.beginPath(); g.arc(x, cy, rad, 0, TAU); g.fillStyle = 'rgba(95,180,255,.2)'; g.fill();
      g.lineWidth = 4; g.strokeStyle = '#8fd3ff'; g.setLineDash([14, 10]); g.lineDashOffset = -t * 36; g.stroke(); g.setLineDash([]);
      g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.85)'; g.lineCap = 'round'; g.beginPath(); g.arc(x, cy, rad - 7, -2.5, -1.4); g.stroke();
      g.restore();
    }
    if (e.stun) for (let i = 0; i < 3; i++) {
      const a = t * 5 + i * TAU / 3, sx = x + Math.cos(a) * 15, sy = y - r * 1.9 + Math.sin(a) * 5;
      g.save(); g.translate(sx, sy); g.rotate(a); g.fillStyle = '#ffd23f'; g.strokeStyle = '#14122b'; g.lineWidth = 1.5; g.beginPath();
      for (let k = 0; k < 10; k++) { const rr = k % 2 ? 2.6 : 6; g.lineTo(Math.cos(k * TAU / 10) * rr, Math.sin(k * TAU / 10) * rr); } g.closePath(); g.fill(); g.stroke(); g.restore();
    }
    if (!cloak || e.isMe) labels.push({ e, x, y: fyPos - 50 * s - air * 46, alpha: phase ? 0.7 : 1 });
  }

  /* your Echo Beacon (only you see it): pulsing ring with a countdown arc */
  function drawBeacon(g, me, t) {
    const x = me.bx, y = me.by, p = 0.5 + 0.5 * Math.sin(t * 7), frac = clamp(me.aux / 4, 0, 1);
    g.save();
    g.beginPath(); g.ellipse(x, y + 14, 30 + p * 4, 12 + p * 2, 0, 0, TAU); g.fillStyle = 'rgba(176,130,255,.25)'; g.fill();
    g.lineWidth = 4; g.strokeStyle = 'rgba(214,190,255,.9)'; g.beginPath(); g.arc(x, y - 6, 26, -Math.PI / 2, -Math.PI / 2 + TAU * frac); g.stroke();
    g.translate(x, y - 6 - p * 3); g.rotate(Math.PI / 4); g.fillStyle = '#c4a2ff'; g.strokeStyle = '#14122b'; g.lineWidth = 3;
    g.beginPath(); g.roundRect(-9, -9, 18, 18, 4); g.fill(); g.stroke();
    g.restore();
  }

  function drawLabels(g, labels, t) {
    g.setTransform(G.dpr, 0, 0, G.dpr, 0, 0);
    g.textAlign = 'center'; g.lineJoin = 'round';
    for (const l of labels) {
      const [sx, sy] = project(l.x, l.y), e = l.e;
      if (sx < -80 || sx > G.W + 80 || sy < -80 || sy > G.H + 80) continue;
      g.globalAlpha = l.alpha;
      const bb = G.bubbles.get(e.id);
      let lift = 0;
      if (e.it && !e.decoy && !e.out) {
        if (G.mode === 'potato') {
          const f = Math.min(C.POTATO_START, ptFuse(e.id)), danger = f < 3, bob = Math.sin(t * (danger ? 18 : 7)) * 3, jx = danger ? (Math.random() - 0.5) * 3 : 0, cx = sx + jx, cy = sy - 36 + bob;
          g.save(); g.translate(cx, cy); g.rotate(-0.2 + (danger ? Math.sin(t * 22) * 0.12 : 0));
          g.beginPath(); g.ellipse(0, 0, 16, 11.5, 0, 0, TAU); g.fillStyle = danger ? '#e2623a' : '#c98a4b'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#14122b'; g.stroke();
          g.fillStyle = 'rgba(80,45,20,.55)'; for (const [px, py] of [[-6, -3], [5, 2], [-1, 5], [7, -5]]) { g.beginPath(); g.arc(px, py, 1.8, 0, TAU); g.fill(); }
          g.restore();
          g.font = `800 15px ${FONT}`; g.lineWidth = 4; g.strokeStyle = '#14122b'; const ft = f.toFixed(1); g.strokeText(ft, cx, sy - 54 + bob); g.fillStyle = danger ? '#ff6b6b' : '#fff'; g.fillText(ft, cx, sy - 54 + bob);
          lift = 32;
        } else {
          const bob = Math.sin(t * 7) * 3, zed = G.mode === 'infection', txt = zed ? 'ZOMBIE' : 'IT';
          g.fillStyle = zed ? '#3fbf5f' : '#ff4d5e'; g.strokeStyle = '#14122b'; g.lineWidth = 3;
          g.beginPath(); g.moveTo(sx - 9, sy - 26 + bob); g.lineTo(sx + 9, sy - 26 + bob); g.lineTo(sx, sy - 14 + bob); g.closePath(); g.stroke(); g.fill();
          g.font = `800 ${zed ? 12 : 14}px ${FONT}`; g.strokeText(txt, sx, sy - 31 + bob); g.fillStyle = '#fff'; g.fillText(txt, sx, sy - 31 + bob);
          lift = 24;
        }
      }
      const name = e.name; g.font = `700 14px ${FONT}`;
      g.lineWidth = 4; g.strokeStyle = 'rgba(20,18,43,.92)'; g.strokeText(name, sx, sy - 4);
      g.fillStyle = e.isMe ? '#ffd23f' : '#fffaf0'; g.fillText(name, sx, sy - 4);
      if (e.afk) { g.font = '16px sans-serif'; g.fillText('💤', sx + g.measureText(name).width / 2 + 10, sy - 10); }
      if (bb && !e.decoy && G.t - bb.t < 5.5) drawBubble(g, bb, sx, sy - 22 - lift, l.alpha);
      g.globalAlpha = 1;
    }
  }

  /* speech bubble above a player's head, ~5 s */
  function drawBubble(g, bb, sx, sy, alpha) {
    const age = G.t - bb.t;
    g.save(); g.font = `600 14px ${FONT}`; g.textAlign = 'center';
    if (!bb.lines) {                                  // wrap to at most 3 lines of ~190px
      const words = bb.m.split(' '), lines = []; let cur = '';
      for (const w of words) { const test = cur ? cur + ' ' + w : w; if (cur && g.measureText(test).width > 190) { lines.push(cur); cur = w; } else cur = test; }
      if (cur) lines.push(cur);
      bb.lines = lines.slice(0, 3);
    }
    const lh = 17, w = Math.min(214, Math.max(...bb.lines.map((x) => g.measureText(x).width)) + 20), h = bb.lines.length * lh + 12;
    const pop = age < 0.2 ? 0.6 + age * 2 : 1, fade = 1 - Math.max(0, (age - 5) / 0.5);
    g.globalAlpha = alpha * fade; g.translate(sx, sy); g.scale(pop, pop);
    g.beginPath(); g.roundRect(-w / 2, -h - 8, w, h, 11); g.moveTo(-6, -8); g.lineTo(0, 0); g.lineTo(6, -8); g.closePath();
    g.fillStyle = '#fffaf0'; g.strokeStyle = '#14122b'; g.lineWidth = 3; g.lineJoin = 'round'; g.stroke(); g.fill();
    g.fillStyle = '#14122b'; bb.lines.forEach((ln, i) => g.fillText(ln, 0, -h - 8 + 6 + (i + 1) * lh - 4));
    g.restore();
  }

  function drawArrows(g, ents, t) {
    const me = ents[0]; if (!me || G.state !== STATE.PLAY) return;
    let target = null, col = '#ff4d5e';
    if (!me.it || me.out) { let bd = 1e9; for (const e of ents) { if (!e.it || e.decoy || e === me || isCloaked(e)) continue; const d = Math.hypot(e.x - me.x, e.y - me.y); if (d < bd) { bd = d; target = e; } } }
    else { let bd = 1e9; for (const e of ents) { if (e === me || e.decoy || e.it || isCloaked(e)) continue; const d = Math.hypot(e.x - me.x, e.y - me.y); if (d < bd) { bd = d; target = e; } } col = '#2fd18b'; }
    if (!target) return;
    const [sx, sy] = project(target.x, target.y), pad = 54;
    if (sx > pad && sx < G.W - pad && sy > pad && sy < G.H - pad) return;
    const cx = G.W / 2, cy = G.H / 2, dx = sx - cx, dy = sy - cy, k = Math.min((cx - pad) / Math.abs(dx || 1e-6), (cy - pad) / Math.abs(dy || 1e-6));
    const ax = cx + dx * k, ay = cy + dy * k, ang = Math.atan2(dy, dx), pul = 1 + Math.sin(t * 8) * 0.1;
    g.setTransform(G.dpr, 0, 0, G.dpr, 0, 0); g.save(); g.translate(ax, ay); g.rotate(ang); g.scale(pul, pul);
    g.beginPath(); g.moveTo(16, 0); g.lineTo(-10, -13); g.lineTo(-4, 0); g.lineTo(-10, 13); g.closePath(); g.fillStyle = col; g.strokeStyle = '#14122b'; g.lineWidth = 3; g.stroke(); g.fill(); g.restore();
  }

  function render(dt, t) {
    const g = G.g, map = G.map, me = G.me, W = G.W, H = G.H, dpr = G.dpr;
    const a = clamp(G.acc / DT, 0, 1);
    const k = Math.exp(-dt * 12); G.err.x *= k; G.err.y *= k;
    const mx = G.px + (me.x - G.px) * a + G.err.x, my = G.py + (me.y - G.py) * a + G.err.y;
    G.zoom += (G.zoomT - G.zoom) * (1 - Math.exp(-dt * 6));
    const z = G.zoom, hw = W / 2 / z, hh = H / 2 / z;
    const tx = mx + me.vx * 0.12, ty = my + me.vy * 0.12;
    if (G.camSnap) { G.cam.x = tx; G.cam.y = ty; G.camSnap = false; } else { const f = 1 - Math.exp(-dt * 9); G.cam.x += (tx - G.cam.x) * f; G.cam.y += (ty - G.cam.y) * f; }
    G.cam.x = map.w <= hw * 2 ? map.w / 2 : clamp(G.cam.x, hw - 30, map.w - hw + 30);
    G.cam.y = map.h <= hh * 2 ? map.h / 2 : clamp(G.cam.y, hh - 30, map.h - hh + 30);
    G.shake = Math.max(0, G.shake - dt * 40);
    const shx = (Math.random() - 0.5) * G.shake, shy = (Math.random() - 0.5) * G.shake;

    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#0b0d1f'; g.fillRect(0, 0, cv.width, cv.height);
    g.setTransform(z * dpr, 0, 0, z * dpr, (W / 2 - G.cam.x * z + shx) * dpr, (H / 2 - G.cam.y * z + shy) * dpr);
    const v = { x0: G.cam.x - hw - 40, y0: G.cam.y - hh - 40, x1: G.cam.x + hw + 40, y1: G.cam.y + hh + 40 };
    MapRender.drawFloor(g, map, v, t); MapRender.drawBorder(g, map); MapRender.drawZones(g, map, v, t);
    for (const goo of G.goos) MapRender.drawGoo(g, goo, t);
    MapRender.drawObstacles(g, map, v, t);

    const ents = [], rt = srvNow() - G.delay;
    ents.push({ key: G.id, id: G.id, c: me.c, k: G.sel.k, h: G.sel.h, name: G.sel.name, x: mx, y: my, vx: me.vx, vy: me.vy, fx: me.fx, fy: me.fy, it: !!me.it, out: !!me.out, stun: me.stun > 0, imm: me.imm > 0, abT: me.abT, boost: me.boostT > 0, isMe: true });
    const last = G.snaps[G.snaps.length - 1];
    if (last) for (const id of last.by.keys()) {
      if (id === G.id) continue;
      const r = G.roster.get(id); if (!r) continue;
      const s = interp(id, rt); if (!s || (s.fl & 16)) continue;               // eliminated players and ones waiting for the next round are invisible ghosts
      if (inHide(s.x, s.y) && Math.hypot(s.x - mx, s.y - my) > HIDE_SEE) continue;      // in a bush and not close: out of sight
      ents.push({ key: id, id, c: r.c, k: r.k, h: r.h, name: r.n, x: s.x, y: s.y, vx: s.vx, vy: s.vy, fx: s.fx, fy: s.fy, it: !!(s.fl & 1), stun: !!(s.fl & 2), imm: !!(s.fl & 4), afk: !!(s.fl & 8), abT: s.abT, boost: false });
    }
    const since = clamp((performance.now() - G.decoysAt) / 1000, 0, 0.2);
    for (const d of G.decoys) {
      const o = G.roster.get(d.o);
      ents.push({ key: 'd' + d.id, id: d.o, decoy: true, c: d.c, k: d.k, name: o ? o.n : '', x: d.x + d.vx * since, y: d.y + d.vy * since, vx: d.vx, vy: d.vy, fx: d.vx / 215, fy: d.vy / 215, it: false, stun: false, imm: false, abT: 0, boost: false });
    }
    const order = ents.slice().sort((p, q) => p.y - q.y), labels = [];
    for (const e of order) {
      if (e.x < v.x0 - 60 || e.x > v.x1 + 60 || e.y < v.y0 - 80 || e.y > v.y1 + 60) continue;
      drawEnt(g, e, t, dt, labels);
    }
    MapRender.drawCanopy(g, map, v, t, { x: mx, y: my });
    if (CHARS[me.c].id === 'bat' && me.aux > 0 && G.state !== STATE.RESULTS) drawBeacon(g, me, t);
    drawSeeds(g, t);
    drawAim(g, me, t);
    Particles.draw(g);
    drawLabels(g, labels, t);
    drawArrows(g, ents, t);
    drawMini(ents, t);
  }

  // avocado seeds in flight (extrapolated a few ms past the last snapshot)
  function drawSeeds(g, t) {
    if (!G.seeds.length) return;
    const since = clamp((performance.now() - G.seedsAt) / 1000, 0, 0.15);
    for (const s of G.seeds) {
      const x = s.x + s.vx * since, y = s.y + s.vy * since, a = Math.atan2(s.vy, s.vx);
      g.save(); g.translate(x, y); g.rotate(a);
      g.globalAlpha = 0.35; g.fillStyle = '#e9f3a8'; g.beginPath(); g.ellipse(-16, 0, 15, 4, 0, 0, TAU); g.fill(); g.globalAlpha = 1;
      g.rotate(t * 14); g.beginPath(); g.ellipse(0, 0, 11, 8.5, 0, 0, TAU); g.fillStyle = '#8a5a35'; g.fill(); g.lineWidth = 2.4; g.strokeStyle = '#14122b'; g.stroke();
      g.beginPath(); g.ellipse(-3, -2.5, 3.4, 2.2, -0.4, 0, TAU); g.fillStyle = '#c99a68'; g.fill();
      g.restore();
    }
  }
  // a faint dotted line while the avocado's seed is ready, so you can see where it will go
  function drawAim(g, me, t) {
    if (CHARS[me.c].id !== 'avocado' || me.cd > 0 || me.stun > 0 || G.state !== STATE.PLAY) return;
    const mvx = G.joy.active ? G.joy.x : (K.r ? 1 : 0) - (K.l ? 1 : 0), mvy = G.joy.active ? G.joy.y : (K.d ? 1 : 0) - (K.u ? 1 : 0), len = Math.hypot(mvx, mvy), aim = mouseAim();
    const dx = aim ? aim[0] : len > 0.15 ? mvx / len : me.fx, dy = aim ? aim[1] : len > 0.15 ? mvy / len : me.fy;
    g.save(); g.globalAlpha = 0.5; g.strokeStyle = '#e9f3a8'; g.lineWidth = 3; g.lineCap = 'round'; g.setLineDash([2, 14]); g.lineDashOffset = -t * 40;
    g.beginPath(); g.moveTo(G.px + dx * 30, G.py + dy * 30); g.lineTo(G.px + dx * C.SEED_RANGE, G.py + dy * C.SEED_RANGE); g.stroke(); g.restore();
  }

  function drawMini(ents, t) {
    const mc = $('mini'); if (!mc.width || !G.map) return;
    const g = mc.getContext('2d'), w = mc.width, h = mc.height, s = w / G.map.w;
    g.clearRect(0, 0, w, h); g.drawImage(MapRender.miniBase(G.map, 220), 0, 0, w, h);
    for (const e of ents) {
      if (e.decoy || isCloaked(e)) continue;
      const x = e.x * s, y = e.y * s, col = Chars.colorOf(e.c, e.k);
      if (e.it) { g.beginPath(); g.arc(x, y, (6 + Math.sin(t * 6) * 1.5) * G.dpr, 0, TAU); g.fillStyle = 'rgba(255,60,90,.55)'; g.fill(); }
      g.beginPath(); g.arc(x, y, (e.isMe ? 4.6 : 3.6) * G.dpr, 0, TAU); g.fillStyle = col; g.fill(); g.lineWidth = (e.isMe ? 2 : 1.2) * G.dpr; g.strokeStyle = e.isMe ? '#fff' : '#14122b'; g.stroke();
    }
    const hw = G.W / 2 / G.zoom * s, hh = G.H / 2 / G.zoom * s;
    g.strokeStyle = 'rgba(255,255,255,.4)'; g.lineWidth = 1.5; g.strokeRect(G.cam.x * s - hw, G.cam.y * s - hh, hw * 2, hh * 2);
  }

  /* ================================== HUD =================================== */
  const fmt = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  const rowEls = new Map();
  let lastRole = '', lastAbLabel = '';

  function updateHud() {
    const st = G.state, left = Math.max(0, G.tl - (performance.now() - G.tlAt) / 1000), me = G.me;
    const tb = $('timerBox');
    $('stateLbl').textContent = ['Waiting', 'Get ready', 'Time left', 'Results', 'Voting'][st];
    $('timer').textContent = st === STATE.PLAY ? fmt(left) : st === STATE.COUNT ? '•••' : st === STATE.RESULTS ? 'GG' : st === STATE.VOTE ? Math.ceil(left) : '--';
    tb.classList.toggle('warn', st === STATE.PLAY && left <= 10);
    if (st === STATE.PLAY && left <= 10 && Math.ceil(left) !== G.lastSecTick) {
      G.lastSecTick = Math.ceil(left); Sfx.play('tick');
      gsap.fromTo('#timer', { scale: 1.35 }, { scale: 1, duration: 0.35, ease: 'back.out(3)' });
    } else if (st !== STATE.PLAY) G.lastSecTick = -1;

    // countdown
    if (st === STATE.COUNT) {
      const n = Math.max(1, Math.ceil(left));
      if (n !== G.lastCount) { G.lastCount = n; countNum(n); Sfx.play('tick'); }
    } else if (G.lastCount !== -1) { G.lastCount = -1; gsap.killTweensOf($('countdown')); $('countdown').textContent = ''; }

    // role chip
    const role = $('role'), isIt = st === STATE.PLAY && !!me.it && !me.out, mode = G.mode;
    document.body.classList.toggle('is-it', isIt);
    let txt, cls = 'role', alive = 0, surv = 0;
    for (const r of G.roster.values()) if (!(r.fl & 48)) { alive++; if (!(r.fl & 1)) surv++; }
    const myR = G.roster.get(G.id), waiting = !!(myR && (myR.fl & 32));
    if (me.out && (st === STATE.PLAY || st === STATE.COUNT)) {
      cls = 'role ghost'; txt = waiting ? "Match in progress · you're in next round" : "You're out · spectating";
    } else if (st === STATE.PLAY) {
      const its = [...G.roster.values()].filter((r) => r.fl & 1 && r.id !== G.id);
      if (mode === 'potato') {
        if (isIt) { cls = 'role potato'; txt = me.stun > 0 ? 'You have the potato · hold on…' : 'POTATO! Tag someone fast!'; }
        else txt = `Avoid the potato · ${alive} left`;
      } else if (mode === 'infection') {
        if (isIt) { cls = 'role zombie'; txt = `You're infected! Spread it · ${surv} left`; }
        else txt = surv <= 1 ? 'Last survivor!' : `Survive! ${surv} left`;
      } else if (isIt) { cls = 'role it'; txt = me.stun > 0 ? "You're IT · hold on…" : "You're IT! Tag someone!"; }
      else txt = !its.length ? 'Run!' : its.length === 1 ? `Run! ${its[0].n} is IT` : `Run! ${its.map((r) => r.n).join(' & ')} are IT`;
    } else if (st === STATE.COUNT) txt = `Round ${G.rd} · ${G.map.name}` + (mode !== 'classic' ? ' · ' + C.MODE_BY_ID[mode].name : '');
    else if (st === STATE.VOTE) txt = 'Vote for the next round';
    else if (st === STATE.RESULTS) txt = 'Round over';
    else txt = G.solo ? 'Warming up…' : 'Waiting for players';
    // Hot Potato fuse chip (only the holder sees the big one)
    const fz = $('fuse'), holding = mode === 'potato' && isIt;
    if (holding) {
      const f = Math.min(C.POTATO_START, ptFuse(G.id));
      fz.classList.remove('hidden'); fz.classList.toggle('danger', f < 3); $('fuseNum').textContent = f.toFixed(1);
      const c = Math.ceil(f);
      if (f <= 5 && c !== G.lastFuseTick) { G.lastFuseTick = c; Sfx.play('fuse'); if (!RM.matches) gsap.fromTo('#fuseNum', { scale: 1.25 }, { scale: 1, duration: 0.3, ease: 'back.out(3)' }); }
    } else { fz.classList.add('hidden'); G.lastFuseTick = -1; }
    if (st === STATE.VOTE) { const bar = $('voteBar'); bar.style.transform = `scaleX(${clamp(left / (G.voteDur || 14), 0, 1).toFixed(3)})`; $('voteTimer').textContent = Math.ceil(left); }
    if (txt !== lastRole) {
      lastRole = txt; role.textContent = txt; role.className = cls;
      gsap.fromTo(role, { scale: 0.85 }, { scale: 1, duration: 0.4, ease: 'back.out(3)' });
    }

    const w = $('waiting');
    if (st === STATE.WAIT && !G.solo) { if (w.classList.contains('hidden')) { w.classList.remove('hidden'); w.textContent = 'Waiting for one more player…'; gsap.fromTo(w, { y: 20, opacity: 0 }, { y: 0, opacity: 1, duration: 0.4 }); } }
    else w.classList.add('hidden');

    // ability button
    const def = CHARS[me.c], p = me.cd > 0 ? 1 - me.cd / def.cd : 1;
    abBtn.style.setProperty('--p', p.toFixed(3));
    const bat = def.id === 'bat' && me.aux > 0, pounce = def.id === 'cat' && me.abT > 0 && def.dur - me.abT > 0.25;
    const label = bat ? 'Recall' : pounce ? 'Pounce' : def.ability;
    if (label !== lastAbLabel) { lastAbLabel = label; $('abName').textContent = label; if (bat || pounce) gsap.fromTo(abBtn, { scale: 0.85 }, { scale: 1, duration: 0.4, ease: 'back.out(3)', clearProps: 'transform' }); }
    const ready = (me.cd <= 0 || bat || pounce) && me.stun <= 0;
    abBtn.classList.toggle('cd', me.cd > 0 && !bat && !pounce); abBtn.classList.toggle('ready', ready); abBtn.classList.toggle('stunned', me.stun > 0);
    if (ready && !G.wasReady && st === STATE.PLAY) gsap.fromTo(abBtn, { scale: 0.85 }, { scale: 1, duration: 0.5, ease: 'back.out(3)', clearProps: 'transform' });
    G.wasReady = ready;
    const cdText = me.cd > 0 && !bat && !pounce ? String(Math.ceil(me.cd)) : '';
    if ($('abCd').textContent !== cdText) $('abCd').textContent = cdText;

    const now = performance.now();
    if (now - G.lastBoard > 250) { G.lastBoard = now; drawBoard(); }
    if (st === STATE.RESULTS) $('resNext').textContent = `${G.solo || (G.sv && G.sv.mode === 'vote') ? 'Vote opens' : 'Next round'} in ${Math.ceil(left)}…`;
  }

  /* scoreboard: rows are persistent elements, re-ordered with GSAP Flip */
  function makeRow(r) {
    const d = el('div', 'brow'); const img = new Image(); img.alt = ''; img.src = Chars.avatar(r.c, r.k, 48, r.h);
    d.append(el('span', 'rk'), img, el('span', 'nm', r.n));
    if (r.a) d.append(el('span', 'ck', '✓'));
    if (r.b) d.append(el('span', 'bt', 'BOT'));
    d.append(el('span', 'tg', 'IT'), el('span', 'sc'));
    return d;
  }
  function drawBoard() {
    const rows = [...G.roster.values()].sort((a, b) => b.sc - a.sc || a.id - b.id).slice(0, 12), box = $('board'), keep = new Set(rows.map((r) => r.id));
    for (const [id, e] of rowEls) if (!keep.has(id)) { rowEls.delete(id); e.remove(); }
    const order = rows.map((r) => r.id).join(',');
    const reorder = order !== G.boardOrder; G.boardOrder = order;
    const state = reorder && rowEls.size ? Flip.getState([...rowEls.values()]) : null;
    const fresh = [];
    rows.forEach((r, i) => {
      let e = rowEls.get(r.id);
      if (!e) { e = makeRow(r); rowEls.set(r.id, e); box.appendChild(e); fresh.push(e); }
      const isIt = G.state === STATE.PLAY && !!(r.fl & 1), live = G.state === STATE.PLAY || G.state === STATE.COUNT, outR = live && !!(r.fl & 16), waitR = live && !!(r.fl & 32);
      e.classList.toggle('me', r.id === G.id); e.classList.toggle('it', isIt); e.classList.toggle('out', outR || waitR);
      const tg = e.querySelector('.tg'), lbl = isIt ? (G.mode === 'potato' ? 'POTATO' : G.mode === 'infection' ? 'ZOMBIE' : 'IT') : waitR ? 'NEXT' : outR ? 'OUT' : '';
      const tcls = 'tg' + (isIt ? (G.mode === 'potato' ? ' pt' : G.mode === 'infection' ? ' zb' : '') : lbl ? ' gh' : '');
      if (tg.textContent !== lbl) tg.textContent = lbl; if (tg.className !== tcls) tg.className = tcls; tg.style.display = lbl ? '' : 'none';
      const rk = e.querySelector('.rk'), sc = e.querySelector('.sc');
      if (rk.textContent !== String(i + 1)) rk.textContent = i + 1;
      if (sc.textContent !== String(r.sc)) sc.textContent = r.sc;
    });
    if (reorder) {
      rows.forEach((r) => box.appendChild(rowEls.get(r.id)));
      if (state) Flip.from(state, { duration: 0.45, ease: 'power3.out' });
      if (fresh.length) gsap.from(fresh, { opacity: 0, x: 24, duration: 0.35, ease: 'power2.out' });
    }
  }

  /* ================================ vote screen ================================ */
  const RM = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const ptFuse = (id) => { const v = G.pt.get(id); return v === undefined ? 0 : Math.max(0, v - (performance.now() - G.ptAt) / 1000); };
  const voteEl = $('vote'), voteBtns = { m: [], d: [] };
  let voteKey = '', myVote = { m: -1, d: -1 }, voteTween = null;
  function castVote(kind, i, btn) {
    if (myVote[kind] === i) return;
    myVote[kind] = i; send({ t: 'vote', k: kind, i }); Sfx.play('vote');
    paintVote();
    if (!RM.matches && btn) gsap.fromTo(btn, { scale: 0.93 }, { scale: 1, duration: 0.4, ease: 'back.out(3)', clearProps: 'transform' });
  }
  const thumbs = new Map();
  function mapThumb(m) {
    let base = thumbs.get(m.id); if (!base) { base = MapRender.miniBase(m, 240, true); thumbs.set(m.id, base); }
    const cv = document.createElement('canvas'); cv.width = base.width; cv.height = base.height; cv.getContext('2d').drawImage(base, 0, 0);
    cv.setAttribute('role', 'img'); cv.setAttribute('aria-label', m.name + ' map'); return cv;
  }
  const MODE_ICONS = {
    classic: '<rect width="64" height="64" rx="12" fill="#ffe0e3"/><circle cx="32" cy="32" r="19" fill="#ff4d5e" stroke="#14122b" stroke-width="3.5"/><text x="32" y="39" text-anchor="middle" font-family="Arial Black,Arial,sans-serif" font-weight="900" font-size="20" fill="#fff">IT</text><path d="M10 14l9 5M54 14l-9 5M8 50l10-4M56 50l-10-4" stroke="#14122b" stroke-width="3" stroke-linecap="round"/>',
    infection: '<rect width="64" height="64" rx="12" fill="#dff7e3"/><g stroke="#14122b" stroke-width="3" stroke-linecap="round"><path d="M32 8v8M32 48v8M8 32h8M48 32h8M15 15l6 6M43 43l6 6M49 15l-6 6M21 43l-6 6"/></g><circle cx="32" cy="32" r="17" fill="#4fcf6a" stroke="#14122b" stroke-width="3.5"/><circle cx="26" cy="29" r="4" fill="#fff" stroke="#14122b" stroke-width="2"/><circle cx="38" cy="29" r="4" fill="#fff" stroke="#14122b" stroke-width="2"/><circle cx="26.5" cy="29.5" r="1.6" fill="#14122b"/><circle cx="37.5" cy="29.5" r="1.6" fill="#14122b"/><path d="M25 39h14" stroke="#14122b" stroke-width="3" stroke-linecap="round"/><path d="M28 39v3M32 39v3M36 39v3" stroke="#14122b" stroke-width="2"/>',
    potato: '<rect width="64" height="64" rx="12" fill="#ffeacc"/><ellipse cx="31" cy="40" rx="20" ry="15" fill="#c98a4b" stroke="#14122b" stroke-width="3.5" transform="rotate(-12 31 40)"/><g fill="#7a4a22" opacity=".6"><circle cx="22" cy="38" r="2.2"/><circle cx="34" cy="45" r="2.2"/><circle cx="40" cy="35" r="2.2"/><circle cx="28" cy="46" r="1.6"/></g><path d="M36 26c4-5 8-5 11-9" fill="none" stroke="#14122b" stroke-width="3" stroke-linecap="round"/><path d="M50 8l2.6 5.4 5.4 2.6-5.4 2.6L50 24l-2.6-5.4-5.4-2.6 5.4-2.6z" fill="#ffd23f" stroke="#14122b" stroke-width="2.2" stroke-linejoin="round"/>',
  };
  function modeIcon(id) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 64 64'); s.setAttribute('aria-hidden', 'true');
    s.innerHTML = MODE_ICONS[id] || MODE_ICONS.classic; return s;
  }
  function buildVote(vc, key) {
    voteKey = key; myVote = { m: -1, d: -1 }; voteBtns.m = []; voteBtns.d = []; G.voteDur = Math.max(1, G.tl);
    const mk = (kind, i, name, blurb, keyNo, id, img) => {
      const b = el('button', 'vopt'); b.type = 'button'; if (id) b.dataset.mode = id;
      img.classList.add('vimg');
      b.append(img, el('b', '', name), el('span', '', blurb), el('i', 'vn', '0'), el('i', 'vk', String(keyNo)));
      b.addEventListener('click', () => castVote(kind, i, b)); b._n = 0; return b;
    };
    const maps = $('voteMaps'), modes = $('voteModes'); maps.replaceChildren(); modes.replaceChildren();
    maps.classList.toggle('one', vc.m.length === 1); $('voteMapsLbl').textContent = vc.m.length === 1 ? 'Arena (fixed on this server)' : 'Arena';
    vc.m.forEach((id, i) => { const m = C.MAP_BY_ID[id]; if (!m) return; const b = mk('m', i, m.name, m.blurb || '', i + 1, '', mapThumb(m)); voteBtns.m.push(b); maps.appendChild(b); });
    vc.d.forEach((id, i) => { const m = C.MODE_BY_ID[id]; if (!m) return; const b = mk('d', i, m.name, m.blurb, i + 4, id, modeIcon(id)); voteBtns.d.push(b); modes.appendChild(b); });
    const few = vc.d.length < 2;       // under 7 players: only classic tag, so there is nothing to vote on
    modes.classList.toggle('hidden', few); $('voteModesLbl').textContent = few ? `Infection & Hot Potato unlock at ${C.MODE_MIN_PLAYERS}+ players` : 'Game mode';
    $('voteHint').textContent = few ? 'Tap an arena to vote · keys 1-3' : 'Tap to vote · keys 1-3 arena, 4-6 mode';
    const wasHidden = voteEl.classList.contains('hidden');
    voteEl.classList.remove('hidden');
    if (voteTween) voteTween.kill();
    if (RM.matches) gsap.set(voteEl, { autoAlpha: 1 });
    else {
      voteTween = gsap.timeline()
        .fromTo(voteEl, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.25, ease: 'power1.out' })
        .from('.vote-card', { y: 70, scale: 0.92, rotation: 1.5, duration: 0.55, ease: 'back.out(1.7)' }, 0)
        .from('.vopt', { y: 24, opacity: 0, stagger: 0.05, duration: 0.35, ease: 'power2.out' }, 0.2);
    }
    void wasHidden;
  }
  function paintVote(vt) {
    for (const kind of ['m', 'd']) {
      const counts = vt ? vt[kind] : null, btns = voteBtns[kind], top = counts ? Math.max(0, ...counts) : 0;
      btns.forEach((b, i) => {
        b.classList.toggle('picked', myVote[kind] === i);
        if (!counts) return;
        const n = counts[i] || 0, pill = b.querySelector('.vn');
        b.classList.toggle('lead', top > 0 && n === top && myVote[kind] !== i);
        if (n !== b._n) { pill.textContent = n; if (n > b._n && !RM.matches) gsap.fromTo(pill, { scale: 1.6 }, { scale: 1, duration: 0.4, ease: 'back.out(3)' }); b._n = n; }
      });
    }
  }
  function updateVote(vc, vt) {
    const key = vc.m.join(',') + '|' + vc.d.join(',') + '|' + G.rd;
    if (key !== voteKey || voteEl.classList.contains('hidden')) buildVote(vc, key);
    paintVote(vt);
  }
  function hideVote(now) {
    voteKey = ''; if (voteTween) { voteTween.kill(); voteTween = null; }
    if (voteEl.classList.contains('hidden')) return;
    if (now || RM.matches) { gsap.set(voteEl, { clearProps: 'all' }); voteEl.classList.add('hidden'); return; }
    gsap.to(voteEl, { autoAlpha: 0, duration: 0.25, overwrite: true, onComplete: () => { if (G.state !== STATE.VOTE) { voteEl.classList.add('hidden'); gsap.set(voteEl, { clearProps: 'all' }); } } });
  }

  function showResults() {
    const res = (G.res || []).map((r) => ({ r: G.roster.get(r[0]), s: r[1], t: r[2] })).filter((x) => x.r);
    if (!res.length) return;
    // ranks: equal scores share a rank (1,1,3...), and everyone tied for first shares the win
    res.forEach((x, i) => { x.rank = i && x.s === res[i - 1].s ? res[i - 1].rank : i + 1; });
    const winners = res.filter((x) => x.rank === 1), mine = winners.some((x) => x.r.id === G.id);
    const md = C.MODE_BY_ID[G.mode]; document.querySelector('.results-card .kicker').textContent = 'Round over' + (md && md.id !== 'classic' ? ' · ' + md.name : '');
    const rw = $('resWin'); rw.className = 'res-win hidden'; rw.textContent = '';
    if (mine) {
      if (G.solo) { rw.className = 'res-win guest'; rw.textContent = 'Practice rounds don\u2019t earn wins. Play online to collect them.'; }
      else if (!G.acct) { rw.className = 'res-win guest'; rw.textContent = 'You won! Sign up to save wins and unlock characters.'; }
    }
    const wn = winners.map((x) => x.r.n);
    $('resTitle').textContent = mine ? (winners.length > 1 ? 'You share the win!' : 'You win!')
      : winners.length === 1 ? `${wn[0]} wins!` : winners.length === 2 ? `${wn[0]} & ${wn[1]} win!` : `${wn[0]} & ${winners.length - 1} others win!`;
    const pod = $('podium'); pod.innerHTML = '';
    [1, 0, 2].forEach((i) => {
      const x = res[i]; if (!x) return;
      const d = el('div', 'pod p' + Math.min(3, x.rank)); d.dataset.rank = i; const img = new Image(); img.alt = ''; img.src = Chars.avatar(x.r.c, x.r.k, 96, x.r.h);
      d.append(img, el('div', 'pn', x.r.n), el('div', 'ps', `${x.s} pts · ${x.t} tags`), el('div', 'bar', String(x.rank))); pod.appendChild(d);
    });
    const list = $('resList'); list.innerHTML = '';
    res.slice(3, 6).forEach((x, i) => { const d = el('div', 'brow' + (x.r.id === G.id ? ' me' : '')); const img = new Image(); img.alt = ''; img.src = Chars.avatar(x.r.c, x.r.k, 48, x.r.h); d.append(el('span', 'rk', String(x.rank)), img, el('span', 'nm', x.r.n), el('span', 'sc', x.s + ' pts')); list.appendChild(d); });
    const myRank = res.findIndex((x) => x.r.id === G.id);
    if (myRank > 5) { const x = res[myRank], d = el('div', 'brow me'); d.append(el('span', 'rk', String(x.rank)), el('span', '', ''), el('span', 'nm', x.r.n), el('span', 'sc', x.s + ' pts')); list.appendChild(d); }
    const box = $('results'); box.classList.remove('hidden');
    gsap.killTweensOf(box); gsap.fromTo(box, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3 });
    const tl = gsap.timeline();
    tl.from('.results-card', { y: 90, scale: 0.9, rotation: 2, opacity: 0, duration: 0.6, ease: 'back.out(1.7)' })
      .from('#resTitle', { yPercent: 60, opacity: 0, duration: 0.5, ease: 'power3.out' }, '-=0.3');
    [2, 1, 0].forEach((rank, n) => {
      const p = pod.querySelector(`[data-rank="${rank}"]`); if (!p) return;
      tl.from(p.querySelector('.bar'), { scaleY: 0, transformOrigin: 'bottom', duration: 0.45, ease: 'power3.out' }, 0.5 + n * 0.22)
        .from(p.querySelector('img'), { y: -70, opacity: 0, scale: 0.6, duration: 0.5, ease: 'bounce.out' }, 0.62 + n * 0.22)
        .from([p.querySelector('.pn'), p.querySelector('.ps')], { opacity: 0, y: 10, duration: 0.3 }, 0.8 + n * 0.22);
    });
    tl.from('#resList .brow', { x: -30, opacity: 0, stagger: 0.08, duration: 0.35 }, '-=0.1');
    if (mine && G.me) { Particles.confetti(G.me.x, G.me.y - 40, 110); G.shake = 6; }
    document.body.classList.remove('is-it');
  }
  function hideResults() {
    const box = $('results');
    gsap.to(box, { autoAlpha: 0, duration: 0.25, overwrite: true, onComplete: () => { if (G.state !== STATE.RESULTS) box.classList.add('hidden'); } });
  }

  function overlay(msg) { $('overlayMsg').textContent = msg || ''; $('overlay').classList.toggle('hidden', !msg); if (msg) gsap.fromTo('.overlay-card', { y: 30, scale: 0.92, opacity: 0 }, { y: 0, scale: 1, opacity: 1, duration: 0.4, ease: 'back.out(2)' }); }

  /* ============================== site-facing API ============================ */
  Game.show = () => { resize(); G.camSnap = true; G.zoom = G.zoomT; lastRole = ''; };
  Game.begin = () => {
    const tl = gsap.timeline({ defaults: { ease: 'power3.out' } });
    tl.from('.hud-tools', { y: -60, opacity: 0, duration: 0.6 }, 0)
      .from('#boardWrap', { x: 120, opacity: 0, duration: 0.6 }, 0.1)
      .from('.hud-top', { y: -50, opacity: 0, duration: 0.6 }, 0.15)
      .from('#mini', { x: -120, opacity: 0, duration: 0.6 }, 0.2)
      .from('#chat', { x: -80, opacity: 0, duration: 0.6, clearProps: 'transform,opacity' }, 0.25)
      .from('#abilityBtn', { scale: 0, rotation: -90, duration: 0.7, ease: 'back.out(2.4)' }, 0.3);
    const def = CHARS[G.sel.c];
    setTimeout(() => { if (G.inGame) toast(touchy ? `Drag to move · tap ${def.ability}` : def.id === 'avocado' ? 'WASD to move · aim with the mouse · CLICK or SPACE to shoot' : `WASD to move · SPACE for ${def.ability} · ENTER to chat`); }, 900);
  };
  Game.leave = () => {
    closeWs(); G.inGame = false; G.me = null; G.state = STATE.WAIT; G.joinResolve = null;
    document.body.classList.remove('is-it'); releaseAll(); closeChat(true); chatLog.innerHTML = '';
    $('results').classList.add('hidden'); $('overlay').classList.add('hidden'); $('waiting').classList.add('hidden'); hideVote(true);
    $('feed').innerHTML = ''; $('toasts').innerHTML = ''; $('banner').innerHTML = ''; $('countdown').textContent = '';
    gsap.killTweensOf('#hud *'); gsap.set('#hud *', { clearProps: 'all' });
    Particles.clear();
  };

  /* ================================ main loop =============================== */
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000); last = now; G.t += dt;
    if (G.inGame && G.me && G.map && window.App && App.inGame) {
      G.acc += dt; let n = 0;
      while (G.acc >= DT && n < 6) { simStep(); G.acc -= DT; n++; }
      if (n === 6) G.acc = 0;
      G.sendTimer += dt; if (G.sendTimer >= 0.016) { G.sendTimer = 0; flushInputs(); }   // ~60 packets/s: every input leaves right away, ping is what we can't fix
      Particles.update(dt);
      render(dt, G.t);
      updateHud();
    }
  }
  setInterval(() => { if (G.inGame) { send({ t: 'p', ts: performance.now() }); if (document.hidden) flushInputs(); } }, 2000);
  requestAnimationFrame(frame);
})();
