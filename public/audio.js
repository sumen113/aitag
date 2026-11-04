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
    go() { tone(523, 0.1, 'square', 0.14); tone(784, 0.1, 'square', 0.14, null, 0.09); tone(1046, 0.25, 'square', 0.16, null, 0.18); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.22, 'triangle', 0.2, null, i * 0.11)); tone(1318, 0.5, 'triangle', 0.18, null, 0.46); },
    dash() { noise(0.22, 0.3, 900, 0, 3500); tone(300, 0.18, 'sawtooth', 0.07, 900); },
    leap() { tone(240, 0.3, 'sine', 0.2, 720); noise(0.18, 0.12, 1500, 0.02, 600); },
    phase() { tone(420, 0.6, 'sine', 0.14, 900); tone(630, 0.6, 'sine', 0.09, 1350, 0.03); },
    cloak() { noise(0.5, 0.18, 400, 0, 2200); tone(180, 0.5, 'sine', 0.1, 60); },
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
  };

  return {
    play(n) { try { const f = S[n]; if (f) f(); } catch (e) { /* audio is best-effort */ } },
    unlock() { ctx(); },
    get muted() { return muted; },
    setMuted(v) { muted = !!v; try { localStorage.setItem('tagrush.mute', JSON.stringify(muted)); } catch (e) { /* noop */ } },
  };
})();
