/* Tag Rush - Prop Hunt props. One drawing routine is used for BOTH the harmless clutter scattered around the arena and the props the hiders are disguised as,
   so a hider standing still is pixel-for-pixel the same as the clutter beside it. (x, y) is the body centre, like a player: the base sits r below it.
   `v` is the prop's turn 0-15: bit 0 mirrors it, bits 1-2 tilt it a hair, bit 3 swaps to the alternate colours. */
const Props = (() => {
  const C = TagShared, TAU = Math.PI * 2, INK = '#14122b';
  const LEAN = [-0.06, -0.02, 0.02, 0.06];
  const ln = (g, r) => { g.lineWidth = Math.max(2, r * 0.13); g.lineJoin = 'round'; g.lineCap = 'round'; g.strokeStyle = INK; };
  const poly = (g, pts) => { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.closePath(); };
  const fillStroke = (g, col, r) => { g.fillStyle = col; g.fill(); ln(g, r); g.stroke(); };

  const ART = {
    barrel(g, r, alt) {
      const c1 = alt ? '#8f5a34' : '#b07a4a', c2 = alt ? '#5f3a1e' : '#7a4a26';
      g.beginPath(); g.moveTo(-0.78 * r, -0.08 * r); g.bezierCurveTo(-1.08 * r, -0.5 * r, -1.08 * r, -1.4 * r, -0.78 * r, -1.78 * r); g.lineTo(0.78 * r, -1.78 * r);
      g.bezierCurveTo(1.08 * r, -1.4 * r, 1.08 * r, -0.5 * r, 0.78 * r, -0.08 * r); g.quadraticCurveTo(0, 0.2 * r, -0.78 * r, -0.08 * r); g.closePath(); fillStroke(g, c1, r);
      g.strokeStyle = 'rgba(60,30,10,.35)'; g.lineWidth = 1.5;
      for (const k of [-0.45, 0, 0.45]) { g.beginPath(); g.moveTo(k * r, -0.05 * r); g.quadraticCurveTo(k * r * 1.25, -0.95 * r, k * r, -1.78 * r); g.stroke(); }
      g.strokeStyle = c2; g.lineWidth = r * 0.16;
      for (const y of [-0.5, -1.35]) { g.beginPath(); g.moveTo(-0.99 * r, y * r); g.quadraticCurveTo(0, (y + 0.22) * r, 0.99 * r, y * r); g.stroke(); }
      g.beginPath(); g.ellipse(0, -1.78 * r, 0.78 * r, 0.26 * r, 0, 0, TAU); fillStroke(g, '#c99a66', r);
      g.beginPath(); g.ellipse(0, -1.78 * r, 0.5 * r, 0.15 * r, 0, 0, TAU); g.fillStyle = c2; g.fill();
    },
    crate(g, r, alt) {
      const w = 0.92 * r, h = 1.45 * r, c1 = alt ? '#c39a58' : '#d3a35f', c2 = alt ? '#8a6733' : '#9a6f36';
      poly(g, [[-w, -h], [w, -h], [w * 0.84, -h - 0.4 * r], [-w * 0.84, -h - 0.4 * r]]); fillStroke(g, '#e6bf80', r);
      g.beginPath(); g.rect(-w, -h, 2 * w, h); fillStroke(g, c1, r);
      g.strokeStyle = c2; g.lineWidth = r * 0.12;
      g.strokeRect(-w + 0.14 * r, -h + 0.14 * r, 2 * w - 0.28 * r, h - 0.28 * r);
      g.beginPath(); g.moveTo(-w + 0.14 * r, -h + 0.14 * r); g.lineTo(w - 0.14 * r, -0.14 * r); g.moveTo(w - 0.14 * r, -h + 0.14 * r); g.lineTo(-w + 0.14 * r, -0.14 * r); g.stroke();
    },
    sack(g, r, alt) {
      const c1 = alt ? '#cfb88a' : '#dcc89c';
      g.beginPath(); g.moveTo(-0.3 * r, -1.55 * r); g.bezierCurveTo(-1.1 * r, -1.0 * r, -1.0 * r, 0, 0, 0); g.bezierCurveTo(1.0 * r, 0, 1.1 * r, -1.0 * r, 0.3 * r, -1.55 * r); g.closePath(); fillStroke(g, c1, r);
      g.beginPath(); g.moveTo(-0.3 * r, -1.55 * r); g.lineTo(-0.5 * r, -1.98 * r); g.lineTo(-0.12 * r, -1.76 * r); g.lineTo(0, -2.02 * r); g.lineTo(0.12 * r, -1.76 * r); g.lineTo(0.5 * r, -1.98 * r); g.lineTo(0.3 * r, -1.55 * r); g.closePath(); fillStroke(g, c1, r);
      g.strokeStyle = alt ? '#a8493a' : '#b5483a'; g.lineWidth = r * 0.16; g.beginPath(); g.moveTo(-0.32 * r, -1.5 * r); g.quadraticCurveTo(0, -1.38 * r, 0.32 * r, -1.5 * r); g.stroke();
      g.strokeStyle = 'rgba(90,70,40,.35)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(-0.45 * r, -0.9 * r); g.quadraticCurveTo(-0.15 * r, -0.6 * r, -0.5 * r, -0.3 * r); g.stroke();
    },
    plant(g, r, alt) {
      const leaf = alt ? ['#3f9a4d', '#58b862'] : ['#2f8f45', '#4fbf62'];
      g.save(); g.translate(0, -0.95 * r);
      [-1.15, -0.6, 0, 0.6, 1.15].forEach((a, i) => { g.save(); g.rotate(a); g.beginPath(); g.ellipse(0, -0.55 * r, 0.27 * r, 0.62 * r, 0, 0, TAU); fillStroke(g, leaf[i % 2], r * 0.7); g.restore(); });
      g.restore();
      poly(g, [[-0.58 * r, -0.78 * r], [0.58 * r, -0.78 * r], [0.42 * r, 0], [-0.42 * r, 0]]); fillStroke(g, alt ? '#c0643f' : '#cf7048', r);
      g.beginPath(); g.rect(-0.66 * r, -1.0 * r, 1.32 * r, 0.24 * r); fillStroke(g, alt ? '#d27a54' : '#df8458', r);
    },
    chair(g, r, alt) {
      const wood = alt ? '#a9743f' : '#bf8650', dark = alt ? '#6e4824' : '#7d5128';
      ln(g, r); g.lineWidth = r * 0.17;
      g.strokeStyle = dark; for (const x of [-0.58, 0.58]) { g.beginPath(); g.moveTo(x * r, -0.85 * r); g.lineTo(x * r * 1.06, 0); g.stroke(); }
      g.beginPath(); g.rect(-0.62 * r, -1.98 * r, 1.24 * r, 0.95 * r); fillStroke(g, wood, r);
      g.strokeStyle = dark; g.lineWidth = r * 0.1; for (const x of [-0.2, 0.2]) { g.beginPath(); g.moveTo(x * r, -1.9 * r); g.lineTo(x * r, -1.1 * r); g.stroke(); }
      g.beginPath(); g.rect(-0.74 * r, -1.08 * r, 1.48 * r, 0.3 * r); fillStroke(g, alt ? '#c28a52' : '#d79a60', r);
    },
    bucket(g, r, alt) {
      const c = alt ? '#8a9bb0' : '#9aaabc';
      g.strokeStyle = INK; g.lineWidth = r * 0.12; g.beginPath(); g.arc(0, -1.35 * r, 0.72 * r, Math.PI, 0); g.stroke();
      poly(g, [[-0.72 * r, -1.35 * r], [0.72 * r, -1.35 * r], [0.54 * r, -0.04 * r], [-0.54 * r, -0.04 * r]]); fillStroke(g, c, r);
      g.strokeStyle = 'rgba(40,55,75,.45)'; g.lineWidth = r * 0.1; for (const y of [-0.45, -0.95]) { const k = 0.54 + (0.18 * (0.04 + Math.abs(y) - 0.04 * 0)) / 1.3; g.beginPath(); g.moveTo(-k * r * 0.97, y * r); g.lineTo(k * r * 0.97, y * r); g.stroke(); }
      g.beginPath(); g.ellipse(0, -1.35 * r, 0.72 * r, 0.22 * r, 0, 0, TAU); fillStroke(g, '#566a82', r);
    },
    cone(g, r, alt) {
      const c = alt ? '#ef6a1f' : '#ff7a21', top = 0.12 * r, bot = 0.55 * r, y0 = -0.24 * r, y1 = -1.95 * r;
      poly(g, [[-bot, y0], [bot, y0], [top, y1], [-top, y1]]); fillStroke(g, c, r);
      const hw = (y) => bot - (bot - top) * ((y0 - y) / (y0 - y1));
      for (const [a, b] of [[-0.78, -1.02], [-1.22, -1.42]]) { poly(g, [[-hw(a * r), a * r], [hw(a * r), a * r], [hw(b * r), b * r], [-hw(b * r), b * r]]); g.fillStyle = '#fff'; g.fill(); }
      g.beginPath(); g.rect(-0.78 * r, -0.26 * r, 1.56 * r, 0.26 * r); fillStroke(g, alt ? '#d8561a' : '#e8651c', r);
    },
    lamp(g, r, alt) {
      g.beginPath(); g.ellipse(0, -0.1 * r, 0.62 * r, 0.2 * r, 0, 0, TAU); fillStroke(g, '#3b3a52', r);
      g.beginPath(); g.rect(-0.07 * r, -1.45 * r, 0.14 * r, 1.4 * r); fillStroke(g, '#5a5a78', r * 0.8);
      poly(g, [[-0.32 * r, -2.0 * r], [0.32 * r, -2.0 * r], [0.74 * r, -1.35 * r], [-0.74 * r, -1.35 * r]]); fillStroke(g, alt ? '#f1dca0' : '#f7e6b0', r);
      g.beginPath(); g.ellipse(0, -1.35 * r, 0.74 * r, 0.13 * r, 0, 0, TAU); g.fillStyle = '#fff6c9'; g.fill(); ln(g, r * 0.7); g.stroke();
    },
    toolbox(g, r, alt) {
      const c = alt ? '#cc3b3b' : '#e0453f', dark = alt ? '#8e2323' : '#a82d2b';
      g.strokeStyle = INK; g.lineWidth = r * 0.14; g.beginPath(); g.moveTo(-0.5 * r, -1.25 * r); g.lineTo(-0.5 * r, -1.62 * r); g.lineTo(0.5 * r, -1.62 * r); g.lineTo(0.5 * r, -1.25 * r); g.stroke();
      g.beginPath(); g.rect(-0.98 * r, -1.28 * r, 1.96 * r, 1.26 * r); fillStroke(g, c, r);
      g.fillStyle = dark; g.fillRect(-0.98 * r, -0.78 * r, 1.96 * r, 0.12 * r);
      g.beginPath(); g.rect(-0.2 * r, -0.92 * r, 0.4 * r, 0.3 * r); fillStroke(g, '#ffd23f', r * 0.7);
    },
    globe(g, r, alt) {
      const cy = -1.18 * r, R = 0.8 * r;
      g.beginPath(); g.ellipse(0, -0.08 * r, 0.56 * r, 0.18 * r, 0, 0, TAU); fillStroke(g, '#5b4636', r);
      g.strokeStyle = '#8a6a50'; g.lineWidth = r * 0.14; g.beginPath(); g.moveTo(0, -0.1 * r); g.lineTo(0, cy + R * 0.9); g.stroke();
      g.strokeStyle = '#caa24a'; g.lineWidth = r * 0.12; g.beginPath(); g.arc(0, cy, R * 1.18, 0.35 * Math.PI, 0.9 * Math.PI); g.stroke();
      g.beginPath(); g.arc(0, cy, R, 0, TAU); fillStroke(g, alt ? '#3f86d6' : '#4a95e6', r);
      g.save(); g.beginPath(); g.arc(0, cy, R - 1, 0, TAU); g.clip(); g.fillStyle = alt ? '#5ca85a' : '#6ab56a';
      g.beginPath(); g.ellipse(-0.25 * R, cy - 0.25 * R, 0.4 * R, 0.3 * R, 0.5, 0, TAU); g.fill(); g.beginPath(); g.ellipse(0.4 * R, cy + 0.3 * R, 0.3 * R, 0.4 * R, -0.4, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,.22)'; g.beginPath(); g.ellipse(-0.35 * R, cy - 0.45 * R, 0.25 * R, 0.14 * R, -0.6, 0, TAU); g.fill(); g.restore();
    },
  };

  /** Draw prop `type` (0-based index into PROPS) at body centre (x, y). o = {rock, sq, a}: a rocking tilt (rad) and squash, used only while a hider is moving. */
  function draw(g, type, x, y, v, o) {
    const P = C.PROPS[type]; if (!P) return;
    const r = P.r, mirror = v & 1 ? -1 : 1, lean = LEAN[(v >> 1) & 3], alt = (v >> 3) & 1;
    g.save(); g.translate(x, y + r);
    if (o && o.a !== undefined && o.a !== 1) g.globalAlpha *= o.a;
    g.beginPath(); g.ellipse(0, 1, r * 1.05, r * 0.36, 0, 0, TAU); g.fillStyle = 'rgba(0,0,0,.22)'; g.fill();
    if (o && o.rock) g.rotate(o.rock);
    if (o && o.sq) g.scale(1 + o.sq, 1 - o.sq);
    g.rotate(lean); g.scale(mirror, 1);
    ART[P.id](g, r, alt);
    g.restore();
  }

  /** A small canvas with the prop on it, for the HUD. */
  function icon(type, px) {
    const c = document.createElement('canvas'), d = Math.min(devicePixelRatio || 1, 2); c.width = c.height = Math.round(px * d); c.style.width = c.style.height = px + 'px';
    const g = c.getContext('2d'), r = C.PROPS[type].r, k = (px * d) / (r * 3.1);
    g.setTransform(k, 0, 0, k, (px * d) / 2, (px * d) * 0.5 - r * 0.45 * k);
    draw(g, type, 0, 0, 0);
    return c;
  }

  return { draw, icon };
})();
