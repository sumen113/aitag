/* Tag Rush - map rendering (themed vector floors, obstacles, zones), particles, minimap. */
const MapRender = (() => {
  const C = TagShared;
  const decorCache = new Map();
  const TAU = Math.PI * 2;

  function decorFor(map) {
    let d = decorCache.get(map.id);
    if (d) return d;
    const R = C.mulberry32(map.id.length * 7919 + map.w), items = [];
    const free = (x, y, r) => C.circleFree(map, x, y, r);
    if (map.theme === 'park') {
      for (let i = 0; i < 520; i++) { const x = R() * map.w, y = R() * map.h; if (free(x, y, 6)) items.push({ k: 'tuft', x, y, s: 0.7 + R() * 0.8 }); }
      const cols = ['#ffffff', '#ffd166', '#ff8fab', '#b8a1ff'];
      for (let i = 0; i < 90; i++) { const x = R() * map.w, y = R() * map.h; if (free(x, y, 8)) items.push({ k: 'flower', x, y, c: cols[(R() * 4) | 0], s: 0.8 + R() * 0.6 }); }
    } else if (map.theme === 'frost') {
      for (let i = 0; i < 36; i++) {
        let x = R() * map.w, y = R() * map.h, a = R() * TAU; const pts = [[x, y]];
        for (let j = 0; j < 5; j++) { a += (R() - 0.5) * 1.2; x += Math.cos(a) * (30 + R() * 50); y += Math.sin(a) * (30 + R() * 50); pts.push([x, y]); }
        items.push({ k: 'crack', pts });
      }
      for (let i = 0; i < 70; i++) items.push({ k: 'spark', x: R() * map.w, y: R() * map.h, p: R() * TAU, s: 1 + R() * 2 });
    } else if (map.theme === 'candy') {
      const cols = ['#ff6fa8', '#6fd6ff', '#ffe066', '#9dff8a', '#c493ff'];
      for (let i = 0; i < 260; i++) { const x = R() * map.w, y = R() * map.h; if (free(x, y, 8)) items.push({ k: 'sprinkle', x, y, a: R() * Math.PI, c: cols[(R() * 5) | 0] }); }
    } else if (map.theme === 'city') {
      for (let i = 0; i < 160; i++) { const x = R() * map.w, y = R() * map.h; if (free(x, y, 10)) items.push({ k: 'crack', pts: [[x, y], [x + (R() - 0.5) * 60, y + (R() - 0.5) * 60], [x + (R() - 0.5) * 110, y + (R() - 0.5) * 110]] }); }
      for (let i = 0; i < 70; i++) { const x = R() * map.w, y = R() * map.h; if (free(x, y, 24)) items.push({ k: 'puddle', x, y, s: 14 + R() * 20 }); }
    } else if (map.theme === 'neon') {
      for (let i = 0; i < 60; i++) items.push({ k: 'spark', x: R() * map.w, y: R() * map.h, p: R() * TAU, s: 1 + R() * 2 });
    }
    decorCache.set(map.id, d = items);
    return d;
  }

  const vis = (v, x, y, w, h) => !(x > v.x1 || y > v.y1 || x + w < v.x0 || y + h < v.y0);

  /* --------------------------------- floors --------------------------------- */
  function drawFloor(g, map, v, t) {
    const W = map.w, H = map.h;
    g.save();
    g.beginPath(); g.rect(0, 0, W, H); g.clip();
    const x0 = Math.max(0, v.x0), y0 = Math.max(0, v.y0), x1 = Math.min(W, v.x1), y1 = Math.min(H, v.y1);
    const th = map.theme;
    if (th === 'park') {
      g.fillStyle = '#6dcf68'; g.fillRect(0, 0, W, H);
      for (let x = Math.floor(x0 / 130) * 130; x < x1; x += 130) if (((x / 130) | 0) % 2 === 0) { g.fillStyle = 'rgba(255,255,255,.06)'; g.fillRect(x, y0, 130, y1 - y0); }
      const pond = map.obs.find((o) => o.k === 'pond');
      if (pond) { g.beginPath(); g.arc(pond.x, pond.y, pond.r + 78, 0, TAU); g.strokeStyle = '#ecdcae'; g.lineWidth = 64; g.stroke(); g.strokeStyle = 'rgba(0,0,0,.06)'; g.lineWidth = 3; g.beginPath(); g.arc(pond.x, pond.y, pond.r + 110, 0, TAU); g.stroke(); g.beginPath(); g.arc(pond.x, pond.y, pond.r + 46, 0, TAU); g.stroke(); }
      for (const d of decorFor(map)) {
        if (d.x < x0 - 20 || d.x > x1 + 20 || d.y < y0 - 20 || d.y > y1 + 20) continue;
        if (d.k === 'tuft') { g.strokeStyle = '#4bb352'; g.lineWidth = 2; g.lineCap = 'round'; g.beginPath(); for (const a of [-0.5, 0, 0.5]) { g.moveTo(d.x, d.y); g.lineTo(d.x + Math.sin(a) * 6 * d.s, d.y - 8 * d.s); } g.stroke(); }
        else { g.fillStyle = d.c; for (let i = 0; i < 5; i++) { const a = i * TAU / 5; g.beginPath(); g.arc(d.x + Math.cos(a) * 3.2 * d.s, d.y + Math.sin(a) * 3.2 * d.s, 2.2 * d.s, 0, TAU); g.fill(); } g.fillStyle = '#ffb300'; g.beginPath(); g.arc(d.x, d.y, 1.8 * d.s, 0, TAU); g.fill(); }
      }
    } else if (th === 'neon') {
      g.fillStyle = '#0b0924'; g.fillRect(0, 0, W, H);
      const rg = g.createRadialGradient(W / 2, H / 2, 40, W / 2, H / 2, W * 0.55); rg.addColorStop(0, 'rgba(120,50,220,.38)'); rg.addColorStop(1, 'rgba(20,10,60,0)');
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
      g.lineWidth = 1.5;
      for (let x = Math.floor(x0 / 100) * 100; x <= x1; x += 100) { g.strokeStyle = x % 500 === 0 ? 'rgba(70,110,255,.55)' : 'rgba(60,70,200,.28)'; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); }
      for (let y = Math.floor(y0 / 100) * 100; y <= y1; y += 100) { g.strokeStyle = y % 500 === 0 ? 'rgba(70,110,255,.55)' : 'rgba(60,70,200,.28)'; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
      for (const d of decorFor(map)) { g.globalAlpha = 0.25 + 0.5 * Math.abs(Math.sin(t * 1.3 + d.p)); g.fillStyle = '#7df9ff'; g.fillRect(d.x, d.y, d.s, d.s); }
      g.globalAlpha = 1;
    } else if (th === 'frost') {
      const gr = g.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#d9f3ff'); gr.addColorStop(1, '#a9dcf5');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
      g.lineWidth = 1.6; g.strokeStyle = 'rgba(120,175,210,.55)'; g.lineJoin = 'round';
      for (const d of decorFor(map)) {
        if (d.k === 'crack') { g.beginPath(); g.moveTo(d.pts[0][0], d.pts[0][1]); for (let i = 1; i < d.pts.length; i++) g.lineTo(d.pts[i][0], d.pts[i][1]); g.stroke(); }
        else if (d.x > x0 && d.x < x1 && d.y > y0 && d.y < y1) { g.globalAlpha = 0.3 + 0.7 * Math.abs(Math.sin(t * 1.7 + d.p)); g.fillStyle = '#fff'; g.fillRect(d.x - d.s, d.y - 0.5, d.s * 2, 1); g.fillRect(d.x - 0.5, d.y - d.s, 1, d.s * 2); g.globalAlpha = 1; }
      }
      g.globalAlpha = 0.12; g.fillStyle = '#fff';
      for (let i = -2; i < 14; i++) { g.beginPath(); g.moveTo(i * 220, 0); g.lineTo(i * 220 + 70, 0); g.lineTo(i * 220 + 70 + H, H); g.lineTo(i * 220 + H, H); g.fill(); }
      g.globalAlpha = 1;
    } else if (th === 'candy') {
      const s = 150;
      for (let x = Math.floor(x0 / s) * s; x < x1; x += s) for (let y = Math.floor(y0 / s) * s; y < y1; y += s) { g.fillStyle = (((x / s) + (y / s)) & 1) ? '#ffe3f0' : '#fff5fa'; g.fillRect(x, y, s, s); }
      g.lineCap = 'round'; g.lineWidth = 4;
      for (const d of decorFor(map)) { if (d.x < x0 || d.x > x1 || d.y < y0 || d.y > y1) continue; g.strokeStyle = d.c; g.beginPath(); g.moveTo(d.x - Math.cos(d.a) * 5, d.y - Math.sin(d.a) * 5); g.lineTo(d.x + Math.cos(d.a) * 5, d.y + Math.sin(d.a) * 5); g.stroke(); }
    } else if (th === 'city') {
      g.fillStyle = '#3b404c'; g.fillRect(0, 0, W, H);
      const M = 200, ST = 240, bw = (W - 2 * M - 4 * ST) / 5, bh = (H - 2 * M - 2 * ST) / 3;
      g.fillStyle = '#4c5260';                                                         // pavement under each block
      for (let i = 0; i < 5; i++) for (let j = 0; j < 3; j++) { const x = M + i * (bw + ST), y = M + j * (bh + ST); if (x + bw > x0 && x < x1 && y + bh > y0 && y < y1) { g.beginPath(); g.roundRect(x - 10, y - 10, bw + 20, bh + 20, 18); g.fill(); } }
      g.strokeStyle = 'rgba(255,214,102,.55)'; g.lineWidth = 6; g.setLineDash([46, 38]);   // dashed lane lines down the middle of every street
      const hy = [M / 2, M + bh + ST / 2, M + 2 * bh + ST + ST / 2, H - M / 2], vx = [M / 2, M + bw + ST / 2, M + 2 * bw + ST + ST / 2, M + 3 * bw + 2 * ST + ST / 2, M + 4 * bw + 3 * ST + ST / 2, W - M / 2];
      for (const y of hy) { if (y < y0 - 10 || y > y1 + 10) continue; g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
      for (const x of vx) { if (x < x0 - 10 || x > x1 + 10) continue; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); }
      g.setLineDash([]);
      for (const d of decorFor(map)) {
        if (d.k === 'crack') { const q = d.pts[0]; if (q[0] < x0 - 120 || q[0] > x1 + 120 || q[1] < y0 - 120 || q[1] > y1 + 120) continue; g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 2; g.beginPath(); d.pts.forEach((pt, i) => (i ? g.lineTo(pt[0], pt[1]) : g.moveTo(pt[0], pt[1]))); g.stroke(); }
        else { if (d.x < x0 - 40 || d.x > x1 + 40 || d.y < y0 - 40 || d.y > y1 + 40) continue; g.fillStyle = 'rgba(120,170,220,.22)'; g.beginPath(); g.ellipse(d.x, d.y, d.s * 1.4, d.s, 0.3, 0, TAU); g.fill(); }
      }
    } else {                                                          // station
      g.fillStyle = '#1b2340'; g.fillRect(0, 0, W, H);
      const s = 160;
      g.lineWidth = 2; g.strokeStyle = '#2c3862';
      for (let x = Math.floor(x0 / s) * s; x <= x1; x += s) { g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y1); g.stroke(); }
      for (let y = Math.floor(y0 / s) * s; y <= y1; y += s) { g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); }
      g.fillStyle = '#3a4878';
      for (let x = Math.floor(x0 / s) * s; x <= x1; x += s) for (let y = Math.floor(y0 / s) * s; y <= y1; y += s) { g.beginPath(); g.arc(x + 8, y + 8, 2.4, 0, TAU); g.arc(x - 8, y + 8, 2.4, 0, TAU); g.arc(x + 8, y - 8, 2.4, 0, TAU); g.arc(x - 8, y - 8, 2.4, 0, TAU); g.fill(); }
      g.fillStyle = 'rgba(80,140,255,.06)'; g.beginPath(); g.arc(W / 2, H / 2, 420, 0, TAU); g.fill();
    }
    g.restore();
  }

  function drawBorder(g, map) {
    const col = { park: ['#8a5a2e', '#5a3a1c'], neon: ['#ff3df2', '#7a1a8a'], frost: ['#7fb5d6', '#4a7d9c'], candy: ['#ff7eb6', '#c24886'], station: ['#8fa0d6', '#4b5a8c'], city: ['#ffb64d', '#6b4a1a'] }[map.theme];
    g.lineJoin = 'round';
    g.strokeStyle = col[1]; g.lineWidth = 40; g.strokeRect(-14, -14, map.w + 28, map.h + 28);
    g.strokeStyle = col[0]; g.lineWidth = 14; g.strokeRect(-4, -4, map.w + 8, map.h + 8);
    if (map.theme === 'neon') { g.strokeStyle = 'rgba(255,61,242,.25)'; g.lineWidth = 34; g.strokeRect(-4, -4, map.w + 8, map.h + 8); }
  }

  /* -------------------------------- zones ----------------------------------- */
  function drawZones(g, map, v, t) {
    const th = map.theme;
    for (const z of map.zones) {
      if (z.k === 'mud') {
        if (z.x + z.r < v.x0 || z.x - z.r > v.x1 || z.y + z.r < v.y0 || z.y - z.r > v.y1) continue;
        const jelly = th === 'candy';
        g.beginPath(); g.arc(z.x, z.y, z.r, 0, TAU);
        g.fillStyle = jelly ? 'rgba(170,100,255,.72)' : '#8a5a2d'; g.fill();
        g.lineWidth = 5; g.strokeStyle = jelly ? '#8e49e0' : '#684219'; g.stroke();
        g.fillStyle = jelly ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.18)';
        for (let i = 0; i < 5; i++) { const a = i * 1.9 + z.x; const rr = z.r * (0.25 + 0.5 * ((i * 37) % 10) / 10); const pul = 1 + Math.sin(t * 2 + i) * 0.15; g.beginPath(); g.arc(z.x + Math.cos(a) * rr, z.y + Math.sin(a) * rr, (6 + i) * pul * (jelly ? 1.2 : 1), 0, TAU); g.fill(); }
      } else if (z.k === 'grip') {
        if (z.x + z.r < v.x0 || z.x - z.r > v.x1 || z.y + z.r < v.y0 || z.y - z.r > v.y1) continue;
        g.beginPath(); g.arc(z.x, z.y, z.r, 0, TAU); g.fillStyle = 'rgba(255,255,255,.88)'; g.fill();
        g.lineWidth = 4; g.strokeStyle = 'rgba(190,225,245,.9)'; g.stroke();
        g.fillStyle = 'rgba(170,205,230,.6)';
        for (let i = 0; i < 9; i++) { const a = i * 2.4 + z.y; const rr = z.r * (0.2 + 0.65 * ((i * 53) % 10) / 10); g.beginPath(); g.arc(z.x + Math.cos(a) * rr, z.y + Math.sin(a) * rr, 3, 0, TAU); g.fill(); }
      } else if (z.k === 'boost') {
        if (z.x + z.r < v.x0 || z.x - z.r > v.x1 || z.y + z.r < v.y0 || z.y - z.r > v.y1) continue;
        const col = { neon: '#2ff3ff', candy: '#a6ff5e', station: '#ffd166', park: '#ffd166', frost: '#ffd166' }[th];
        g.beginPath(); g.arc(z.x, z.y, z.r, 0, TAU); g.fillStyle = 'rgba(8,14,36,.72)'; g.fill();
        g.lineWidth = 4; g.strokeStyle = col; g.stroke();
        g.save(); g.translate(z.x, z.y); g.rotate(z.a); g.beginPath(); g.arc(0, 0, z.r - 2, 0, TAU); g.clip();
        g.strokeStyle = col; g.lineWidth = 6; g.lineCap = 'round'; g.lineJoin = 'round';
        for (let i = 0; i < 3; i++) { const ph = ((t * 1.4 + i / 3) % 1); const x = -z.r * 0.7 + ph * z.r * 1.4; g.globalAlpha = Math.sin(ph * Math.PI); g.beginPath(); g.moveTo(x - 9, -14); g.lineTo(x + 5, 0); g.lineTo(x - 9, 14); g.stroke(); }
        g.restore(); g.globalAlpha = 1;
      } else if (z.k === 'tele') {
        if (z.x + z.r < v.x0 || z.x - z.r > v.x1 || z.y + z.r < v.y0 || z.y - z.r > v.y1) continue;
        const col = z.pair ? '#ff78c4' : '#4cc9f0';
        const gr = g.createRadialGradient(z.x, z.y, 4, z.x, z.y, z.r * 1.3); gr.addColorStop(0, col); gr.addColorStop(0.55, 'rgba(10,15,40,.85)'); gr.addColorStop(1, 'rgba(10,15,40,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(z.x, z.y, z.r * 1.3, 0, TAU); g.fill();
        g.lineWidth = 4; g.strokeStyle = col; g.setLineDash([14, 10]); g.lineDashOffset = -t * 40;
        g.beginPath(); g.arc(z.x, z.y, z.r, 0, TAU); g.stroke();
        g.lineDashOffset = t * 30; g.beginPath(); g.arc(z.x, z.y, z.r * 0.62, 0, TAU); g.stroke(); g.setLineDash([]);
      }
    }
  }

  /* ------------------------------- obstacles -------------------------------- */
  function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }

  function block(g, o, top, side, edge, h, r) {
    g.fillStyle = 'rgba(0,0,0,.24)'; rr(g, o.x + 6, o.y + h + 7, o.w, o.h, r); g.fill();
    g.fillStyle = side; rr(g, o.x, o.y + h, o.w, o.h, r); g.fill();
    g.lineWidth = 2.5; g.strokeStyle = edge; g.stroke();
    g.fillStyle = top; rr(g, o.x, o.y, o.w, o.h, r); g.fill(); g.stroke();
  }

  function drawObstacles(g, map, v, t) {
    const th = map.theme;
    for (const o of map.obs) {
      if (o.t === 'r') {
        if (!vis(v, o.x - 8, o.y - 8, o.w + 24, o.h + 30)) continue;
        switch (o.k) {
          case 'hedge':
            block(g, o, '#37a653', '#1f7038', '#17582c', 12, 8);
            g.fillStyle = 'rgba(120,230,140,.5)';
            for (let i = 0, n = Math.max(o.w, o.h); i < n; i += 15) { const x = o.w >= o.h ? o.x + 8 + i : o.x + o.w / 2, y = o.w >= o.h ? o.y + o.h / 2 : o.y + 8 + i; g.beginPath(); g.arc(x, y, 5.5, 0, TAU); g.fill(); }
            break;
          case 'bench':
            block(g, o, '#c58a55', '#80532c', '#5e3b1d', 9, 4);
            g.strokeStyle = 'rgba(70,40,15,.55)'; g.lineWidth = 2; g.beginPath(); for (let i = 1; i < 4; i++) { g.moveTo(o.x + (o.w * i) / 4, o.y + 2); g.lineTo(o.x + (o.w * i) / 4, o.y + o.h - 2); } g.stroke();
            break;
          case 'pillar': {
            block(g, o, '#1c1b52', '#0c0b2c', '#ff3df2', 16, 6);
            g.strokeStyle = 'rgba(255,61,242,.28)'; g.lineWidth = 9; rr(g, o.x, o.y, o.w, o.h, 6); g.stroke();
            g.fillStyle = '#2d2c80'; rr(g, o.x + 14, o.y + 14, o.w - 28, o.h - 28, 4); g.fill();
            break; }
          case 'core': {
            block(g, o, '#2a1066', '#12073a', '#2ff3ff', 18, 10);
            const p = 0.5 + 0.5 * Math.sin(t * 2.4);
            const gr = g.createRadialGradient(o.x + o.w / 2, o.y + o.h / 2, 2, o.x + o.w / 2, o.y + o.h / 2, o.w * 0.5); gr.addColorStop(0, 'rgba(47,243,255,' + (0.55 + 0.4 * p) + ')'); gr.addColorStop(1, 'rgba(47,243,255,0)');
            g.fillStyle = gr; g.fillRect(o.x, o.y, o.w, o.h);
            g.strokeStyle = 'rgba(47,243,255,.3)'; g.lineWidth = 8; rr(g, o.x, o.y, o.w, o.h, 10); g.stroke();
            break; }
          case 'bar':
            block(g, o, '#20215a', '#0e0e30', '#2ff3ff', 10, 5);
            g.strokeStyle = 'rgba(47,243,255,.22)'; g.lineWidth = 8; rr(g, o.x, o.y, o.w, o.h, 5); g.stroke();
            break;
          case 'berg':
            block(g, o, '#eefaff', '#a4d6ee', '#70b5d8', 14, 10);
            g.fillStyle = 'rgba(255,255,255,.85)'; rr(g, o.x + 6, o.y + 5, Math.max(8, o.w * 0.4), 7, 4); g.fill();
            break;
          case 'crate':
            block(g, o, '#c4934f', '#7e5629', '#59391a', 12, 4);
            g.strokeStyle = 'rgba(70,40,15,.6)'; g.lineWidth = 3; g.beginPath(); g.moveTo(o.x + 6, o.y + 6); g.lineTo(o.x + o.w - 6, o.y + o.h - 6); g.moveTo(o.x + o.w - 6, o.y + 6); g.lineTo(o.x + 6, o.y + o.h - 6); g.stroke();
            break;
          case 'bldg': {
            block(g, o, '#6f7a92', '#3d4660', '#262d44', 22, 6);
            g.fillStyle = 'rgba(255,255,255,.07)'; rr(g, o.x + 8, o.y + 8, o.w - 16, o.h - 16, 4); g.fill();
            g.fillStyle = '#ffd98a';                                                      // lit windows along the roof edge
            for (let i = 18; i < o.w - 14; i += 34) { g.globalAlpha = ((i * 7 + o.x) % 5) < 3 ? 0.9 : 0.25; g.fillRect(o.x + i, o.y + o.h + 4, 14, 9); }
            g.globalAlpha = 1; g.fillStyle = '#4b5470'; rr(g, o.x + o.w * 0.25, o.y + o.h * 0.3, Math.min(46, o.w * 0.3), Math.min(36, o.h * 0.25), 4); g.fill();
            break; }
          case 'car': {
            const horiz = o.w >= o.h, col = ['#e4572e', '#3a86ff', '#ffbe0b', '#8ac926', '#a259ff'][((o.x * 3 + o.y) | 0) % 5];
            block(g, o, col, '#1b1b2b', '#14141f', 8, 9);
            g.fillStyle = 'rgba(180,220,255,.8)'; if (horiz) rr(g, o.x + o.w * 0.3, o.y + 6, o.w * 0.35, o.h - 12, 5); else rr(g, o.x + 6, o.y + o.h * 0.3, o.w - 12, o.h * 0.35, 5); g.fill();
            break; }
          case 'barrier':
            block(g, o, '#ffcf4d', '#a67d10', '#6b4f08', 10, 4);
            g.strokeStyle = '#2b2b2b'; g.lineWidth = 7; g.save(); rr(g, o.x, o.y, o.w, o.h, 4); g.clip(); g.beginPath(); for (let i = -o.h; i < o.w + o.h; i += 26) { g.moveTo(o.x + i, o.y + o.h + 2); g.lineTo(o.x + i + o.h + 4, o.y - 2); } g.stroke(); g.restore();
            break;
          case 'wall':
            if (th === 'candy') {
              block(g, o, '#ff82b8', '#d4487f', '#a52c61', 12, 12);
              g.save(); rr(g, o.x, o.y, o.w, o.h, 12); g.clip(); g.strokeStyle = 'rgba(255,255,255,.8)'; g.lineWidth = 8;
              g.beginPath(); for (let i = -o.h; i < o.w + o.h; i += 22) { g.moveTo(o.x + i, o.y + o.h + 4); g.lineTo(o.x + i + o.h + 8, o.y - 4); } g.stroke(); g.restore();
            } else {
              block(g, o, '#5a6892', '#2c3859', '#93a4dc', 14, 5);
              g.fillStyle = '#ffd166';
              if (o.w >= o.h) for (let i = 20; i < o.w - 10; i += 46) { g.beginPath(); g.arc(o.x + i, o.y + o.h / 2, 2.6, 0, TAU); g.fill(); }
              else for (let i = 20; i < o.h - 10; i += 46) { g.beginPath(); g.arc(o.x + o.w / 2, o.y + i, 2.6, 0, TAU); g.fill(); }
            }
            break;
          default: block(g, o, '#888', '#555', '#333', 10, 4);
        }
      } else {
        if (!vis(v, o.x - o.r - 12, o.y - o.r - 20, o.r * 2 + 40, o.r * 2 + 50)) continue;
        if (o.k === 'tree') {
          g.fillStyle = 'rgba(0,0,0,.22)'; g.beginPath(); g.ellipse(o.x + 9, o.y + 18, o.r * 1.05, o.r * 0.7, 0, 0, TAU); g.fill();
          g.beginPath(); g.ellipse(o.x, o.y + o.r * 0.62, 11, 6, 0, 0, TAU); g.fillStyle = '#7a4e2d'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#4a2c14'; g.stroke();
          g.beginPath(); g.arc(o.x, o.y - 6, o.r + 4, 0, TAU); g.fillStyle = '#2e9348'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#1d6a31'; g.stroke();
          g.beginPath(); g.arc(o.x - 3, o.y - 9, o.r - 4, 0, TAU); g.fillStyle = '#46b85d'; g.fill();
          g.beginPath(); g.arc(o.x - 12, o.y - 19, o.r * 0.42, 0, TAU); g.fillStyle = '#74d983'; g.fill();
          g.fillStyle = '#ff6b6b'; for (const [dx, dy] of [[12, -2], [-16, 4], [4, -22]]) { g.beginPath(); g.arc(o.x + dx, o.y + dy, 3, 0, TAU); g.fill(); }
        } else if (o.k === 'pond') {
          g.beginPath(); g.arc(o.x, o.y, o.r + 16, 0, TAU); g.fillStyle = '#ead69b'; g.fill();
          const gr = g.createRadialGradient(o.x - 30, o.y - 40, 10, o.x, o.y, o.r); gr.addColorStop(0, '#7fdcff'); gr.addColorStop(1, '#2d8fe0');
          g.beginPath(); g.arc(o.x, o.y, o.r, 0, TAU); g.fillStyle = gr; g.fill(); g.lineWidth = 4; g.strokeStyle = '#2373b8'; g.stroke();
          g.strokeStyle = 'rgba(255,255,255,.5)'; g.lineWidth = 2.5;
          for (let i = 0; i < 2; i++) { const p = ((t * 0.25 + i * 0.5) % 1); g.globalAlpha = 1 - p; g.beginPath(); g.arc(o.x, o.y, 20 + p * (o.r - 26), 0, TAU); g.stroke(); }
          g.globalAlpha = 1;
          for (const [dx, dy] of [[-70, 40], [60, 60], [20, -80]]) { g.beginPath(); g.ellipse(o.x + dx, o.y + dy, 17, 12, 0.3, 0, TAU); g.fillStyle = '#4fc15c'; g.fill(); g.lineWidth = 2; g.strokeStyle = '#2a8e3a'; g.stroke(); g.beginPath(); g.arc(o.x + dx + 3, o.y + dy - 2, 3.5, 0, TAU); g.fillStyle = '#ff8fab'; g.fill(); }
        } else if (o.k === 'rock') {
          g.fillStyle = 'rgba(40,70,100,.25)'; g.beginPath(); g.ellipse(o.x + 8, o.y + 14, o.r * 1.05, o.r * 0.7, 0, 0, TAU); g.fill();
          const n = 9; g.beginPath();
          for (let i = 0; i < n; i++) { const a = (i / n) * TAU, rad = o.r * (0.92 + 0.14 * Math.sin(i * 2.7 + o.x)); const px = o.x + Math.cos(a) * rad, py = o.y - 5 + Math.sin(a) * rad * 0.95; i ? g.lineTo(px, py) : g.moveTo(px, py); }
          g.closePath(); g.fillStyle = '#8da3bb'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#4b6178'; g.lineJoin = 'round'; g.stroke();
          g.fillStyle = '#a9bdd2'; g.beginPath(); g.ellipse(o.x + 12, o.y + 4, o.r * 0.45, o.r * 0.3, 0.3, 0, TAU); g.fill();
          g.beginPath(); g.ellipse(o.x - 6, o.y - 18, o.r * 0.7, o.r * 0.42, -0.2, 0, TAU); g.fillStyle = '#fff'; g.fill();
        } else if (o.k === 'barrel') {
          g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.ellipse(o.x + 5, o.y + 11, o.r, o.r * 0.7, 0, 0, TAU); g.fill();
          g.beginPath(); g.ellipse(o.x, o.y + 6, o.r, o.r * 0.8, 0, 0, TAU); g.fillStyle = '#7a2a2a'; g.fill(); g.lineWidth = 2.5; g.strokeStyle = '#2a0e0e'; g.stroke();
          g.beginPath(); g.arc(o.x, o.y - 2, o.r, 0, TAU); g.fillStyle = '#d6453d'; g.fill(); g.stroke();
          g.beginPath(); g.arc(o.x, o.y - 2, o.r * 0.55, 0, TAU); g.strokeStyle = '#ffb199'; g.lineWidth = 2; g.stroke();
        } else if (o.k === 'fountain') {
          g.fillStyle = 'rgba(0,0,0,.25)'; g.beginPath(); g.arc(o.x + 8, o.y + 16, o.r + 8, 0, TAU); g.fill();
          g.beginPath(); g.arc(o.x, o.y, o.r + 8, 0, TAU); g.fillStyle = '#9aa6bd'; g.fill(); g.lineWidth = 4; g.strokeStyle = '#4b5470'; g.stroke();
          const gr = g.createRadialGradient(o.x - 20, o.y - 20, 8, o.x, o.y, o.r); gr.addColorStop(0, '#9fe6ff'); gr.addColorStop(1, '#3a8fd1');
          g.beginPath(); g.arc(o.x, o.y, o.r - 8, 0, TAU); g.fillStyle = gr; g.fill(); g.stroke();
          g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2.5; for (let i = 0; i < 3; i++) { const ph = (t * 0.3 + i / 3) % 1; g.globalAlpha = 1 - ph; g.beginPath(); g.arc(o.x, o.y, 14 + ph * (o.r - 30), 0, TAU); g.stroke(); } g.globalAlpha = 1;
          g.beginPath(); g.arc(o.x, o.y, 16, 0, TAU); g.fillStyle = '#c9d3e8'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#4b5470'; g.stroke();
        } else if (o.k === 'reactor') {
          g.fillStyle = 'rgba(0,0,0,.28)'; g.beginPath(); g.arc(o.x + 7, o.y + 18, o.r, 0, TAU); g.fill();
          g.beginPath(); g.arc(o.x, o.y + 12, o.r, 0, TAU); g.fillStyle = '#2b365a'; g.fill(); g.lineWidth = 3; g.strokeStyle = '#8fa0d6'; g.stroke();
          g.beginPath(); g.arc(o.x, o.y, o.r, 0, TAU); g.fillStyle = '#3c4a78'; g.fill(); g.stroke();
          const p = 0.5 + 0.5 * Math.sin(t * 3);
          const gr = g.createRadialGradient(o.x, o.y, 2, o.x, o.y, o.r * 0.8); gr.addColorStop(0, '#d8fffb'); gr.addColorStop(0.4, 'rgba(80,240,255,' + (0.7 + 0.3 * p) + ')'); gr.addColorStop(1, 'rgba(80,240,255,0)');
          g.fillStyle = gr; g.beginPath(); g.arc(o.x, o.y, o.r * 0.85, 0, TAU); g.fill();
        } else {
          g.beginPath(); g.arc(o.x, o.y, o.r, 0, TAU); g.fillStyle = '#999'; g.fill();
        }
      }
    }
  }

  function drawGoo(g, goo, t) {
    const fade = Math.min(1, goo.ttl / 1.2);
    g.save(); g.globalAlpha = 0.6 * fade;
    g.beginPath();
    for (let i = 0; i <= 14; i++) { const a = (i / 14) * TAU, rad = goo.r * (0.92 + 0.08 * Math.sin(a * 3 + t * 2 + goo.id)); const x = goo.x + Math.cos(a) * rad, y = goo.y + Math.sin(a) * rad; i ? g.lineTo(x, y) : g.moveTo(x, y); }
    g.closePath(); g.fillStyle = goo.s ? '#5ddc8a' : '#b05cff'; g.fill(); g.lineWidth = 4; g.strokeStyle = goo.s ? '#1f9a55' : '#7b2fd6'; g.stroke();
    g.fillStyle = 'rgba(255,255,255,.55)';
    for (let i = 0; i < 4; i++) { const a = i * 1.7 + goo.id, rad = goo.r * 0.5 * ((i % 2) + 0.6), pul = 1 + 0.2 * Math.sin(t * 3 + i); g.beginPath(); g.arc(goo.x + Math.cos(a) * rad, goo.y + Math.sin(a) * rad, (5 + i) * pul, 0, TAU); g.fill(); }
    g.restore();
  }

  /* -------------------------------- minimap --------------------------------- */
  const miniCache = new Map();
  function miniBase(map, w, flat) {
    const key = map.id + w + (flat ? 'f' : '');
    let c = miniCache.get(key);
    if (c) return c;
    const h = Math.round(w * map.h / map.w);
    c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), s = w / map.w, whole = { x0: 0, y0: 0, x1: map.w, y1: map.h };
    g.scale(s, s);
    drawFloor(g, map, whole, 0);
    if (!flat) { g.globalAlpha = 0.22; g.fillStyle = '#000'; g.fillRect(0, 0, map.w, map.h); g.globalAlpha = 1; }   // dim a little so minimap dots pop
    drawZones(g, map, whole, 0);
    drawObstacles(g, map, { x0: -50, y0: -50, x1: map.w + 50, y1: map.h + 50 }, 0);
    drawBorder(g, map);
    miniCache.set(key, c);
    return c;
  }

  return { drawFloor, drawBorder, drawZones, drawObstacles, drawGoo, miniBase };
})();

