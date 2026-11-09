/* Tag Rush - procedural vector characters.
   Everything is drawn with canvas paths (no image assets): squash & stretch, blinking,
   eyes that look where you run, wagging tails, stepping feet. */
const Chars = (() => {
  const OUT = '#1a1633';
  const C = TagShared;
  const shadeCache = new Map();

  function shade(hex, amt) {
    const key = hex + amt;
    let v = shadeCache.get(key);
    if (v) return v;
    const n = parseInt(hex.slice(1), 16);
    let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    if (amt >= 0) { r += (255 - r) * amt; g += (255 - g) * amt; b += (255 - b) * amt; }
    else { r *= 1 + amt; g *= 1 + amt; b *= 1 + amt; }
    v = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    shadeCache.set(key, v);
    return v;
  }
  const palette = (hex) => ({ m: hex, d: shade(hex, -0.22), dd: shade(hex, -0.45), l: shade(hex, 0.32), ll: shade(hex, 0.62) });
  const colorOf = (ci, ki) => C.colorFor(ki) || C.CHARS[ci].natural;

  /* ---------------------------- tiny path helpers --------------------------- */
  function fillStroke(g, fill, lw) {
    g.fillStyle = fill; g.fill();
    g.lineWidth = lw || 2.4; g.strokeStyle = OUT; g.stroke();
  }
  function ell(g, x, y, rx, ry, fill, lw, rot) {
    g.beginPath(); g.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2); fillStroke(g, fill, lw);
  }
  function poly(g, pts, fill, lw) {
    g.beginPath(); g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath(); fillStroke(g, fill, lw);
  }
  function rrect(g, x, y, w, h, r, fill, lw) {
    g.beginPath(); g.roundRect(x, y, w, h, r); fillStroke(g, fill, lw);
  }
  function eye(g, x, y, r, o, pr, iris) {
    g.save(); g.translate(x, y); g.scale(1, Math.max(0.1, 1 - o.blink * 0.92));
    g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); fillStroke(g, iris || '#fff', 1.8);
    pr = pr || r * 0.52;
    const px = o.lx * r * 0.38, py = o.ly * r * 0.3;
    g.beginPath(); g.arc(px, py, pr, 0, Math.PI * 2); g.fillStyle = OUT; g.fill();
    g.beginPath(); g.arc(px - pr * 0.32, py - pr * 0.34, pr * 0.34, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.restore();
  }
  function dotEye(g, x, y, r, o) {
    g.save(); g.translate(x, y); g.scale(1, Math.max(0.1, 1 - o.blink * 0.92));
    g.beginPath(); g.arc(o.lx * 0.8, o.ly * 0.6, r, 0, Math.PI * 2); g.fillStyle = OUT; g.fill();
    g.beginPath(); g.arc(o.lx * 0.8 - r * 0.3, o.ly * 0.6 - r * 0.32, r * 0.36, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.restore();
  }
  function feet(g, col, spread, o, size) {
    const sz = size || 1;
    for (let i = -1; i <= 1; i += 2) {
      const lift = o.spd > 0.05 ? Math.max(0, Math.sin(o.t * o.gf + (i > 0 ? 0 : Math.PI))) * 3.4 * o.spd : 0;
      ell(g, i * spread, -1.5 - lift, 6 * sz, 3.6 * sz, col, 2);
    }
  }
  const cheek = (g, x, y, rx, ry) => { g.globalAlpha *= 0.65; ell(g, x, y, rx, ry, '#ff8fab', 0.01); g.globalAlpha /= 0.65; };

  /* -------------------------------- characters ------------------------------ */
  const DRAW = {
    fox(g, c, o) {
      g.save(); g.translate(-13, -12); g.rotate(-0.55 + Math.sin(o.t * 6) * (0.08 + 0.18 * o.spd));
      ell(g, -10, 0, 14, 8, c.m, 2.4, -0.15);
      ell(g, -21, -1.4, 5.2, 5, '#fff7ec', 2, -0.15);
      g.restore();
      feet(g, c.dd, 8, o);
      for (const s of [-1, 1]) {
        poly(g, [s * 14, -33, s * 18, -51, s * 4, -38], c.m, 2.4);
        poly(g, [s * 13, -37, s * 15.6, -45, s * 8, -38.5], c.dd, 0.01);
      }
      ell(g, 0, -19, 17, 19, c.m);
      ell(g, -8.5, -14.5, 9, 6.6, '#fff7ec', 0.01); ell(g, 8.5, -14.5, 9, 6.6, '#fff7ec', 0.01);
      ell(g, 0, -12, 13, 8, '#fff7ec', 0.01, 0);
      g.beginPath(); g.ellipse(0, -19, 17, 19, 0, 0, Math.PI * 2); g.lineWidth = 2.4; g.strokeStyle = OUT; g.stroke();
      eye(g, -7, -24, 4.4, o); eye(g, 7, -24, 4.4, o);
      ell(g, 0, -17.5, 3, 2.3, OUT, 0.01);
      g.beginPath(); g.moveTo(0, -15.5); g.quadraticCurveTo(-2.4, -12.4, -5, -14); g.moveTo(0, -15.5); g.quadraticCurveTo(2.4, -12.4, 5, -14);
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.stroke();
    },
    frog(g, c, o) {
      feet(g, c.d, 11, o, 1.35);
      ell(g, 0, -14, 19.5, 15.5, c.m);
      ell(g, 0, -10, 12.5, 9, c.l, 0.01);
      for (const [x, y, r] of [[-5, -22, 2.3], [6, -20.5, 1.8], [-11, -17, 1.6]]) { g.beginPath(); g.arc(x, y, r, 0, 7); g.fillStyle = c.d; g.fill(); }
      for (const s of [-1, 1]) ell(g, s * 9.5, -28, 8.2, 8.2, c.m);
      eye(g, -9.5, -29, 5.6, o); eye(g, 9.5, -29, 5.6, o);
      g.beginPath(); g.moveTo(-11, -14.5); g.quadraticCurveTo(0, -7.5, 11, -14.5);
      g.lineWidth = 2.1; g.strokeStyle = OUT; g.lineCap = 'round'; g.stroke();
      cheek(g, -14, -13, 3.6, 2.2); cheek(g, 14, -13, 3.6, 2.2);
    },
    ghost(g, c, o) {
      const t = o.t;
      g.beginPath(); g.moveTo(-17, -8);
      g.bezierCurveTo(-18, -48, 18, -48, 17, -8);
      const n = 3, w = 34 / n;
      for (let i = 0; i < n; i++) {
        const x1 = 17 - w * (i + 1), cx = 17 - w * (i + 0.5);
        g.quadraticCurveTo(cx, 3.5 + Math.sin(t * 5 + i * 1.6) * 2.4, x1, -8 + Math.sin(t * 5 + i * 1.6 + 1) * 1.2);
      }
      g.closePath(); fillStroke(g, c.m);
      g.save(); g.globalAlpha *= 0.5; ell(g, -6.5, -33, 4.6, 8, '#fff', 0.01, 0.35); g.restore();
      const wv = Math.sin(t * 4) * 0.3;
      ell(g, -18.5, -18, 4.2, 6.2, c.m, 2.2, 0.5 + wv); ell(g, 18.5, -18, 4.2, 6.2, c.m, 2.2, -0.5 - wv);
      for (const s of [-1, 1]) {
        g.beginPath(); g.ellipse(s * 6.5, -25, 3.1, 4.4, 0, 0, 7); g.fillStyle = OUT; g.fill();
        g.beginPath(); g.arc(s * 6.5 + o.lx * 1, -26.2 + o.ly * 0.8, 1.2, 0, 7); g.fillStyle = '#fff'; g.fill();
      }
      ell(g, 0, -16.5, 2.7, 3.3, OUT, 0.01);
      cheek(g, -12.5, -19, 3.2, 2); cheek(g, 12.5, -19, 3.2, 2);
    },
    cat(g, c, o) {
      g.save(); g.lineCap = 'round';
      const sway = Math.sin(o.t * 5) * (3 + 4 * o.spd);
      g.beginPath(); g.moveTo(-11, -9); g.bezierCurveTo(-30, -8, -30 + sway, -30, -21 + sway, -36);
      g.lineWidth = 9.5; g.strokeStyle = OUT; g.stroke(); g.lineWidth = 5.6; g.strokeStyle = c.m; g.stroke();
      g.restore();
      feet(g, c.dd, 7.5, o);
      for (const s of [-1, 1]) {
        poly(g, [s * 14.5, -33, s * 16.5, -53, s * 3, -39], c.m, 2.4);
        poly(g, [s * 13.2, -37, s * 14.6, -47, s * 7.5, -39.5], '#ff9bb8', 0.01);
      }
      ell(g, 0, -18, 17.5, 18, c.m);
      for (const x of [-4.5, 0, 4.5]) { g.beginPath(); g.moveTo(x, -35.5); g.lineTo(x * 0.8, -31); g.lineWidth = 2; g.strokeStyle = c.dd; g.lineCap = 'round'; g.stroke(); }
      ell(g, 0, -13, 8.5, 5.8, c.l, 0.01);
      for (const s of [-1, 1]) {
        g.save(); g.translate(s * 7.4, -23); g.scale(1, Math.max(0.1, 1 - o.blink * 0.92));
        g.beginPath(); g.ellipse(0, 0, 4.6, 5.2, 0, 0, 7); fillStroke(g, '#d9f26e', 1.8);
        g.beginPath(); g.ellipse(o.lx * 1.2, o.ly * 0.8, 1.5, 4.2, 0, 0, 7); g.fillStyle = OUT; g.fill();
        g.restore();
      }
      poly(g, [-2.4, -16.4, 2.4, -16.4, 0, -13.8], '#ff7a9c', 1.4);
      g.lineWidth = 1.2; g.strokeStyle = 'rgba(26,22,51,.55)'; g.lineCap = 'round';
      for (const s of [-1, 1]) for (const dy of [-2.4, 1.4]) { g.beginPath(); g.moveTo(s * 9, -13 + dy * 0.3); g.lineTo(s * 21, -15 + dy); g.stroke(); }
    },
    bear(g, c, o) {
      feet(g, c.dd, 9.5, o, 1.2);
      for (const s of [-1, 1]) { ell(g, s * 13.5, -36, 7.4, 7.4, c.m); ell(g, s * 13.5, -35.6, 3.6, 3.6, c.l, 0.01); }
      ell(g, -20, -15, 5.2, 8.5, c.m, 2.2, 0.35); ell(g, 20, -15, 5.2, 8.5, c.m, 2.2, -0.35);
      ell(g, 0, -19.5, 20.5, 20.5, c.m);
      ell(g, 0, -10.5, 12.5, 10, c.l, 0.01);
      ell(g, 0, -17.5, 9.4, 7.4, c.ll, 1.8);
      dotEye(g, -8.5, -26, 3.2, o); dotEye(g, 8.5, -26, 3.2, o);
      ell(g, 0, -19.6, 3.7, 2.7, OUT, 0.01);
      g.beginPath(); g.moveTo(0, -17.5); g.lineTo(0, -15.6); g.moveTo(-3.2, -14.2); g.quadraticCurveTo(0, -12.2, 3.2, -14.2);
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.lineCap = 'round'; g.stroke();
      cheek(g, -15, -17, 3.4, 2.1); cheek(g, 15, -17, 3.4, 2.1);
    },
    octo(g, c, o) {
      g.lineCap = 'round';
      const amp = 2.6 + 3 * o.spd;
      for (let i = 0; i < 5; i++) {
        const x0 = -13 + i * 6.5, w = Math.sin(o.t * 6 + i * 1.3) * amp;
        g.beginPath(); g.moveTo(x0, -12); g.bezierCurveTo(x0 + w, -7, x0 - w, -3, x0 + w * 0.8 + (i - 2) * 1.8, 1);
        g.lineWidth = 8.6; g.strokeStyle = OUT; g.stroke();
      }
      for (let i = 0; i < 5; i++) {
        const x0 = -13 + i * 6.5, w = Math.sin(o.t * 6 + i * 1.3) * amp;
        g.beginPath(); g.moveTo(x0, -12); g.bezierCurveTo(x0 + w, -7, x0 - w, -3, x0 + w * 0.8 + (i - 2) * 1.8, 1);
        g.lineWidth = 5.2; g.strokeStyle = c.m; g.stroke();
      }
      ell(g, 0, -24, 18.5, 17.5, c.m);
      for (const [x, y, r] of [[-7.5, -34, 2.6], [6, -36, 2.1], [12, -29, 1.7]]) { g.beginPath(); g.arc(x, y, r, 0, 7); g.fillStyle = c.l; g.fill(); }
      eye(g, -7, -23, 5.4, o); eye(g, 7, -23, 5.4, o);
      cheek(g, -13.5, -16.5, 3.4, 2.1); cheek(g, 13.5, -16.5, 3.4, 2.1);
      g.beginPath(); g.moveTo(-3, -14.6); g.quadraticCurveTo(0, -11.6, 3, -14.6); g.lineWidth = 1.7; g.strokeStyle = OUT; g.stroke();
    },
    owl(g, c, o) {
      const fl = Math.sin(o.t * 10) * 0.16 * o.spd;
      ell(g, -18, -18, 6.2, 12.5, c.d, 2.2, 0.28 + fl); ell(g, 18, -18, 6.2, 12.5, c.d, 2.2, -0.28 - fl);
      for (const s of [-1, 1]) ell(g, s * 6.5, -1.5, 5, 3, '#ffb347', 2);
      for (const s of [-1, 1]) poly(g, [s * 12, -35, s * 15.5, -48, s * 4, -38.5], c.d, 2.4);
      ell(g, 0, -19.5, 17.5, 20, c.m);
      ell(g, 0, -13, 11, 13, c.l, 0.01);
      g.lineWidth = 1.5; g.strokeStyle = c.m; g.lineCap = 'round';
      for (const y of [-17, -12, -7]) { g.beginPath(); g.arc(0, y - 2, 4, 0.2, Math.PI - 0.2); g.stroke(); }
      ell(g, -8, -25.5, 8.4, 8.4, c.ll, 1.8); ell(g, 8, -25.5, 8.4, 8.4, c.ll, 1.8);
      eye(g, -8, -25.5, 5.8, o, 3.3, '#ffe27a'); eye(g, 8, -25.5, 5.8, o, 3.3, '#ffe27a');
      poly(g, [-3.2, -20.5, 3.2, -20.5, 0, -13.8], '#ffa733', 1.8);
    },
    robot(g, c, o) {
      const spin = o.t * 12 * o.spd;
      for (const s of [-1, 1]) {
        g.beginPath(); g.arc(s * 10, -4.5, 5.6, 0, 7); fillStroke(g, '#3a3a58', 2);
        g.save(); g.translate(s * 10, -4.5); g.rotate(spin); g.beginPath(); g.moveTo(-4, 0); g.lineTo(4, 0); g.moveTo(0, -4); g.lineTo(0, 4); g.lineWidth = 1.4; g.strokeStyle = '#8a8cb8'; g.stroke(); g.restore();
      }
      if (!o.hat) {
        g.beginPath(); g.moveTo(0, -37); g.lineTo(0, -45.5); g.lineWidth = 2.4; g.strokeStyle = OUT; g.stroke();
        const pulse = 0.5 + 0.5 * Math.sin(o.t * 5);
        g.beginPath(); g.arc(0, -47.5, 3.4, 0, 7); fillStroke(g, pulse > 0.5 ? '#ffd166' : '#ff8a5c', 2);
      }
      rrect(g, -22, -24, 6, 11, 3, c.d, 2); rrect(g, 16, -24, 6, 11, 3, c.d, 2);
      rrect(g, -16.5, -37, 33, 30, 9, c.m);
      g.save(); g.globalAlpha *= 0.35; rrect(g, -13, -35, 26, 6, 3, '#fff', 0.01); g.restore();
      rrect(g, -12.5, -31, 25, 15, 6, '#151a38', 1.8);
      const eh = Math.max(1.2, 6.4 * (1 - o.blink * 0.9));
      for (const s of [-1, 1]) {
        g.fillStyle = '#7dffea'; g.beginPath(); g.roundRect(s * 6 - 2.6 + o.lx * 1.3, -23.6 - eh / 2 + o.ly * 0.8, 5.2, eh, 2); g.fill();
      }
      g.beginPath(); g.arc(0, -11.5, 2.8, 0, 7); fillStroke(g, Math.sin(o.t * 4) > 0 ? '#ff5d73' : '#3ddc97', 1.6);
      for (const [x, y] of [[-12.5, -34], [12.5, -34]]) { g.beginPath(); g.arc(x, y, 1.1, 0, 7); g.fillStyle = c.l; g.fill(); }
    },
    penguin(g, c, o) {
      const flap = Math.sin(o.t * 9) * (0.12 + 0.3 * o.spd);
      for (const sd of [-1, 1]) {
        const lift = o.spd > 0.05 ? Math.max(0, Math.sin(o.t * o.gf + (sd > 0 ? 0 : Math.PI))) * 3 * o.spd : 0;
        ell(g, sd * 7.5, -1.4 - lift, 7.4, 3.6, '#ffa733', 2);
      }
      ell(g, 0, -19.5, 17.5, 20, c.m);
      ell(g, 0, -14, 11.5, 14.5, '#fff8ee', 0.01);
      g.beginPath(); g.ellipse(0, -19.5, 17.5, 20, 0, 0, 7); g.lineWidth = 2.4; g.strokeStyle = OUT; g.stroke();
      for (const sd of [-1, 1]) {
        g.save(); g.translate(sd * 17, -24); g.rotate(sd * (0.3 + flap));
        ell(g, 0, 5, 4.4, 11, c.d, 2.2, 0); g.restore();
      }
      ell(g, -8, -26, 7, 7.6, '#fff8ee', 0.01); ell(g, 8, -26, 7, 7.6, '#fff8ee', 0.01);
      eye(g, -7, -26, 4.1, o); eye(g, 7, -26, 4.1, o);
      poly(g, [-4.6, -20.5, 4.6, -20.5, 0, -14.8], '#ffa733', 1.9);
      cheek(g, -12.5, -19.5, 3, 2); cheek(g, 12.5, -19.5, 3, 2);
      g.beginPath(); g.moveTo(-3, -39); g.quadraticCurveTo(0, -46, 3, -39); g.lineWidth = 2.2; g.strokeStyle = OUT; g.lineCap = 'round'; g.stroke();
    },
    raccoon(g, c, o) {
      g.save(); g.translate(-13, -11); g.rotate(-0.6 + Math.sin(o.t * 5) * (0.07 + 0.16 * o.spd));
      ell(g, -10, 0, 15, 8.4, c.m, 2.4, -0.1);
      for (const x of [-4, -10, -16]) ell(g, x, 0, 2.6, 8, c.dd, 0.01, -0.1);
      ell(g, -23, -1, 5.2, 5, c.dd, 2, -0.1);
      g.restore();
      feet(g, c.dd, 8, o);
      for (const sd of [-1, 1]) { ell(g, sd * 12.5, -35, 6.6, 6.6, c.m); ell(g, sd * 12.5, -34.6, 3.2, 3.2, c.dd, 0.01); }
      ell(g, 0, -19, 17.5, 19, c.m);
      ell(g, 0, -12.5, 11, 9, c.ll, 0.01);
      g.beginPath(); g.ellipse(0, -19, 17.5, 19, 0, 0, 7); g.lineWidth = 2.4; g.strokeStyle = OUT; g.stroke();
      g.beginPath(); g.moveTo(-17, -25); g.quadraticCurveTo(-8, -31, 0, -26); g.quadraticCurveTo(8, -31, 17, -25);
      g.quadraticCurveTo(15, -17, 8, -19); g.quadraticCurveTo(0, -22, -8, -19); g.quadraticCurveTo(-15, -17, -17, -25); fillStroke(g, c.dd, 1.6);
      eye(g, -7, -24, 3.9, o); eye(g, 7, -24, 3.9, o);
      ell(g, 0, -16.5, 3.1, 2.4, OUT, 0.01);
      g.beginPath(); g.moveTo(0, -14.4); g.quadraticCurveTo(-2.6, -11.6, -5, -13); g.moveTo(0, -14.4); g.quadraticCurveTo(2.6, -11.6, 5, -13);
      g.lineWidth = 1.5; g.strokeStyle = OUT; g.lineCap = 'round'; g.stroke();
    },
    bat(g, c, o) {
      const f = Math.sin(o.t * (7 + 8 * o.spd)) * (0.35 + 0.45 * o.spd), hov = Math.sin(o.t * 4) * 1.2;
      for (const sd of [-1, 1]) {
        g.save(); g.translate(sd * 11, -24 + hov); g.scale(sd, 1); g.rotate(-f * 0.6);
        g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(14, -22, 33, -14); g.quadraticCurveTo(28, -9, 29, -2);
        g.quadraticCurveTo(23, -5, 20, 3); g.quadraticCurveTo(15, 0, 11, 8); g.quadraticCurveTo(6, 6, 0, 10); g.closePath(); fillStroke(g, c.d, 2.2);
        g.beginPath(); g.moveTo(1, 1); g.lineTo(31, -12); g.moveTo(1, 3); g.lineTo(22, 1); g.moveTo(1, 5); g.lineTo(11, 7);
        g.lineWidth = 1.2; g.strokeStyle = 'rgba(26,22,51,.45)'; g.stroke();
        g.restore();
      }
      feet(g, c.dd, 6, o, 0.8);
      g.save(); g.translate(0, hov * 0.5);
      for (const sd of [-1, 1]) { poly(g, [sd * 11, -34, sd * 15, -51, sd * 3.2, -38.6], c.m, 2.4); poly(g, [sd * 10.4, -37.6, sd * 12.6, -45.4, sd * 6.2, -39.4], '#ff9bb8', 0.01); }
      ell(g, 0, -19, 16, 18, c.m);
      ell(g, 0, -12.5, 9.6, 8.6, c.l, 0.01);
      eye(g, -6.6, -23.5, 4.6, o, 2.6, '#ffe27a'); eye(g, 6.6, -23.5, 4.6, o, 2.6, '#ffe27a');
      ell(g, 0, -17.3, 2.1, 1.6, OUT, 0.01);
      for (const sd of [-1, 1]) poly(g, [sd * 3.4, -14.3, sd * 1.4, -14.3, sd * 2.4, -10.8], '#fff', 1.1);
      g.beginPath(); g.moveTo(-5, -14.4); g.quadraticCurveTo(0, -12.2, 5, -14.4); g.lineWidth = 1.5; g.strokeStyle = OUT; g.lineCap = 'round'; g.stroke();
      g.restore();
    },
    bird(g, c, o) {
      const fl = Math.sin(o.t * 14) * (0.12 + 0.3 * o.spd);                    // wings buzz harder the faster you go
      poly(g, [-5, -9, -1, 0.5, -9.5, -2], c.d, 2); poly(g, [5, -9, 1, 0.5, 9.5, -2], c.d, 2);   // tail feathers peeking out below
      feet(g, '#ff9d3a', 6, o, 0.8);
      ell(g, -17.5, -17, 5.6, 11.5, c.d, 2.2, 0.35 + fl); ell(g, 17.5, -17, 5.6, 11.5, c.d, 2.2, -0.35 - fl);
      if (!o.hat) for (const [x, r] of [[-3.6, -0.34], [0, 0], [3.6, 0.34]]) { g.save(); g.translate(x, -37); g.rotate(r); ell(g, 0, -4.6, 2.5, 5.6, c.d, 1.8); g.restore(); }
      ell(g, 0, -19.5, 17.5, 19.5, c.m);
      ell(g, 0, -12.5, 11.5, 11.5, c.ll, 0.01);
      g.lineWidth = 1.4; g.strokeStyle = c.m; g.lineCap = 'round';
      for (const [x, y] of [[-4, -9], [3.5, -7], [-1, -4]]) { g.beginPath(); g.arc(x, y, 2.6, 0.3, Math.PI - 0.3); g.stroke(); }
      eye(g, -7.2, -25, 4.7, o); eye(g, 7.2, -25, 4.7, o);
      poly(g, [-4.2, -19.5, 4.2, -19.5, 0, -12.2], '#ff9d3a', 1.9);
      g.beginPath(); g.moveTo(-3.6, -16.6); g.lineTo(3.6, -16.6); g.lineWidth = 1.2; g.strokeStyle = OUT; g.stroke();
      cheek(g, -12.8, -17.5, 3.2, 2); cheek(g, 12.8, -17.5, 3.2, 2);
    },
    star(g, c, o) {
      const cy = -20, R = 33.5, r = 11.5, TAU = Math.PI * 2;
      g.save(); g.translate(0, cy);
      const tips = [];
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + i * TAU / 5, leg = i === 2 || i === 3;
        const lift = leg && o.spd > 0.05 ? Math.max(0, Math.sin(o.t * o.gf + (i === 2 ? 0 : Math.PI))) * 3.4 * o.spd : 0;
        const wig = Math.sin(o.t * 3 + i * 1.7) * 0.07 + (leg ? 0 : Math.sin(o.t * o.gf * 0.5 + i) * 0.1 * o.spd);
        tips.push([a + wig, R - lift]);
      }
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const [a, rr] = tips[i], v0 = a - Math.PI / 5, v1 = a + Math.PI / 5;
        const sx = Math.cos(v0) * r, sy = Math.sin(v0) * r;
        if (i === 0) g.moveTo(sx, sy);
        g.quadraticCurveTo(Math.cos(a) * rr, Math.sin(a) * rr, Math.cos(v1) * r, Math.sin(v1) * r);
      }
      g.closePath(); fillStroke(g, c.m);
      for (let i = 0; i < 5; i++) {                                  // bumpy dots down each arm
        const [a] = tips[i];
        for (const [d, rad] of [[17, 1.9], [23.5, 1.4]]) { g.beginPath(); g.arc(Math.cos(a) * d, Math.sin(a) * d, rad, 0, 7); g.fillStyle = c.l; g.fill(); }
      }
      ell(g, 0, 0, 10.5, 10, c.l, 0.01);
      eye(g, -4.6, -2.2, 3.5, o); eye(g, 4.6, -2.2, 3.5, o);
      cheek(g, -8.2, 2.6, 2.4, 1.6); cheek(g, 8.2, 2.6, 2.4, 1.6);
      g.beginPath(); g.moveTo(-2.4, 3.4); g.quadraticCurveTo(0, 6.4, 2.4, 3.4); g.lineWidth = 1.6; g.strokeStyle = OUT; g.lineCap = 'round'; g.stroke();
      g.restore();
    },
  };

  /* ---------------------------------- hats ---------------------------------- */
  // where the top of each character's head is (the hat's base sits here) and how wide the hat may be
  const HEAD = {
    fox: [0, -36, 12], frog: [0, -37, 11], ghost: [0, -45, 12], cat: [0, -35.5, 11], bear: [0, -39.5, 13], octo: [0, -41, 13],
    owl: [0, -39.5, 12], robot: [0, -37, 12], penguin: [0, -39.5, 11], raccoon: [0, -38, 12], bat: [0, -36.5, 10], star: [0, -40.5, 9], bird: [0, -39, 11],
    icon: [0, -1.5, 12],      // used by hatIcon(): hat sits on the origin at natural size
  };
  function drawHat(g, id, hat, o) {
    const [hx, hy, hw] = HEAD[id] || HEAD.fox, k = hw / 12;
    g.save(); g.translate(hx, hy + 1.5); g.rotate(0.1); g.scale(k, k);
    switch (hat) {
      case 1: {   // party hat
        poly(g, [-10, 0, 10, 0, 0, -25], '#ff5da2', 2.2);
        g.save(); g.beginPath(); g.moveTo(-10, 0); g.lineTo(10, 0); g.lineTo(0, -25); g.closePath(); g.clip();
        g.fillStyle = '#ffe066'; for (const y of [-6, -13, -20]) { g.beginPath(); g.moveTo(-14, y); g.lineTo(14, y - 5); g.lineTo(14, y - 1); g.lineTo(-14, y + 4); g.fill(); }
        g.restore();
        g.beginPath(); g.moveTo(-10, 0); g.lineTo(10, 0); g.lineTo(0, -25); g.closePath(); g.lineWidth = 2.2; g.strokeStyle = OUT; g.stroke();
        ell(g, 0, -26, 3.6, 3.6, '#fff', 1.8); break;
      }
      case 2: {   // crown
        g.beginPath(); g.moveTo(-11, 0); g.lineTo(-12, -14); g.lineTo(-6, -8); g.lineTo(0, -17); g.lineTo(6, -8); g.lineTo(12, -14); g.lineTo(11, 0); g.closePath(); fillStroke(g, '#ffd23f', 2.2);
        g.fillStyle = '#ffec99'; g.fillRect(-9.6, -5.5, 19.2, 2);
        for (const [x, col] of [[-5, '#ff5d73'], [0, '#4cc9f0'], [5, '#3ddc97']]) { g.beginPath(); g.arc(x, -2, 1.5, 0, 7); g.fillStyle = col; g.fill(); }
        break;
      }
      case 3: {   // top hat
        rrect(g, -13, -2.5, 26, 5, 2.5, '#26233f', 2.2);
        rrect(g, -8.5, -20, 17, 18.5, 2, '#33305a', 2.2);
        g.fillStyle = '#ff5d73'; g.fillRect(-8.3, -8, 16.6, 4); break;
      }
      case 4: {   // wizard hat
        g.beginPath(); g.moveTo(-9, 0); g.quadraticCurveTo(-4, -16, 3, -27); g.quadraticCurveTo(9, -23, 14, -13); g.quadraticCurveTo(9, -8, 9, 0); g.closePath(); fillStroke(g, '#5b4fd6', 2.2);
        ell(g, 0, 0.5, 15.5, 3.6, '#4a3fbd', 2.2);
        for (const [x, y, r] of [[-1, -10, 1.8], [4, -16, 1.3], [-3, -17, 1.1]]) { g.beginPath(); g.arc(x, y, r, 0, 7); g.fillStyle = '#ffe066'; g.fill(); }
        break;
      }
      case 5: {   // halo
        const b = Math.sin(o.t * 3) * 1.2;
        g.beginPath(); g.ellipse(0, -9 + b, 10.5, 3.6, 0, 0, 7); g.lineWidth = 5.2; g.strokeStyle = OUT; g.stroke(); g.lineWidth = 2.6; g.strokeStyle = '#ffe066'; g.stroke();
        break;
      }
      case 6: {   // cap (brim points the way the character faces)
        g.beginPath(); g.moveTo(-10.5, 0.5); g.quadraticCurveTo(-11, -15, 0, -15); g.quadraticCurveTo(11, -15, 10.5, 0.5); g.closePath(); fillStroke(g, '#ff5d73', 2.2);
        g.beginPath(); g.moveTo(3, -1); g.quadraticCurveTo(18, -2, 19, 3); g.quadraticCurveTo(10, 3.4, 3, 2.4); g.closePath(); fillStroke(g, '#d93a58', 2);
        g.beginPath(); g.arc(0, -15, 1.6, 0, 7); g.fillStyle = '#ffe066'; g.fill(); break;
      }
      case 7: {   // flower
        g.translate(7.5, -2.5);
        for (let i = 0; i < 5; i++) { const a = i * Math.PI * 2 / 5; ell(g, Math.cos(a) * 5.2, Math.sin(a) * 5.2, 3.9, 3.9, '#ff8fc0', 1.8); }
        ell(g, 0, 0, 3.4, 3.4, '#ffe066', 1.8); break;
      }
      case 8: {   // chef hat
        for (const [x, y, r] of [[-7, -15, 6.5], [7, -15, 6.5], [0, -20, 7.5]]) ell(g, x, y, r, r, '#fff', 2.2);
        rrect(g, -10.5, -14, 21, 14.5, 3, '#fff', 2.2);
        g.fillStyle = '#e4e8f5'; g.fillRect(-10, -4.5, 20, 1.8); break;
      }
      default: break;
    }
    g.restore();
  }

  /* ------------------------------ walk personalities ------------------------------
     f: step frequency · bob: hop height · sq: squash & stretch · sway: waddle (rad) · lean: forward tilt · crouch: stays low */
  const GAIT = {
    fox:     { f: 12, bob: 3.4, sq: 0.04, sway: 0.00, lean: 0.07, crouch: 0 },
    frog:    { f: 7,  bob: 7.5, sq: 0.13, sway: 0.00, lean: 0.00, crouch: 0 },      // proper hops
    ghost:   { f: 5,  bob: 1.6, sq: 0.02, sway: 0.08, lean: 0.12, crouch: 0 },      // drifts
    cat:     { f: 10, bob: 1.2, sq: 0.03, sway: 0.02, lean: 0.10, crouch: 0.07 },   // sneaks low
    bear:    { f: 7,  bob: 2.2, sq: 0.05, sway: 0.10, lean: 0.00, crouch: 0 },      // heavy plod
    octo:    { f: 8,  bob: 2.6, sq: 0.08, sway: 0.03, lean: 0.00, crouch: 0 },      // pulsing wobble
    owl:     { f: 13, bob: 3.6, sq: 0.03, sway: 0.05, lean: 0.03, crouch: 0 },
    robot:   { f: 16, bob: 0.7, sq: 0.00, sway: 0.00, lean: 0.05, crouch: 0 },      // stiff, rolling
    penguin: { f: 8,  bob: 1.8, sq: 0.03, sway: 0.20, lean: 0.00, crouch: 0 },      // waddle
    raccoon: { f: 15, bob: 2.4, sq: 0.05, sway: 0.03, lean: 0.10, crouch: 0.03 },   // scurry
    bat:     { f: 6,  bob: 2.2, sq: 0.02, sway: 0.04, lean: 0.12, crouch: 0 },      // flutter
    star:    { f: 9,  bob: 2.4, sq: 0.06, sway: 0.07, lean: 0.04, crouch: 0 },
    bird:    { f: 14, bob: 4.2, sq: 0.03, sway: 0.04, lean: 0.05, crouch: 0 },      // quick pecking hops
  };

  /* -------------------------------- public API ------------------------------ */
  /**
   * o: x,y (feet position) s (scale: radius/18) color face(+1/-1) lx,ly (look) t (seconds)
   *    spd (0..1) air (0..1) alpha blink(0..1) lean(rad) hat(0..8) pose{up,rot,sq} (see pose())
   */
  function draw(g, ci, o) {
    const def = C.CHARS[ci], c = palette(o.color || def.natural), id = def.id, gt = GAIT[id] || GAIT.fox;
    const s = o.s || 1, face = o.face || 1, t = o.t || 0, spd = o.spd || 0, pz = o.pose;
    const up = pz ? pz.up : 0, air = (o.air || 0) + up / 46;
    const o2 = { t, spd, blink: o.blink || 0, lx: (o.lx || 0) * face, ly: o.ly || 0, gf: gt.f, hat: o.hat | 0 };
    g.save();
    g.translate(o.x, o.y);
    if (o.shadow !== false) {
      g.globalAlpha = (o.alpha == null ? 1 : o.alpha) * (0.3 - 0.12 * Math.min(1, air));
      g.beginPath(); g.ellipse(0, 2 * s, (17 - 5 * Math.min(1, air)) * s, (6.2 - 2 * Math.min(1, air)) * s, 0, 0, 7); g.fillStyle = '#000'; g.fill();
    }
    g.globalAlpha = o.alpha == null ? 1 : o.alpha;
    const float = id === 'ghost' ? 6 + Math.sin(t * 3) * 2.5 : 0;
    const moving = spd > 0.05, ph = Math.sin(t * gt.f);
    const bob = moving ? Math.abs(ph) * gt.bob * spd : Math.sin(t * 3) * 0.9;
    const sq = moving ? (0.5 - Math.abs(ph)) * 2 * gt.sq * spd : Math.sin(t * 3) * 0.015;
    const sway = moving ? Math.sin(t * gt.f * 0.5) * gt.sway * spd : 0;
    g.scale(s * face, s);
    g.translate(0, -(o.air || 0) * 46 - float - bob - up);
    g.rotate(sway + gt.lean * spd * 0.6 + (o.lean ? o.lean * face : 0));
    if (pz && pz.rot) { g.translate(0, -20); g.rotate(pz.rot); g.translate(0, 20); }
    const st = sq + (o.stretch || 0) + (pz ? pz.sq : 0), cr = gt.crouch * spd;
    g.scale(1 + st + cr * 0.5, (1 - st) * (1 - cr));
    g.lineJoin = 'round'; g.lineCap = 'round';
    DRAW[id](g, c, o2);
    if (o2.hat) drawHat(g, id, o2.hat, o2);
    g.restore();
  }

  /* --------------------- fitting: measure what a character really covers --------------------- */
  const fitCache = new Map();
  /** Bounding box (in character units, feet at 0,0) of a character over its animation, incl. its hat. */
  function fit(ci, hat) {
    const key = ci + ':' + (hat | 0);
    let f = fitCache.get(key);
    if (f) return f;
    const W = 280, H = 280, OX = 140, OY = 200;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const g = cv.getContext('2d', { willReadFrequently: true });
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const [spd, n] of [[0, 2], [1, 4]]) for (let i = 0; i < n; i++) {
      g.clearRect(0, 0, W, H);
      draw(g, ci, { x: OX, y: OY, s: 1, t: i * 0.37, spd, face: 1, shadow: false, hat, lx: 0.001 });
      const d = g.getImageData(0, 0, W, H).data;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    f = { x0: x0 - OX, x1: x1 - OX + 1, y0: y0 - OY, y1: y1 - OY + 1 };
    f.w = f.x1 - f.x0; f.h = f.y1 - f.y0; f.cx = (f.x0 + f.x1) / 2; f.cy = (f.y0 + f.y1) / 2;
    fitCache.set(key, f);
    return f;
  }

  const hatCache = new Map();
  /** A small picture of a hat on its own (for the hat chooser); 0 = the "no hat" sign. Cropped to the hat and centred. */
  function hatIcon(h, size) {
    size = size || 48; h = h | 0;
    const key = h + ':' + size;
    let u = hatCache.get(key);
    if (u) return u;
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const g = cv.getContext('2d');
    g.lineJoin = 'round'; g.lineCap = 'round';
    if (!h) {
      const r = size * 0.27;
      g.lineWidth = size * 0.09; g.strokeStyle = OUT; g.globalAlpha = 0.55;
      g.beginPath(); g.arc(size / 2, size / 2, r, 0, Math.PI * 2); g.moveTo(size / 2 - r * 0.7, size / 2 + r * 0.7); g.lineTo(size / 2 + r * 0.7, size / 2 - r * 0.7); g.stroke();
    } else {
      const W = 220, H = 220, S = 4;
      const probe = document.createElement('canvas'); probe.width = W; probe.height = H;
      const p = probe.getContext('2d', { willReadFrequently: true });
      p.lineJoin = 'round'; p.lineCap = 'round';
      p.translate(W / 2, H * 0.72); p.scale(S, S);
      drawHat(p, 'icon', h, { t: 0 });
      const d = p.getImageData(0, 0, W, H).data;
      let x0 = W, x1 = 0, y0 = H, y1 = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (d[(y * W + x) * 4 + 3] > 12) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const w = x1 - x0 + 1, hh = y1 - y0 + 1, s = Math.min((size * 0.88) / w, (size * 0.88) / hh);
      g.drawImage(probe, x0, y0, w, hh, (size - w * s) / 2, (size - hh * s) / 2, w * s, hh * s);
    }
    u = cv.toDataURL();
    hatCache.set(key, u);
    return u;
  }

  const avCache = new Map();
  /** A portrait that always fits its canvas, centred, never clipped (hat optional). */
  function avatar(ci, ki, size, hat) {
    size = size || 64; hat = hat | 0;
    const key = ci + ':' + ki + ':' + size + ':' + hat;
    let u = avCache.get(key);
    if (u) return u;
    const f = fit(ci, hat), s = Math.min(size / 62, (size * 0.92) / f.w, (size * 0.92) / f.h);
    const cv = document.createElement('canvas'); cv.width = cv.height = size;
    const g = cv.getContext('2d');
    draw(g, ci, { x: size / 2 - f.cx * s, y: size / 2 - f.cy * s, s, color: C.colorFor(ki), face: 1, t: 0.3, shadow: false, hat });
    u = cv.toDataURL();
    if (avCache.size > 600) avCache.clear();     // custom colours can generate lots of keys
    avCache.set(key, u);
    return u;
  }

  /* --------------------------- poses: little GSAP acting bits --------------------------- */
  // A pose is {up, rot, sq} on a plain object that draw() reads; timelines tween it and settle back to rest.
  const REST = { up: 0, rot: 0, sq: 0 };
  const reducedMotion = () => !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const POSES = {
    dash:    (p, f) => [[{ sq: 0.2, rot: -0.12, duration: 0.07, ease: 'power2.out' }], [{ sq: -0.16, rot: 0.34, duration: 0.12, ease: 'power2.out' }], [{ ...REST, duration: 0.35, ease: 'elastic.out(1, 0.5)' }]],
    leap:    (p, f) => [[{ sq: 0.26, duration: 0.1, ease: 'power2.out' }], [{ sq: -0.14, duration: 0.14, ease: 'power2.out' }], [{ ...REST, duration: 0.4, ease: 'elastic.out(1, 0.5)' }]],
    phase:   () => [[{ rot: 0.22, sq: -0.08, duration: 0.12, ease: 'sine.inOut' }], [{ rot: -0.22, duration: 0.2, ease: 'sine.inOut' }], [{ rot: 0.12, duration: 0.16, ease: 'sine.inOut' }], [{ ...REST, duration: 0.2, ease: 'sine.out' }]],
    cloak:   () => [[{ sq: 0.24, duration: 0.1, ease: 'power2.out' }], [{ ...REST, duration: 0.45, ease: 'elastic.out(1, 0.45)' }]],
    stomp:   () => [[{ sq: 0.22, duration: 0.1, ease: 'power2.out' }], [{ up: 16, sq: -0.2, duration: 0.13, ease: 'power2.out' }], [{ up: 0, sq: 0.3, duration: 0.09, ease: 'power4.in' }], [{ ...REST, duration: 0.5, ease: 'elastic.out(1, 0.4)' }]],
    goo:     () => [[{ sq: 0.3, up: -2, duration: 0.09, ease: 'power2.out' }], [{ sq: -0.16, duration: 0.12, ease: 'power2.out' }], [{ ...REST, duration: 0.4, ease: 'elastic.out(1, 0.45)' }]],
    decoy:   () => [[{ up: 9, rot: -0.28, sq: -0.1, duration: 0.14, ease: 'power2.out' }], [{ up: 0, rot: 0.1, sq: 0.1, duration: 0.12, ease: 'power2.in' }], [{ ...REST, duration: 0.3, ease: 'back.out(2)' }]],
    shield:  () => [[{ sq: -0.14, up: 3, duration: 0.12, ease: 'back.out(3)' }], [{ ...REST, duration: 0.4, ease: 'elastic.out(1, 0.5)' }]],
    shieldhit: () => [[{ rot: -0.3, sq: 0.18, duration: 0.07, ease: 'power2.out' }], [{ ...REST, duration: 0.4, ease: 'elastic.out(1, 0.4)' }]],
    slide:   () => [[{ sq: 0.18, duration: 0.07, ease: 'power2.out' }], [{ sq: 0, duration: 0.2, ease: 'power2.out' }]],      // the belly flop itself is held in game.js while sliding
    swap:    (p, f) => [[{ rot: Math.PI * 4 * f, sq: -0.1, duration: 0.42, ease: 'power3.out' }], [{ ...REST, duration: 0.001 }]],
    echo:    () => [[{ up: 10, rot: 0.4, duration: 0.14, ease: 'power2.out' }], [{ ...REST, duration: 0.4, ease: 'bounce.out' }]],
    recall:  () => [[{ sq: -0.3, duration: 0.07, ease: 'power2.out' }], [{ ...REST, duration: 0.45, ease: 'elastic.out(1, 0.4)' }]],
    pounce:  (p, f) => [[{ sq: 0.18, rot: -0.1, duration: 0.06, ease: 'power2.out' }], [{ sq: -0.18, rot: 0.42, duration: 0.12, ease: 'power2.out' }], [{ ...REST, duration: 0.35, ease: 'elastic.out(1, 0.5)' }]],
    spin:    (p, f) => [[{ sq: 0.24, duration: 0.09, ease: 'power2.out' }], [{ sq: 0, up: 5, duration: 0.14, ease: 'power2.out' }], [{ up: 0, duration: 0.2, ease: 'power2.in' }]],
    gust:    () => [[{ sq: 0.3, duration: 0.1, ease: 'power2.out' }], [{ up: 14, sq: -0.22, rot: -0.14, duration: 0.14, ease: 'power3.out' }], [{ ...REST, duration: 0.45, ease: 'elastic.out(1, 0.4)' }]],
    bounce:  () => [[{ sq: 0.2, duration: 0.05, ease: 'power2.out' }], [{ ...REST, duration: 0.3, ease: 'elastic.out(1, 0.45)' }]],
    hit:     () => [[{ sq: 0.24, rot: -0.2, duration: 0.07, ease: 'power2.out' }], [{ rot: 0.12, sq: -0.1, duration: 0.1, ease: 'power2.inOut' }], [{ ...REST, duration: 0.4, ease: 'elastic.out(1, 0.4)' }]],
    hello:   () => [[{ up: 12, sq: -0.14, duration: 0.16, ease: 'power2.out' }], [{ up: 0, sq: 0.18, duration: 0.14, ease: 'power2.in' }], [{ ...REST, duration: 0.5, ease: 'elastic.out(1, 0.4)' }]],
  };
  /** Play a named pose on `v` (any object; v.pose is created on demand). face = +1/-1 so spins go the way you face. */
  function pose(v, name, face) {
    if (!v) return;
    const p = v.pose || (v.pose = { up: 0, rot: 0, sq: 0 });
    const mk = POSES[name];
    if (!mk || reducedMotion()) return;
    if (v.poseTl) v.poseTl.kill();
    gsap.killTweensOf(p);
    const tl = gsap.timeline({ onComplete: () => { p.up = p.rot = p.sq = 0; } });
    for (const [vars] of mk(p, face || 1)) tl.to(p, { ...vars, overwrite: false });
    v.poseTl = tl;
  }

  /* ability icons (inline SVG, stroke-based so they inherit currentColor) */
  const ICON = {
    dash: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
    spin: '<path d="M12 2.8l2.7 6 6.5.6-4.9 4.3 1.5 6.4L12 16.7 6.2 20.1l1.5-6.4L2.8 9.4l6.5-.6z"/>',
    leap: '<path d="M3 19c2-9 9-13 17-8"/><path d="M15 5.5 20 11l-6.5 2"/>',
    phase: '<circle cx="12" cy="12" r="8.5" stroke-dasharray="3 3.2"/><circle cx="12" cy="12" r="2.6"/>',
    cloak: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 20 20 4"/>',
    stomp: '<path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5M5.3 5.3l3.5 3.5M15.2 15.2l3.5 3.5M18.7 5.3l-3.5 3.5M8.8 15.2l-3.5 3.5"/>',
    goo: '<path d="M12 3c4 5 7 8 7 12a7 7 0 0 1-14 0c0-4 3-7 7-12z"/><path d="M9 15a3 3 0 0 0 3 3"/>',
    decoy: '<circle cx="9" cy="12" r="6"/><circle cx="15.5" cy="12" r="6" stroke-dasharray="2.2 3"/>',
    shield: '<path d="M12 3 4.5 6v6c0 4.8 3.2 7.7 7.5 9 4.3-1.3 7.5-4.2 7.5-9V6z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
    slide: '<path d="M3 15c4 0 5-7 10-7 3 0 3 4 8 4"/><path d="M3 20h18"/><circle cx="7" cy="12" r="0.8"/>',
    swap: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
    gust: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 13h16a3 3 0 1 1-3 3"/><path d="M3 18h7"/>',
    echo: '<circle cx="12" cy="12" r="2"/><path d="M7.6 7.6a6.2 6.2 0 0 0 0 8.8M16.4 7.6a6.2 6.2 0 0 1 0 8.8M4.6 4.6a10.4 10.4 0 0 0 0 14.8M19.4 4.6a10.4 10.4 0 0 1 0 14.8"/>',
  };
  const icon = (fx, cls) => `<svg viewBox="0 0 24 24" class="${cls || 'ico'}" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[fx] || ''}</svg>`;

  return { draw, avatar, hatIcon, fit, pose, shade, colorOf, palette, icon, GAIT };
})();
