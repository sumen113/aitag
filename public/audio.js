/* Tag Rush - tiny WebAudio synth. No audio files: every effect is generated on the fly. */
const Sfx = (() => {
  let ac = null, master = null, muted = false;
  try { muted = JSON.parse(localStorage.getItem('tagrush.mute') || 'false'); } catch (e) { /* storage blocked */ }

  function ctx() {
    if (!ac) {
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        master = ac.createGain(); master.gain.value = 0.45; master.connect(ac.destination);
      } catch (e) { ac = null; }
    }
    if (ac && ac.state === 'suspended') ac.resume();
    return ac;
  }

  function tone(freq, dur, type, vol, slideTo, delay) {
    const a = ctx(); if (!a || muted) return;
    const t0 = a.currentTime + (delay || 0);
    const o = a.createOscillator(), g = a.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function noise(dur, vol, freq, delay, sweepTo) {
    const a = ctx(); if (!a || muted) return;
    const t0 = a.currentTime + (delay || 0), n = Math.floor(a.sampleRate * dur);
    const buf = a.createBuffer(1, n, a.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = a.createBufferSource(); s.buffer = buf;
    const f = a.createBiquadFilter(); f.type = 'bandpass'; f.frequency.setValueAtTime(freq || 1200, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
    const g = a.createGain(); g.gain.value = vol || 0.2;
    s.connect(f); f.connect(g); g.connect(master); s.start(t0);
  }

  const S = {
    tag() { tone(520, 0.16, 'square', 0.16, 180); tone(300, 0.22, 'sawtooth', 0.1, 90, 0.04); noise(0.12, 0.25, 1800, 0, 400); },
    tagged() { tone(220, 0.35, 'sawtooth', 0.18, 70); tone(440, 0.12, 'square', 0.1, 880, 0.02); },
    youreIt() { tone(660, 0.12, 'square', 0.14); tone(440, 0.12, 'square', 0.14, null, 0.13); tone(660, 0.18, 'square', 0.14, null, 0.26); },
    tick() { tone(880, 0.09, 'triangle', 0.18); },
    fuse() { tone(1250, 0.05, 'square', 0.1); },
    boom() { tone(120, 0.55, 'sawtooth', 0.32, 38); noise(0.5, 0.45, 500, 0, 90); tone(60, 0.6, 'sine', 0.35, 28); },
    infect() { tone(200, 0.3, 'sawtooth', 0.16, 90); tone(150, 0.35, 'square', 0.1, 60, 0.08); noise(0.2, 0.15, 500, 0, 200); },
    vote() { tone(700, 0.07, 'triangle', 0.14); tone(1050, 0.09, 'triangle', 0.14, null, 0.06); },
    voteOpen() { [392, 523, 659].forEach((f, i) => tone(f, 0.14, 'triangle', 0.14, null, i * 0.07)); },
    go() { tone(523, 0.1, 'square', 0.14); tone(784, 0.1, 'square', 0.14, null, 0.09); tone(1046, 0.25, 'square', 0.16, null, 0.18); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.2, null, i * 0.11)); tone(1318, 0.5, 'triangle', 0.18, null, 0.46); },
    dash() { noise(0.22, 0.3, 900, 0, 3500); tone(300, 0.18, 'sawtooth', 0.07, 900); },
    leap() { tone(240, 0.3, 'sine', 0.2, 720); noise(0.18, 0.12, 1500, 0.02, 600); },
    phase() { tone(420, 0.6, 'sine', 0.14, 900); tone(630, 0.6, 'sine', 0.09, 1350, 0.03); },
    cloak() { noise(0.5, 0.18, 400, 0, 2200); tone(180, 0.5, 'sine', 0.1, 60); },
    seed() { tone(300, 0.07, 'square', 0.14, 900); noise(0.1, 0.18, 2400, 0, 800); tone(180, 0.18, 'triangle', 0.1, 90, 0.05); },
    seedhit() { tone(140, 0.2, 'square', 0.18, 60); noise(0.1, 0.25, 700, 0, 200); tone(520, 0.1, 'triangle', 0.1, 260, 0.03); },
    gust() { noise(0.45, 0.32, 600, 0, 3200); tone(520, 0.25, 'triangle', 0.1, 1100); tone(380, 0.2, 'sine', 0.08, 760, 0.05); },
    stomp() { tone(110, 0.4, 'sine', 0.4, 40); noise(0.3, 0.35, 300, 0, 100); },
    goo() { tone(300, 0.25, 'sine', 0.2, 120); tone(220, 0.2, 'sine', 0.15, 90, 0.07); },
    decoy() { tone(700, 0.08, 'square', 0.12); tone(900, 0.12, 'square', 0.12, null, 0.08); },
    shield() { tone(500, 0.3, 'triangle', 0.16, 900); tone(750, 0.3, 'sine', 0.1, 1200, 0.04); },
    shieldhit() { tone(900, 0.12, 'square', 0.18, 300); noise(0.18, 0.28, 3000, 0, 800); tone(180, 0.25, 'sawtooth', 0.1, 70, 0.03); },
    tele() { tone(300, 0.35, 'sine', 0.18, 1200); tone(1200, 0.25, 'sine', 0.12, 300, 0.18); },
    pop() { tone(900, 0.1, 'square', 0.14, 200); noise(0.08, 0.2, 2500); },
    join() { tone(600, 0.08, 'triangle', 0.1); tone(900, 0.1, 'triangle', 0.1, null, 0.08); },
    emote() { tone(780, 0.08, 'sine', 0.12, 1040); },
    ready() { tone(900, 0.07, 'sine', 0.12); tone(1350, 0.1, 'sine', 0.12, null, 0.06); },
    click() { tone(500, 0.05, 'triangle', 0.1); },
    chat() { tone(1040, 0.05, 'triangle', 0.08); tone(1320, 0.06, 'triangle', 0.07, null, 0.04); },
    slide() { noise(0.5, 0.2, 2500, 0, 700); tone(520, 0.4, 'triangle', 0.08, 220); },
    spin() { noise(0.3, 0.22, 700, 0, 2600); tone(420, 0.26, 'triangle', 0.1, 900); tone(630, 0.16, 'sine', 0.06, 1100, 0.05); },
    boing() { tone(220, 0.16, 'sine', 0.14, 520); tone(440, 0.09, 'triangle', 0.06, 700, 0.03); },
    bowl() { tone(260, 0.2, 'square', 0.16, 90); noise(0.14, 0.24, 1200, 0, 300); tone(660, 0.08, 'triangle', 0.1, null, 0.05); },
    swap() { tone(400, 0.18, 'sine', 0.16, 900); tone(900, 0.18, 'sine', 0.16, 400, 0.12); noise(0.1, 0.1, 2000, 0.1); },
    echo() { tone(1100, 0.5, 'sine', 0.1, 600); tone(1100, 0.5, 'sine', 0.06, 600, 0.18); tone(1100, 0.5, 'sine', 0.03, 600, 0.36); },
    recall() { tone(900, 0.22, 'sine', 0.16, 250); noise(0.14, 0.14, 3000, 0, 500); },
    pounce() { noise(0.2, 0.28, 1100, 0, 4000); tone(200, 0.16, 'sawtooth', 0.1, 700); },
    dig() { noise(0.18, 0.3, 500, 0, 150); tone(160, 0.14, 'triangle', 0.14, 90); noise(0.12, 0.22, 900, 0.1, 300); },
    pitfall() { tone(520, 0.45, 'sine', 0.2, 90); noise(0.25, 0.3, 700, 0.05, 150); tone(110, 0.25, 'square', 0.12, 55, 0.3); },
    burrow() { noise(0.4, 0.28, 400, 0, 100); tone(130, 0.35, 'sawtooth', 0.1, 60); tone(90, 0.3, 'sine', 0.18, 50, 0.05); },
    surface() { noise(0.25, 0.32, 900, 0, 250); tone(200, 0.2, 'triangle', 0.16, 520); tone(90, 0.25, 'sine', 0.3, 40); },
    kick() { tone(140, 0.2, 'square', 0.22, 55); noise(0.14, 0.34, 1400, 0, 300); tone(70, 0.28, 'sine', 0.3, 38, 0.03); tone(330, 0.3, 'sawtooth', 0.08, 180, 0.12); },
    stink() { noise(0.5, 0.22, 500, 0, 120); tone(130, 0.5, 'sawtooth', 0.08, 90); tone(98, 0.45, 'sine', 0.1, 70, 0.08); },
    splash() { noise(0.28, 0.26, 700, 0, 250); tone(340, 0.18, 'sine', 0.16, 120); },
    buy() { [660, 880, 1175].forEach((f, i) => tone(f, 0.14, 'triangle', 0.16, null, i * 0.07)); tone(1568, 0.3, 'triangle', 0.14, null, 0.22); },
    chestThud() { tone(90, 0.3, 'sine', 0.4, 40); noise(0.18, 0.3, 300, 0, 100); },
    chestShake(n) { const k = 1 + (n | 0) * 0.18; noise(0.12, 0.22, 600 * k, 0, 300); tone(150 * k, 0.1, 'square', 0.1, 90); tone(300 * k, 0.07, 'triangle', 0.08, null, 0.05); },
    chestOpen() { noise(0.5, 0.35, 800, 0, 5000); tone(220, 0.5, 'sawtooth', 0.14, 880); tone(440, 0.4, 'triangle', 0.12, 1320, 0.05); },
    reveal0() { [523, 659].forEach((f, i) => tone(f, 0.18, 'triangle', 0.18, null, i * 0.08)); },
    reveal1() { [523, 659, 784].forEach((f, i) => tone(f, 0.2, 'triangle', 0.2, null, i * 0.08)); },
    reveal2() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.2, null, i * 0.08)); tone(1568, 0.4, 'sine', 0.1, null, 0.34); },
    reveal3() { [392, 523, 659, 784, 1046].forEach((f, i) => tone(f, 0.24, 'square', 0.12, null, i * 0.08)); [1046, 1318, 1568].forEach((f) => tone(f, 0.8, 'triangle', 0.14, null, 0.42)); noise(0.7, 0.2, 3000, 0.3, 6000); },
    reveal4() { [262, 330, 392, 523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.28, 'square', 0.12, null, i * 0.07)); [1046, 1318, 1568, 2093].forEach((f) => tone(f, 1.2, 'triangle', 0.16, null, 0.62)); noise(1, 0.25, 2500, 0.5, 7000); tone(70, 0.8, 'sine', 0.4, 35, 0.55); },
    glitter() { tone(2093, 0.08, 'sine', 0.08); tone(2637, 0.1, 'sine', 0.07, null, 0.05); },
    equip() { tone(600, 0.08, 'triangle', 0.14); tone(900, 0.12, 'triangle', 0.14, null, 0.07); tone(1200, 0.18, 'sine', 0.1, null, 0.14); },
    craft() { tone(300, 0.15, 'square', 0.12, 150); noise(0.15, 0.25, 2000, 0.1, 800); [880, 1175, 1568].forEach((f, i) => tone(f, 0.18, 'triangle', 0.16, null, 0.25 + i * 0.07)); },
    deny() { tone(200, 0.16, 'square', 0.12, 130); },
  };

  return {
    play(n, a) { try { const f = S[n]; if (f) f(a); } catch (e) { /* audio is best-effort */ } },
    unlock() { ctx(); },
    get muted() { return muted; },
    setMuted(v) { muted = !!v; try { localStorage.setItem('tagrush.mute', JSON.stringify(muted)); } catch (e) { /* noop */ } },
  };
})();