/* ================================ particles ================================== */
const Particles = (() => {
  const list = [];
  const TAU = Math.PI * 2;
  const add = (p) => { if (list.length < 900) list.push(p); };

  function burst(x, y, color, n, speed, size, life) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU, v = speed * (0.35 + Math.random() * 0.75);
      add({ k: 'dot', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: life || 0.6, max: life || 0.6, size: size || 5, color, drag: 3 });
    }
  }
  function ring(x, y, r0, r1, color, life, lw) { add({ k: 'ring', x, y, r0, r1, life: life || 0.5, max: life || 0.5, color, lw: lw || 5 }); }
  function puff(x, y, color, size, life) { add({ k: 'puff', x, y, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30 - 10, life: life || 0.5, max: life || 0.5, size: size || 12, color }); }
  function star(x, y, color, size, life, vx, vy) { add({ k: 'star', x, y, vx: vx || 0, vy: vy || 0, life: life || 0.6, max: life || 0.6, size: size || 10, color, rot: Math.random() * 3, drag: 2 }); }
  function streak(x, y, dx, dy, color, len, life) { add({ k: 'streak', x, y, dx, dy, len: len || 40, life: life || 0.25, max: life || 0.25, color }); }
  function text(x, y, txt, color, size) { add({ k: 'text', x, y, vx: 0, vy: -50, life: 1, max: 1, txt, color, size: size || 20 }); }
  function confetti(x, y, n) {
    const cols = ['#ff5d73', '#ffb142', '#ffe66d', '#3ddc97', '#4cc9f0', '#7c6cff', '#ff78c4'];
    for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2, v = 260 + Math.random() * 360; add({ k: 'conf', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.6 + Math.random(), max: 2.4, size: 6 + Math.random() * 5, color: cols[(Math.random() * 7) | 0], rot: Math.random() * 6, vr: (Math.random() - 0.5) * 14 }); }
  }

  function update(dt) {
    for (let i = list.length - 1; i >= 0; i--) {
      const p = list[i]; p.life -= dt;
      if (p.life <= 0) { list[i] = list[list.length - 1]; list.pop(); continue; }
      if (p.vx !== undefined) { p.x += p.vx * dt; p.y += p.vy * dt; if (p.drag) { const d = Math.max(0, 1 - p.drag * dt); p.vx *= d; p.vy *= d; } }
      if (p.k === 'conf') { p.vy += 700 * dt; p.vx *= 0.99; p.rot += p.vr * dt; }
    }
  }

  function draw(g) {
    for (const p of list) {
      const t = p.life / p.max, a = Math.max(0, Math.min(1, t * 1.6));
      g.globalAlpha = a;
      if (p.k === 'dot') { g.beginPath(); g.arc(p.x, p.y, p.size * (0.4 + 0.6 * t), 0, TAU); g.fillStyle = p.color; g.fill(); }
      else if (p.k === 'ring') { const r = p.r0 + (p.r1 - p.r0) * (1 - t * t); g.beginPath(); g.arc(p.x, p.y, r, 0, TAU); g.lineWidth = p.lw * t + 1; g.strokeStyle = p.color; g.stroke(); }
      else if (p.k === 'puff') { g.beginPath(); g.arc(p.x, p.y, p.size * (1.4 - 0.6 * t), 0, TAU); g.fillStyle = p.color; g.globalAlpha = a * 0.5; g.fill(); }
      else if (p.k === 'star') {
        g.save(); g.translate(p.x, p.y); g.rotate(p.rot + (1 - t) * 3); g.scale(t * 0.7 + 0.3, t * 0.7 + 0.3);
        g.beginPath(); for (let i = 0; i < 8; i++) { const r = i % 2 ? p.size * 0.35 : p.size; const ang = (i / 8) * TAU; g.lineTo(Math.cos(ang) * r, Math.sin(ang) * r); }
        g.closePath(); g.fillStyle = p.color; g.fill(); g.restore();
      } else if (p.k === 'streak') { g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(p.x - p.dx * p.len * t, p.y - p.dy * p.len * t); g.lineWidth = 5 * t + 1; g.lineCap = 'round'; g.strokeStyle = p.color; g.stroke(); }
      else if (p.k === 'conf') { g.save(); g.translate(p.x, p.y); g.rotate(p.rot); g.fillStyle = p.color; g.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); g.restore(); }
      else if (p.k === 'text') {
        g.font = `700 ${p.size}px 'Bricolage Grotesque', system-ui, sans-serif`; g.textAlign = 'center'; g.lineWidth = 5; g.strokeStyle = 'rgba(20,16,50,.85)'; g.lineJoin = 'round';
        g.strokeText(p.txt, p.x, p.y); g.fillStyle = p.color; g.fillText(p.txt, p.x, p.y);
      }
    }
    g.globalAlpha = 1;
  }

  return { burst, ring, puff, star, streak, text, confetti, update, draw, clear: () => (list.length = 0) };
})();
