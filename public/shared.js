/* ==========================================================================
   Tag Rush - shared game logic.
   Loaded by BOTH the Node server and the browser, so the player movement
   simulation is byte-for-byte identical on each side. That is what makes
   client-side prediction + server reconciliation feel seamless.
   ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TagShared = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ----------------------------- constants ------------------------------ */
  const TICK = 60;
  const DT = 1 / TICK;
  const MAX_PLAYERS = 15;
  const BASE_SPEED = 250;
  const IT_BOOST = 1.07;
  const ACCEL = 2400, FRIC = 2200;
  const ICE_ACCEL = 420, ICE_FRIC = 140;
  const ROUND_TIME = 90, COUNTDOWN = 4, RESULTS_TIME = 10, HEAD_START = 2.2;
  const SEED_SPEED = 800, SEED_RANGE = 640, SEED_R = 11;     // avocado seed: px/s, px, hit radius
  const TWO_IT_AT = 7;                                    // from this many players, a round starts with two taggers
  const itCountFor = (n) => (n >= TWO_IT_AT ? 2 : 1);
  const TAG_IMMUNITY = 2.0, TAG_LOCK = 0.6;
  const TAG_REACH = 10;                      // extra px of tag range beyond touching: generous on purpose (players are far from the server)
  const LAG_COMP_MAX = 0.16;                 // seconds of server-side rewind granted to the tagger
  const STATE = { WAIT: 0, COUNT: 1, PLAY: 2, RESULTS: 3, VOTE: 4 };
  const VOTE_TIME = 14;                      // seconds the map + mode vote stays open

  /* game modes: what a tag means and when a round ends */
  const MODES = [
    { id: 'classic',   name: 'Classic Tag', short: 'Classic', time: 0,   map: '',         boost: 1.07, blurb: 'One tagger. Stay untagged the longest to win.' },
    { id: 'infection', name: 'Infection',   short: 'Infection', time: 150, map: 'outbreak', boost: 1.0, blurb: 'Every tag infects. Be the last survivor. Plays on the big Outbreak map.' },
    { id: 'potato',    name: 'Hot Potato',  short: 'Potato',  time: 180, map: '',         boost: 1.1, blurb: 'Pass the potato before it blows up. Last one standing wins.' },
  ];
  const MODE_BY_ID = {}; MODES.forEach((m, i) => { m.i = i; MODE_BY_ID[m.id] = m; });
  const POTATO_START = 10, POTATO_MIN = 3, POTATO_PASS_STEP = 0.4, POTATO_ELIM_STEP = 0.5;      // fuse seconds: every pass and every elimination shortens it
  const potatoFuse = (passes, elims) => Math.max(POTATO_MIN, POTATO_START - POTATO_PASS_STEP * (passes || 0) - POTATO_ELIM_STEP * (elims || 0));
  const MODE_MIN_PLAYERS = 7;                                      // Infection and Hot Potato need a crowd; below this everything is classic tag

  /* ----------------------------- characters ----------------------------- */
  // color index 0 = the character's natural color
  // NEW entries are only ever appended (saved accounts store the index). 100+ = a custom colour, see colorFor().
  const COLORS = [null, '#ff5d73', '#ffb142', '#ffe66d', '#3ddc97', '#4cc9f0', '#7c6cff', '#ff78c4',
    '#2f80ed', '#ff4d2e', '#a4e82f', '#ffb39b', '#c5a8ff', '#14b8a6', '#f4f7ff', '#3b3560', '#e8b923'];
  const COLOR_NAMES = ['Natural', 'Cherry', 'Mango', 'Lemon', 'Mint', 'Sky', 'Grape', 'Bubblegum',
    'Ocean', 'Lava', 'Lime', 'Peach', 'Lavender', 'Teal', 'Snow', 'Shadow', 'Gold'];
  // Custom colours: k = CUSTOM_BASE + tone * 360 + hue (hue 0-359, tone 0 vivid / 1 pastel / 2 deep). Tiny to send, nothing to validate but the range.
  const CUSTOM_BASE = 100, CUSTOM_TONES = [[0.78, 0.58], [0.72, 0.8], [0.62, 0.36]], CUSTOM_MAX = CUSTOM_BASE + 360 * CUSTOM_TONES.length - 1;
  function hslHex(h, s, l) {
    const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12, v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(v * 255).toString(16).padStart(2, '0'); };
    return '#' + f(0) + f(8) + f(4);
  }
  /** Any saved/received colour index -> the sanitised index (0 = natural). */
  const cleanColor = (k) => { k = Math.trunc(+k); if (!Number.isFinite(k) || k < 0) return 0; if (k < COLORS.length) return k; return k >= CUSTOM_BASE && k <= CUSTOM_MAX ? k : 0; };
  /** colour index -> hex string, or null for the character's natural colour. */
  function colorFor(k) {
    k = cleanColor(k);
    if (k === 0) return null;
    if (k < COLORS.length) return COLORS[k];
    const n = k - CUSTOM_BASE, tone = Math.floor(n / 360), t = CUSTOM_TONES[tone];
    return hslHex(n % 360, t[0], t[1]);
  }
  /** A saved per-character colour list -> a clean array with one entry per character. */
  const cleanColorList = (a, n) => Array.from({ length: n }, (_, i) => cleanColor(Array.isArray(a) ? a[i] : 0));
  const customK = (hue, tone) => CUSTOM_BASE + (tone | 0) * 360 + (((Math.round(hue) % 360) + 360) % 360);
  const colorName = (k) => { k = cleanColor(k); return k < COLORS.length ? COLOR_NAMES[k] : 'Custom'; };

  // Hats: purely cosmetic, free for everyone. 0 = none. Drawn by chars.js.
  const HATS = ['None', 'Party hat', 'Crown', 'Top hat', 'Wizard hat', 'Halo', 'Cap', 'Flower', 'Chef hat'];
  const cleanHat = (h) => { h = Math.trunc(+h); return Number.isFinite(h) && h >= 0 && h < HATS.length ? h : 0; };

  // fx = the name of the ability effect that is sent to clients / handled by the server
  // starter: free for everyone (guests included). price: cost in wins in the shop for everyone else.
  const CHARS = [
    { id: 'fox',   fx: 'dash',   name: 'Ziggy', species: 'Fox',     natural: '#ff8a3d', ability: 'Dash',      cd: 8,  dur: 0.2,  speed: 1.00, radius: 18, role: 'Skirmisher', starter: true,
      desc: 'A lightning burst of speed in the direction you are moving.' },
    { id: 'frog',  fx: 'leap',   name: 'Hop',   species: 'Frog',    natural: '#55d16b', ability: 'Leap',      cd: 14, dur: 0.5,  speed: 0.95, radius: 18, role: 'Escape artist', price: 1,
      desc: 'Jump clean over walls and cannot be tagged in the air. Lands with a sticky splash.' },
    { id: 'ghost', fx: 'phase',  name: 'Boo',   species: 'Ghost',   natural: '#dfe7ff', ability: 'Phase',     cd: 11, dur: 2.0,  speed: 0.98, radius: 18, role: 'Wall walker', starter: true,
      desc: 'Drift straight through walls and obstacles for two seconds.' },
    { id: 'cat',   fx: 'cloak',  name: 'Shade', species: 'Cat',     natural: '#7e8bb5', ability: 'Cloak',     cd: 14, dur: 2.8,  speed: 1.00, radius: 17, role: 'Ambusher', price: 1,
      desc: 'Fade from sight and run faster. Press again mid-cloak to POUNCE out of nowhere.' },
    { id: 'bear',  fx: 'stomp',  name: 'Bruno', species: 'Bear',    natural: '#b07a4f', ability: 'Stomp',     cd: 12, dur: 0,    speed: 0.96, radius: 21, role: 'Bruiser', starter: true,
      desc: 'A shockwave that knocks back and stuns everyone nearby.' },
    { id: 'octo',  fx: 'goo',    name: 'Inky',  species: 'Octopus', natural: '#ff6fae', ability: 'Goo Trap',  cd: 7,  dur: 0,    speed: 1.02, radius: 19, role: 'Trapper', price: 2,
      desc: 'Drop a sticky puddle that slows everybody except you.' },
    { id: 'owl',   fx: 'decoy',  name: 'Hoot',  species: 'Owl',     natural: '#c9a26b', ability: 'Decoy',     cd: 9, dur: 0,    speed: 1.02, radius: 18, role: 'Trickster', price: 2,
      desc: 'Launch a decoy clone. If IT touches it, IT is stunned.' },
    { id: 'robot', fx: 'shield', name: 'Bolt',  species: 'Robot',   natural: '#5fb4ff', ability: 'Shield',    cd: 10, dur: 2.2,  speed: 1.00, radius: 18, role: 'Defender', price: 2,
      desc: 'Block one tag and stun whoever tries it. You move slower while it is up. As IT, it becomes a speed surge.' },
    { id: 'penguin', fx: 'slide', name: 'Waddle', species: 'Penguin', natural: '#4f6fd8', ability: 'Belly Slide', cd: 10, dur: 1.3, speed: 0.98, radius: 19, role: 'Bowler', price: 3,
      desc: 'Toboggan across the map on your belly. Slide into anyone to bowl them over and stun them.' },
    { id: 'raccoon', fx: 'swap', name: 'Bandit', species: 'Raccoon', natural: '#9a9fb4', ability: 'Swap', cd: 12, dur: 0, speed: 1.00, radius: 18, role: 'Swindler', price: 3,
      desc: 'Trade places with the nearest player in range. They are left dizzy for a moment.' },
    { id: 'bat',   fx: 'echo',   name: 'Echo',  species: 'Bat',     natural: '#8a64d6', ability: 'Echo Beacon', cd: 10, dur: 0, speed: 1.02, radius: 16, role: 'Time traveller', price: 3,
      desc: 'Drop a beacon, then press again within 4 seconds to snap back to it. Leave a trail, vanish, reappear.' },
    { id: 'star',  fx: 'spin',   name: 'Andy',  species: 'Starfish', natural: '#ef6a4c', ability: 'Ricochet', cd: 17, dur: 1.2, speed: 0.99, radius: 19, role: 'Pinball', price: 3,
      desc: 'Curl into a spinning star and ricochet off every wall. Steer gently while you roll.' },
    { id: 'bird',  fx: 'gust',   name: 'Pip',   species: 'Bird',    natural: '#ffd23f', ability: 'Gale', cd: 9, dur: 0, speed: 1.04, radius: 17, role: 'Wind caller', price: 2,
      desc: 'Flap a mighty gust that blows everyone nearby away, then glide off in a burst of speed.' },
    { id: 'avocado', fx: 'seed', name: 'Guac',  species: 'Avocado', natural: '#6aa84f', ability: 'Pit Shot', cd: 15, dur: 0, speed: 0.97, radius: 18, role: 'Sharpshooter', price: 6,
      desc: 'Spit a hard seed at your mouse (click or Space; on touch it goes where you steer). As IT it tags the first runner it hits; as a runner it stuns whoever is IT.' },
  ];
  const STARTERS = CHARS.filter((c) => c.starter).map((c) => c.id);

  /* ------------------------------- the shop ----------------------------- */
  // Everything purchasable lives in this list. To add a new kind of item later, add an entry here
  // (type: 'character' | 'colour' | 'trail' | ...) and teach the client how to show it; the server
  // already stores any item id in the player's inventory and checks the price + balance atomically.
  const SHOP = CHARS.filter((c) => !c.starter).map((c) => ({ id: 'char:' + c.id, type: 'character', ref: c.id, name: c.species, price: c.price, blurb: c.desc }));
  const SHOP_BY_ID = {}; SHOP.forEach((i) => (SHOP_BY_ID[i.id] = i));
  const STARTER_ITEMS = STARTERS.map((id) => 'char:' + id);
  /* ------------------------------ servers ------------------------------ */
  const SERVER_LIMITS = { MIN_TIME: 60, MAX_TIME: 600, DEF_TIME: 90, MIN_PLAYERS: 2, MAX_PLAYERS: 15, NAME_MIN: 3, NAME_MAX: 22, PASS_MIN: 3, PASS_MAX: 24 };
  const REGULAR_NAME = 'Regular server';
  /** Checks the settings for a player-made server. Used by the create form (instant feedback) and by the server (the real check). */
  function validateServer(o) {
    const L = SERVER_LIMITS; o = o || {};
    const name = String(o.name == null ? '' : o.name).replace(/\s+/g, ' ').trim();
    if (name.length < L.NAME_MIN) return { ok: false, err: `Give the server a name (at least ${L.NAME_MIN} characters).` };
    if (name.length > L.NAME_MAX) return { ok: false, err: `Server names are ${L.NAME_MAX} characters max.` };
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.!?'\-]*$/u.test(name)) return { ok: false, err: 'Use letters, numbers, spaces and . _ ! ? - in the server name.' };
    const flat = name.toLowerCase().replace(/[01345@$7]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', '@': 'a', $: 's', 7: 't' }[c])).replace(/[^a-z]/g, '');
    if (BAD.some((w) => flat.includes(w))) return { ok: false, err: 'That server name is not allowed.' };
    if (flat === 'regularserver' || flat === 'regular') return { ok: false, err: 'That name is reserved.' };
    const time = Number(o.time), max = Number(o.max);
    if (!Number.isInteger(time)) return { ok: false, err: 'Choose how long each game lasts.' };
    if (time < L.MIN_TIME) return { ok: false, err: `Games can't be shorter than ${L.MIN_TIME} seconds.` };
    if (time > L.MAX_TIME) return { ok: false, err: `Games can't be longer than ${L.MAX_TIME / 60} minutes.` };
    if (!Number.isInteger(max) || max < L.MIN_PLAYERS || max > L.MAX_PLAYERS) return { ok: false, err: `Max players must be ${L.MIN_PLAYERS} to ${L.MAX_PLAYERS}.` };
    const map = o.map === undefined || o.map === 'random' ? 'random' : String(o.map);
    if (map !== 'random' && !MAP_BY_ID[map]) return { ok: false, err: 'Unknown arena.' };
    const bots = o.bots === undefined || o.bots === '' ? 0 : Number(o.bots);
    if (!Number.isInteger(bots) || bots < 0 || bots > max - 1) return { ok: false, err: `Bots must be 0 to ${max - 1} (they use player slots).` };
    const diff = ['easy', 'normal', 'hard'].includes(o.diff) ? o.diff : 'normal';
    const pass = o.pass == null ? '' : String(o.pass);
    if (pass && (pass.length < SERVER_LIMITS.PASS_MIN || pass.length > SERVER_LIMITS.PASS_MAX)) return { ok: false, err: `Passwords are ${SERVER_LIMITS.PASS_MIN}-${SERVER_LIMITS.PASS_MAX} characters (or leave it empty for an open server).` };
    const mode = o.mode === undefined || o.mode === '' ? 'vote' : String(o.mode);
    if (mode !== 'vote' && !MODE_BY_ID[mode]) return { ok: false, err: 'Unknown game mode.' };
    return { ok: true, name, time, max, map, bots, diff, pass, mode };
  }

  /** True when a player holding `owned` (array of item ids; may be empty for guests) may use character `charId`. */
  function ownsChar(owned, charId) { return STARTERS.includes(charId) || (Array.isArray(owned) && owned.includes('char:' + charId)); }

  /* --------------------------- player names ----------------------------- */
  // Shared by the form (instant feedback) and the server (the real check).
  const BAD = ['fuck', 'shit', 'bitch', 'cunt', 'pussy', 'whore', 'slut', 'nigg', 'fagg', 'retard', 'hitler', 'porn', 'asshole', 'vagina', 'kkk'];
  function validateName(raw) {
    const name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (name.length < 2) return { ok: false, err: 'Enter a name (at least 2 characters).' };
    if (name.length > 14) return { ok: false, err: 'Names are 14 characters max.' };
    if (!/^[\p{L}\p{N}][\p{L}\p{N} _.\-]*$/u.test(name)) return { ok: false, err: 'Use letters, numbers, spaces, . _ or -' };
    const flat = name.toLowerCase().replace(/[01345@$7]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', '@': 'a', $: 's', 7: 't' }[c])).replace(/[^a-z]/g, '');
    if (BAD.some((w) => flat.includes(w))) return { ok: false, err: 'That name is not allowed.' };
    return { ok: true, name };
  }

  // Registered usernames are stricter than guest names: plain ASCII only, so nobody can register a look-alike
  // (e.g. a Cyrillic "a") of someone else's name.
  const RESERVED = ['admin', 'administrator', 'moderator', 'mod', 'system', 'server', 'tag rush', 'tagrush', 'staff', 'support', 'guest', 'bot'];
  function validateUsername(raw) {
    const name = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (name.length < 3) return { ok: false, err: 'Usernames need at least 3 characters.' };
    if (name.length > 14) return { ok: false, err: 'Usernames are 14 characters max.' };
    if (!/^[A-Za-z0-9][A-Za-z0-9 _.\-]*$/.test(name)) return { ok: false, err: 'Use English letters, numbers, spaces, . _ or -' };
    if (RESERVED.includes(name.toLowerCase())) return { ok: false, err: 'That name is reserved.' };
    const v = validateName(name); if (!v.ok) return v;
    return { ok: true, name };
  }
  function validatePassword(pw) {
    pw = String(pw == null ? '' : pw);
    if (pw.length < 8) return { ok: false, err: 'Passwords need at least 8 characters.' };
    if (pw.length > 72) return { ok: false, err: 'Passwords are 72 characters max.' };
    return { ok: true };
  }
  /** Sanitise a chat line: strip control chars, squash spaces, mask links and bad words, cap the length. */
  const flatten = (w) => w.toLowerCase().replace(/[01345@$7]/g, (c) => ({ 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', '@': 'a', $: 's', 7: 't' }[c])).replace(/[^a-z]/g, '');
  function cleanChat(raw) {
    let t = String(raw == null ? '' : raw).replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    t = t.slice(0, 80);
    t = t.split(' ').map((w) => {
      if (/^(https?:|www\.)/i.test(w) || /\.(com|net|org|io|gg|co|xyz|ru|cn|tk)\b/i.test(w)) return '[link]';
      const f = flatten(w);
      return f && BAD.some((b) => f.includes(b)) ? '*'.repeat(Math.min(w.length, 8)) : w;
    }).join(' ');
    return t;
  }

  /* ------------------------------ helpers ------------------------------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* -------------------------------- maps -------------------------------- */
  // obstacles: {t:'c',x,y,r,k} circle | {t:'r',x,y,w,h,k} rect
  // zones:     {k:'mud'|'grip'|'ice', t:'c'|'r', ...} | {k:'boost',x,y,r,a} | {k:'tele',x,y,r,to}
  //            {k:'belt',t:'r',x,y,w,h,a,s} conveyor | {k:'swirl',x,y,r,dir,s} whirlpool | {k:'bump',x,y,r} pinball kicker | {k:'hide',x,y,r} bush (client-side stealth)
  function buildPark() {
    const obs = [], zones = [];
    obs.push({ t: 'c', x: 1000, y: 650, r: 150, k: 'pond' });
    for (const [x, y] of [[260, 240], [1740, 240], [260, 1060], [1740, 1060], [700, 290], [1300, 290],
      [700, 1010], [1300, 1010], [500, 650], [1500, 650], [1000, 110], [1000, 1190]])
      obs.push({ t: 'c', x, y, r: 44, k: 'tree' });
    for (const [x, y, w, h] of [[800, 430, 400, 34], [800, 836, 400, 34], [160, 540, 34, 220], [1806, 540, 34, 220]])
      obs.push({ t: 'r', x, y, w, h, k: 'hedge' });
    for (const [x, y, w, h] of [[560, 840, 120, 30], [1320, 430, 120, 30]])
      obs.push({ t: 'r', x, y, w, h, k: 'bench' });
    for (const [x, y] of [[400, 430], [1600, 430], [400, 870], [1600, 870]])
      zones.push({ k: 'mud', t: 'c', x, y, r: 95 });
    for (const [x, y] of [[850, 190], [1150, 190], [850, 1110], [1150, 1110], [330, 650], [1670, 650]])      // bushes: other players can't see you in there unless they are close
      zones.push({ k: 'hide', t: 'c', x, y, r: 88 });
    return { id: 'park', name: 'Sunny Park', blurb: 'Trees, sticky mud and bushes to hide in.', w: 2000, h: 1300, theme: 'park', baseIce: false, obs, zones };
  }

  function buildNeon() {
    const obs = [], zones = [];
    for (const x of [400, 800, 1200, 1600]) for (const y of [300, 1000])
      obs.push({ t: 'r', x: x - 40, y: y - 40, w: 80, h: 80, k: 'pillar' });
    obs.push({ t: 'r', x: 940, y: 590, w: 120, h: 120, k: 'core' });
    obs.push({ t: 'r', x: 640, y: 636, w: 220, h: 28, k: 'bar' }, { t: 'r', x: 1140, y: 636, w: 220, h: 28, k: 'bar' });
    obs.push({ t: 'r', x: 150, y: 480, w: 30, h: 340, k: 'bar' }, { t: 'r', x: 1820, y: 480, w: 30, h: 340, k: 'bar' });
    zones.push({ k: 'boost', x: 270, y: 650, r: 50, a: 0 }, { k: 'boost', x: 1730, y: 650, r: 50, a: Math.PI });
    zones.push({ k: 'boost', x: 1000, y: 410, r: 46, a: 0 }, { k: 'boost', x: 1480, y: 650, r: 46, a: Math.PI / 2 }, { k: 'boost', x: 1000, y: 890, r: 46, a: Math.PI }, { k: 'boost', x: 520, y: 650, r: 46, a: -Math.PI / 2 });      // a racing line round the core
    zones.push({ k: 'belt', t: 'r', x: 380, y: 150, w: 1240, h: 90, a: 0, s: 190 }, { k: 'belt', t: 'r', x: 380, y: 1060, w: 1240, h: 90, a: Math.PI, s: 190 });     // data streams: ride them or fight them
    return { id: 'neon', name: 'Neon Grid', blurb: 'Pillars, boost pads and data streams in the dark.', w: 2000, h: 1300, theme: 'neon', baseIce: false, obs, zones };
  }

  function buildFrost() {
    const obs = [], zones = [];
    for (const [x, y] of [[420, 300], [1580, 300], [420, 1000], [1580, 1000], [1000, 650], [700, 470], [1300, 830], [700, 830], [1300, 470]])
      obs.push({ t: 'c', x, y, r: 52, k: 'rock' });
    for (const [x, y, w, h] of [[820, 170, 360, 56], [820, 1074, 360, 56], [230, 600, 56, 100], [1714, 600, 56, 100]])
      obs.push({ t: 'r', x, y, w, h, k: 'berg' });
    for (const [x, y, w, h] of [[310, 376, 130, 44], [1560, 880, 130, 44], [310, 880, 130, 44], [1560, 376, 130, 44]]) obs.push({ t: 'r', x, y, w, h, k: 'berg' });      // corner shelters
    for (const [x, y, r] of [[1000, 650, 190], [400, 650, 110], [1600, 650, 110], [1000, 330, 100], [1000, 970, 100]])
      zones.push({ k: 'grip', t: 'c', x, y, r });
    for (const [x, y, r] of [[600, 700, 85], [1400, 600, 85], [1000, 1210, 75], [1000, 90, 70]]) zones.push({ k: 'hide', t: 'c', x, y, r });      // snow drifts
    return { id: 'frost', name: 'Frosty Lake', blurb: 'Slippery ice, snow for grip and drifts to hide in.', w: 2000, h: 1300, theme: 'frost', baseIce: true, obs, zones };
  }

  function buildCandy() {
    const W = 1800, H = 1200, cols = 7, rows = 5, cw = W / cols, ch = H / rows, th = 28;
    const R = mulberry32(20241103);
    const vw = [], hw = [];                       // wall present flags
    for (let r = 0; r < rows; r++) { vw[r] = []; for (let c = 0; c < cols - 1; c++) vw[r][c] = true; }
    for (let r = 0; r < rows - 1; r++) { hw[r] = []; for (let c = 0; c < cols; c++) hw[r][c] = true; }
    const seen = new Set(); const stack = [[0, 0]]; seen.add(0);
    while (stack.length) {
      const [c, r] = stack[stack.length - 1];
      const nb = [];
      if (c > 0 && !seen.has(r * cols + c - 1)) nb.push([c - 1, r, 'v', c - 1, r]);
      if (c < cols - 1 && !seen.has(r * cols + c + 1)) nb.push([c + 1, r, 'v', c, r]);
      if (r > 0 && !seen.has((r - 1) * cols + c)) nb.push([c, r - 1, 'h', c, r - 1]);
      if (r < rows - 1 && !seen.has((r + 1) * cols + c)) nb.push([c, r + 1, 'h', c, r]);
      if (!nb.length) { stack.pop(); continue; }
      const [nc, nr, kind, wc, wr] = nb[Math.floor(R() * nb.length)];
      if (kind === 'v') vw[wr][wc] = false; else hw[wr][wc] = false;
      seen.add(nr * cols + nc); stack.push([nc, nr]);
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++) if (vw[r][c] && R() < 0.2) vw[r][c] = false;
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++) if (hw[r][c] && R() < 0.2) hw[r][c] = false;
    const obs = [], zones = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols - 1; c++)
      if (vw[r][c]) obs.push({ t: 'r', x: (c + 1) * cw - th / 2, y: r * ch - th / 2, w: th, h: ch + th, k: 'wall' });
    for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols; c++)
      if (hw[r][c]) obs.push({ t: 'r', x: c * cw - th / 2, y: (r + 1) * ch - th / 2, w: cw + th, h: th, k: 'wall' });
    const cells = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([c, r]);
    for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
    for (let i = 0; i < 3; i++) { const [c, r] = cells[i]; zones.push({ k: 'mud', t: 'c', x: (c + 0.5) * cw, y: (r + 0.5) * ch, r: 80 }); }
    const angs = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
    for (let i = 3; i < 6; i++) { const [c, r] = cells[i]; zones.push({ k: 'boost', x: (c + 0.5) * cw, y: (r + 0.5) * ch, r: 46, a: angs[Math.floor(R() * 4)] }); }
    for (let i = 6; i < 9; i++) { const [c, r] = cells[i]; zones.push({ k: 'belt', t: 'r', x: (c + 0.5) * cw - 95, y: (r + 0.5) * ch - 36, w: 190, h: 72, a: angs[Math.floor(R() * 4)], s: 160 }); }      // licorice conveyors
    return { id: 'candy', name: 'Candy Maze', blurb: 'Sweet corridors, jelly, sugar rush pads and licorice conveyors.', w: W, h: H, theme: 'candy', baseIce: false, obs, zones };
  }

  function buildStation() {
    const obs = [], zones = [];
    for (const [x, y, w, h] of [[740, 490, 200, 34], [1060, 490, 200, 34], [740, 776, 200, 34], [1060, 776, 200, 34],
      [740, 490, 34, 110], [740, 700, 34, 110], [1226, 490, 34, 110], [1226, 700, 34, 110]])
      obs.push({ t: 'r', x, y, w, h, k: 'wall' });
    obs.push({ t: 'c', x: 1000, y: 650, r: 60, k: 'reactor' });
    for (const [x, y] of [[500, 650], [1500, 650], [1000, 300], [1000, 1000]]) obs.push({ t: 'r', x: x - 32, y: y - 32, w: 64, h: 64, k: 'crate' });
    for (const [x, y, w, h] of [[300, 250, 160, 36], [1540, 250, 160, 36], [300, 1014, 160, 36], [1540, 1014, 160, 36], [200, 500, 36, 300], [1764, 500, 36, 300]])
      obs.push({ t: 'r', x, y, w, h, k: 'wall' });
    zones.push({ k: 'tele', x: 140, y: 140, r: 48, to: 1, pair: 0 }, { k: 'tele', x: 1860, y: 1160, r: 48, to: 0, pair: 0 },
      { k: 'tele', x: 1860, y: 140, r: 48, to: 3, pair: 1 }, { k: 'tele', x: 140, y: 1160, r: 48, to: 2, pair: 1 });
    zones.push({ k: 'boost', x: 600, y: 260, r: 46, a: 0 }, { k: 'boost', x: 1400, y: 1040, r: 46, a: Math.PI },
      { k: 'boost', x: 330, y: 840, r: 46, a: -Math.PI / 2 }, { k: 'boost', x: 1670, y: 460, r: 46, a: Math.PI / 2 });
    zones.push({ k: 'swirl', t: 'c', x: 1000, y: 650, r: 260, dir: 1, s: 215 });         // the reactor's gravity well swings you round it
    return { id: 'station', name: 'Space Station', blurb: 'Teleporters, boost pads and a reactor that spins you round.', w: 2000, h: 1300, theme: 'station', baseIce: false, obs, zones };
  }


  /* Coral Reef: four whirlpools fling you round the reef; kelp forests hide you. */
  function buildReef() {
    const obs = [], zones = [];
    for (const [x, y, r] of [[300, 200, 50], [1700, 200, 50], [300, 1100, 50], [1700, 1100, 50], [760, 230, 42], [1240, 230, 42], [760, 1070, 42], [1240, 1070, 42], [1000, 650, 58], [150, 650, 44], [1850, 650, 44]])
      obs.push({ t: 'c', x, y, r, k: 'coral' });
    for (const [x, y, w, h] of [[684, 520, 32, 260], [1284, 520, 32, 260], [880, 410, 240, 32], [880, 858, 240, 32]])
      obs.push({ t: 'r', x, y, w, h, k: 'reef' });
    for (const [x, y, dir] of [[480, 330, 1], [1520, 330, -1], [480, 970, -1], [1520, 970, 1]])
      zones.push({ k: 'swirl', t: 'c', x, y, r: 175, dir, s: 235 });
    for (const [x, y, r] of [[1000, 650, 135], [1000, 170, 90], [1000, 1130, 90], [340, 650, 95], [1660, 650, 95]])
      zones.push({ k: 'hide', t: 'c', x, y, r });
    return { id: 'reef', name: 'Coral Reef', blurb: 'Whirlpools that fling you around and kelp to hide in.', w: 2000, h: 1300, theme: 'reef', baseIce: false, obs, zones };
  }

  /* Factory Floor: a clockwise conveyor ring around the edge, two feed belts into a big press. */
  function buildFactory() {
    const obs = [], zones = [], PI = Math.PI;
    zones.push({ k: 'belt', t: 'r', x: 300, y: 170, w: 1400, h: 90, a: 0, s: 185 }, { k: 'belt', t: 'r', x: 1740, y: 300, w: 90, h: 700, a: PI / 2, s: 185 },
      { k: 'belt', t: 'r', x: 300, y: 1040, w: 1400, h: 90, a: PI, s: 185 }, { k: 'belt', t: 'r', x: 170, y: 300, w: 90, h: 700, a: -PI / 2, s: 185 },
      { k: 'belt', t: 'r', x: 420, y: 600, w: 400, h: 100, a: 0, s: 150 }, { k: 'belt', t: 'r', x: 1180, y: 600, w: 400, h: 100, a: PI, s: 150 });
    obs.push({ t: 'r', x: 880, y: 520, w: 240, h: 260, k: 'machine' });
    for (const [x, y] of [[520, 380], [1420, 880], [600, 900], [1340, 350], [1000, 960]]) obs.push({ t: 'r', x: x - 32, y: y - 32, w: 64, h: 64, k: 'crate' });
    for (const [x, y, w, h] of [[380, 330, 28, 170], [1592, 800, 28, 170], [1000, 330, 160, 28]]) obs.push({ t: 'r', x, y, w, h, k: 'pipe' });
    for (const [x, y, w, h] of [[640, 770, 130, 66], [1230, 464, 130, 66]]) obs.push({ t: 'r', x, y, w, h, k: 'press' });
    return { id: 'factory', name: 'Factory Floor', blurb: 'Conveyor belts everywhere. Run with them, or against them.', w: 2000, h: 1300, theme: 'factory', baseIce: false, obs, zones };
  }

  /* Pinball Palace: bumpers kick you, flipper pads fire you back into the table. */
  function buildPinball() {
    const obs = [], zones = [];
    for (const [x, y] of [[1000, 300], [850, 440], [1150, 440], [520, 640], [1480, 640], [1000, 650], [740, 900], [1260, 900]]) {
      obs.push({ t: 'c', x, y, r: 34, k: 'bumper' });
      zones.push({ k: 'bump', t: 'c', x, y, r: 62 });
    }
    for (const [x, y] of [[110, 110], [1890, 110], [110, 1190], [1890, 1190]]) obs.push({ t: 'c', x, y, r: 62, k: 'post' });
    obs.push({ t: 'r', x: 250, y: 330, w: 26, h: 640, k: 'rail' }, { t: 'r', x: 1724, y: 330, w: 26, h: 640, k: 'rail' });
    obs.push({ t: 'r', x: 560, y: 1040, w: 26, h: 130, k: 'rail' }, { t: 'r', x: 1414, y: 1040, w: 26, h: 130, k: 'rail' });
    zones.push({ k: 'boost', x: 130, y: 950, r: 46, a: -Math.PI / 2 }, { k: 'boost', x: 130, y: 650, r: 46, a: -Math.PI / 2 }, { k: 'boost', x: 1870, y: 950, r: 46, a: -Math.PI / 2 }, { k: 'boost', x: 1870, y: 650, r: 46, a: -Math.PI / 2 },
      { k: 'boost', x: 700, y: 1130, r: 50, a: -0.95 }, { k: 'boost', x: 1300, y: 1130, r: 50, a: -Math.PI + 0.95 });
    return { id: 'pinball', name: 'Pinball Palace', blurb: 'Bumpers kick you around, flipper pads fire you back.', w: 2000, h: 1300, theme: 'pinball', baseIce: false, obs, zones };
  }

  /* Outbreak: a big city for Infection. Streets 240 px wide, blocks with alleys, parked cars, barrels and a central plaza. */
  function buildCity() {
    const obs = [], W = 3600, H = 2400, M = 200, ST = 240, cols = 5, rows = 3;
    const bw = (W - 2 * M - (cols - 1) * ST) / cols, bh = (H - 2 * M - (rows - 1) * ST) / rows;
    const R = mulberry32(4242);
    for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
      const x = M + i * (bw + ST), y = M + j * (bh + ST);
      if (i === 2 && j === 1) {                                           // central plaza
        obs.push({ t: 'c', x: x + bw / 2, y: y + bh / 2, r: 110, k: 'fountain' });
        for (const [dx, dy, w, h] of [[40, 40, 110, 28], [bw - 150, 40, 110, 28], [40, bh - 68, 110, 28], [bw - 150, bh - 68, 110, 28]]) obs.push({ t: 'r', x: x + dx, y: y + dy, w, h, k: 'barrier' });
        continue;
      }
      const v = (i * 3 + j * 5) % 4, a = 110;                             // alley width between split buildings
      if (v === 0) obs.push({ t: 'r', x: x + 30, y: y + 30, w: bw - 60, h: bh - 60, k: 'bldg' });
      else if (v === 1) { const w1 = (bw - a - 60) * 0.5; obs.push({ t: 'r', x: x + 30, y: y + 30, w: w1, h: bh - 60, k: 'bldg' }, { t: 'r', x: x + 30 + w1 + a, y: y + 30, w: bw - 60 - w1 - a, h: bh - 60, k: 'bldg' }); }
      else if (v === 2) { const h1 = (bh - a - 60) * 0.5; obs.push({ t: 'r', x: x + 30, y: y + 30, w: bw - 60, h: h1, k: 'bldg' }, { t: 'r', x: x + 30, y: y + 30 + h1 + a, w: bw - 60, h: bh - 60 - h1 - a, k: 'bldg' }); }
      else {                                                              // L-shaped pair with a courtyard
        const w1 = bw * 0.55, h1 = bh * 0.5;
        obs.push({ t: 'r', x: x + 30, y: y + 30, w: w1, h: h1 - 20, k: 'bldg' }, { t: 'r', x: x + 30 + w1 + a * 0.6, y: y + 30, w: bw - 60 - w1 - a * 0.6, h: bh - 60, k: 'bldg' }, { t: 'r', x: x + 30, y: y + h1 + 70, w: w1, h: bh - h1 - 100, k: 'bldg' });
      }
    }
    // parked cars and barrels, kept to the edges of the streets so the avenues stay open
    for (let i = 0; i < 26; i++) {
      const horiz = R() < 0.5, lane = (R() * (horiz ? rows - 1 : cols - 1)) | 0, cross = (R() * (horiz ? cols : cols)) | 0;
      if (horiz) { const cy = M + (lane + 1) * bh + lane * ST + ST * (R() < 0.5 ? 0.18 : 0.82), cx = M + cross * (bw + ST) + 80 + R() * (bw - 160); if (cx < W - 200) obs.push({ t: 'r', x: cx, y: cy - 23, w: 92, h: 46, k: 'car' }); }
      else { const cx = M + (lane + 1) * bw + lane * ST + ST * (R() < 0.5 ? 0.18 : 0.82), cy = M + ((R() * rows) | 0) * (bh + ST) + 80 + R() * (bh - 160); if (cy < H - 200) obs.push({ t: 'r', x: cx - 23, y: cy, w: 46, h: 92, k: 'car' }); }
    }
    for (let i = 0; i < 18; i++) { const x = 260 + R() * (W - 520), y = 260 + R() * (H - 520); obs.push({ t: 'c', x, y, r: 17, k: 'barrel' }); }
    // drop anything that overlaps a building (cars/barrels can land inside blocks)
    const solid = obs.filter((o) => o.k === 'bldg' || o.k === 'fountain' || o.k === 'barrier');
    const hits = (o) => solid.some((b) => (b.t === 'r' ? (o.t === 'r' ? !(o.x > b.x + b.w + 14 || o.x + o.w < b.x - 14 || o.y > b.y + b.h + 14 || o.y + o.h < b.y - 14) : (Math.max(b.x - o.x, 0, o.x - b.x - b.w) ** 2 + Math.max(b.y - o.y, 0, o.y - b.y - b.h) ** 2) < (o.r + 14) ** 2)
      : (o.t === 'r' ? (Math.hypot(Math.max(o.x - b.x, 0, b.x - o.x - o.w), Math.max(o.y - b.y, 0, b.y - o.y - o.h)) < b.r + 14) : Math.hypot(o.x - b.x, o.y - b.y) < o.r + b.r + 14)));
    const keep = obs.filter((o) => o.k === 'bldg' || o.k === 'fountain' || o.k === 'barrier' || !hits(o));
    return { id: 'outbreak', name: 'Outbreak', blurb: 'A huge ruined city. Made for Infection.', w: W, h: H, theme: 'city', baseIce: false, obs: keep, zones: [], big: true };
  }

  /* ------------------------------ collision ----------------------------- */
  function circleFree(map, x, y, r) {
    if (x < r || y < r || x > map.w - r || y > map.h - r) return false;
    for (const o of map.obs) {
      if (o.t === 'r') {
        const cx = clamp(x, o.x, o.x + o.w), cy = clamp(y, o.y, o.y + o.h);
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r * r) return false;
      } else {
        const dx = x - o.x, dy = y - o.y, rr = r + o.r;
        if (dx * dx + dy * dy < rr * rr) return false;
      }
    }
    return true;
  }

  function pushOutRect(p, r, o) {
    const cx = clamp(p.x, o.x, o.x + o.w), cy = clamp(p.y, o.y, o.y + o.h);
    const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= r * r) return false;
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
      p.x = cx + nx * r; p.y = cy + ny * r;
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) { p.vx -= vn * nx; p.vy -= vn * ny; }
    } else {                                      // centre is inside the rect: exit by the shortest side
      const l = p.x - o.x, rt = o.x + o.w - p.x, t = p.y - o.y, b = o.y + o.h - p.y, m = Math.min(l, rt, t, b);
      if (m === l) { p.x = o.x - r; if (p.vx > 0) p.vx = 0; }
      else if (m === rt) { p.x = o.x + o.w + r; if (p.vx < 0) p.vx = 0; }
      else if (m === t) { p.y = o.y - r; if (p.vy > 0) p.vy = 0; }
      else { p.y = o.y + o.h + r; if (p.vy < 0) p.vy = 0; }
    }
    return true;
  }

  function collide(map, p, r) {
    let hit = false;
    for (let pass = 0; pass < 2; pass++) {
      for (const o of map.obs) {
        if (o.t === 'r') { if (pushOutRect(p, r, o)) hit = true; }
        else {
          const dx = p.x - o.x, dy = p.y - o.y, rr = r + o.r, d2 = dx * dx + dy * dy;
          if (d2 < rr * rr) {
            const d = Math.sqrt(d2) || 0.0001, nx = dx / d, ny = dy / d;
            p.x = o.x + nx * rr; p.y = o.y + ny * rr;
            const vn = p.vx * nx + p.vy * ny;
            if (vn < 0) { p.vx -= vn * nx; p.vy -= vn * ny; }
            hit = true;
          }
        }
      }
    }
    return hit;
  }

  function clampBounds(map, p, r) {
    if (p.x < r) { p.x = r; if (p.vx < 0) p.vx = 0; }
    else if (p.x > map.w - r) { p.x = map.w - r; if (p.vx > 0) p.vx = 0; }
    if (p.y < r) { p.y = r; if (p.vy < 0) p.vy = 0; }
    else if (p.y > map.h - r) { p.y = map.h - r; if (p.vy > 0) p.vy = 0; }
  }

  function inZone(z, x, y) {
    if (z.t === 'r') return x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h;
    const dx = x - z.x, dy = y - z.y;
    return dx * dx + dy * dy < z.r * z.r;
  }

  function computeSpawns(map, n) {
    const cands = [];
    for (let x = 80; x < map.w - 80; x += 40) for (let y = 80; y < map.h - 80; y += 40) {
      if (!circleFree(map, x, y, 36)) continue;
      let bad = false;
      for (const z of map.zones) {
        if (z.k === 'grip' || z.k === 'ice' || z.k === 'hide') continue;
        if (z.t === 'r' ? inZone(z, x, y) : Math.hypot(x - z.x, y - z.y) < z.r + 30) { bad = true; break; }
      }
      if (!bad) cands.push([x, y]);
    }
    const out = [cands.reduce((b, c) => (Math.hypot(c[0] - map.w * 0.2, c[1] - map.h * 0.25) < Math.hypot(b[0] - map.w * 0.2, b[1] - map.h * 0.25) ? c : b))];
    while (out.length < n) {
      let best = null, bd = -1;
      for (const c of cands) {
        let md = 1e9;
        for (const o of out) { const d = Math.hypot(c[0] - o[0], c[1] - o[1]); if (d < md) md = d; }
        if (md > bd) { bd = md; best = c; }
      }
      out.push(best);
    }
    return out;
  }

  const MAPS = [buildPark(), buildNeon(), buildFrost(), buildCandy(), buildStation(), buildReef(), buildFactory(), buildPinball()];       // the vote / rotation pool
  const BIG_MAPS = [buildCity()];                                                         // only used by Infection
  const MAP_BY_ID = {};
  for (const m of MAPS.concat(BIG_MAPS)) {
    MAP_BY_ID[m.id] = m;
    m.tele = m.zones.filter((z) => z.k === 'tele');
    m.spawns = computeSpawns(m, 16);
  }

  /* ------------------------- player simulation -------------------------- */
  // The subset of a player's state that is simulated identically client + server.
  const SIM = ['x', 'y', 'vx', 'vy', 'fx', 'fy', 'cd', 'abT', 'adx', 'ady', 'stun', 'boostT', 'tp', 'imm', 'lock', 'it', 'out', 'aux', 'bx', 'by'];
  const rnd = (v) => Math.round(v * 1000) / 1000;

  function newSim(id, c, x, y) {
    return { id, c, x, y, vx: 0, vy: 0, fx: 1, fy: 0, cd: 0, abT: 0, adx: 1, ady: 0, stun: 0, boostT: 0, tp: 0, imm: 0, lock: 0, it: 0, out: 0, aux: 0, bx: 0, by: 0 };
  }
  function packSim(p) { const a = new Array(SIM.length); for (let i = 0; i < SIM.length; i++) a[i] = rnd(+p[SIM[i]] || 0); return a; }
  function unpackSim(p, a) { for (let i = 0; i < SIM.length; i++) p[SIM[i]] = a[i]; }

  function useAbility(p, def, ctx, ev, mx, my, len, inp) {
    let dx, dy;
    const al = inp && def.id === 'avocado' ? Math.hypot(inp.ax || 0, inp.ay || 0) : 0;      // the avocado shoots where the mouse points, not where it walks
    if (al > 0.1) { dx = inp.ax / al; dy = inp.ay / al; }
    else if (len > 0.15) { dx = mx / len; dy = my / len; } else { dx = p.fx; dy = p.fy; }
    const e = { k: 'ab', n: def.fx, id: p.id, x: p.x, y: p.y, dx, dy };
    switch (def.id) {
      case 'fox': case 'frog': p.abT = def.dur; p.adx = dx; p.ady = dy; break;
      case 'ghost': case 'cat': case 'robot': p.abT = def.dur; break;
      case 'penguin': p.abT = def.dur; p.vx = dx * 420; p.vy = dy * 420; break;
      case 'star': p.abT = def.dur; p.adx = dx; p.ady = dy; break;
      case 'bird': p.boostT = 0.8; break;           // the gale itself is resolved by the server; the bird glides off in a burst
      case 'bat': p.bx = p.x; p.by = p.y; p.aux = 4; p.cd = 0.4; if (ev) ev.push(e); return;   // beacon placed; the full cooldown starts on recall / expiry
      default: break;                              // bear / octo / owl / raccoon / avocado: world effects (incl. the flying seed) resolved by the server
    }
    p.cd = def.cd;
    if (ev) ev.push(e);
  }

  function approach(p, tx, ty, step) {
    const dx = tx - p.vx, dy = ty - p.vy, d = Math.sqrt(dx * dx + dy * dy);
    if (d <= step) { p.vx = tx; p.vy = ty; } else { p.vx += (dx / d) * step; p.vy += (dy / d) * step; }
  }

  /**
   * Advance one player by one fixed 1/60 s step.
   * inp = {x,y,a} with x,y in [-1,1] (already quantized) and a = ability pressed.
   * ctx = {map, goos}. ev (optional) collects events for the caller.
   */
  function stepPlayer(p, inp, ctx, ev) {
    const map = ctx.map, def = CHARS[p.c], dt = DT, r = def.radius;
    if (p.cd > 0) p.cd = Math.max(0, p.cd - dt);
    if (p.abT > 0) p.abT = Math.max(0, p.abT - dt);
    if (p.stun > 0) p.stun = Math.max(0, p.stun - dt);
    if (p.boostT > 0) p.boostT = Math.max(0, p.boostT - dt);
    if (p.imm > 0) p.imm = Math.max(0, p.imm - dt);
    if (p.lock > 0) p.lock = Math.max(0, p.lock - dt);
    const wasBeacon = def.id === 'bat' && p.aux > 0;
    if (p.aux > 0) p.aux = Math.max(0, p.aux - dt);
    if (wasBeacon && p.aux <= 0) p.cd = def.cd;                  // beacon fizzled out unused

    let mx = inp.x, my = inp.y, len = Math.sqrt(mx * mx + my * my);
    if (len > 1) { mx /= len; my /= len; len = 1; }
    if (len > 0.15) { p.fx = mx / len; p.fy = my / len; }
    const stunned = p.stun > 0;
    if (inp.a && !stunned && !p.out) {                         // spectators (waiting or eliminated) can't use abilities
      if (def.id === 'bat' && p.aux > 0 && p.cd <= 0) {          // second press: snap back to the beacon
        if (ev) ev.push({ k: 'ab', n: 'recall', id: p.id, x: p.x, y: p.y, x1: p.bx, y1: p.by });
        p.x = p.bx; p.y = p.by; p.vx = 0; p.vy = 0; p.aux = 0; p.cd = def.cd;
      } else if (def.id === 'cat' && p.abT > 0 && def.dur - p.abT > 0.25 && p.aux <= 0) {   // pounce out of the cloak
        const ax = len > 0.15 ? mx / len : p.fx, ay = len > 0.15 ? my / len : p.fy;
        p.adx = ax; p.ady = ay; p.abT = 0; p.aux = 0.2;
        if (ev) ev.push({ k: 'ab', n: 'pounce', id: p.id, x: p.x, y: p.y, dx: ax, dy: ay });
      } else if (p.cd <= 0) useAbility(p, def, ctx, ev, mx, my, len, inp);
    }

    const id = def.id;
    const inDash = p.abT > 0 && id === 'fox';
    const inLeap = p.abT > 0 && id === 'frog';
    const inPhase = p.abT > 0 && id === 'ghost';
    const inPounce = id === 'cat' && p.aux > 0;
    const inSlide = id === 'penguin' && p.abT > 0;
    if (id === 'star' && p.abT > 0 && stunned) p.abT = 0;      // a stun uncurls Andy
    const inRoll = id === 'star' && p.abT > 0;

    let maxSp = BASE_SPEED * def.speed * (p.it ? (ctx.itBoost || IT_BOOST) : 1) * (p.sm || 1);
    if (id === 'cat' && p.abT > 0) maxSp *= 1.08;
    else if (id === 'robot' && p.abT > 0) maxSp *= p.it ? 1.3 : 0.88;
    let accel = ACCEL, fric = FRIC, inGrip = false, inIce = false, driftX = 0, driftY = 0;
    const x = p.x, y = p.y;
    for (const z of map.zones) {
      if (z.k === 'tele' || z.k === 'hide' || !inZone(z, x, y)) continue;
      if (z.k === 'mud') maxSp *= 0.55;
      else if (z.k === 'belt') { const s = z.s || 175; driftX += Math.cos(z.a) * s; driftY += Math.sin(z.a) * s; }                       // conveyor: everything on it is carried along
      else if (z.k === 'swirl') {                                                                                                  // whirlpool: carried round the centre, a little inward, faster near the middle
        const dx = x - z.x, dy = y - z.y, d = Math.sqrt(dx * dx + dy * dy) || 1, k = 0.45 + 0.55 * (1 - Math.min(1, d / z.r)), s = (z.s || 230) * k;
        driftX += (-dy / d) * z.dir * s - (dx / d) * 60 * k; driftY += (dx / d) * z.dir * s - (dy / d) * 60 * k;
      } else if (z.k === 'bump') { const dx = x - z.x, dy = y - z.y, d = Math.sqrt(dx * dx + dy * dy) || 1; p.vx += (dx / d) * 6500 * dt; p.vy += (dy / d) * 6500 * dt; }   // pinball bumper: kicked outwards
      else if (z.k === 'ice') inIce = true;
      else if (z.k === 'grip') inGrip = true;
      else if (z.k === 'boost') { p.boostT = 0.55; p.vx += Math.cos(z.a) * 3200 * dt; p.vy += Math.sin(z.a) * 3200 * dt; }
    }
    if ((map.baseIce && !inGrip) || inIce) { accel = ICE_ACCEL; fric = ICE_FRIC; }
    if (inSlide) { maxSp *= 1.45; accel = ICE_ACCEL * 1.3; fric = ICE_FRIC * 0.8; }
    const goos = ctx.goos;
    for (let i = 0; i < goos.length; i++) {
      const g = goos[i];
      if (g.o === p.id) continue;
      const dx = x - g.x, dy = y - g.y;
      if (dx * dx + dy * dy < g.r * g.r) { maxSp *= 0.45; break; }
    }
    if (p.boostT > 0) maxSp *= 1.75;

    if (inDash || inLeap || inPounce) {
      const sp = inDash ? 800 : inPounce ? 700 : 520;
      p.vx = p.adx * sp; p.vy = p.ady * sp;
    } else if (inRoll) {
      if (len > 0.15) {                                            // gentle steering: bend the roll toward the stick
        const k = Math.min(1, 3.2 * dt), tx = p.adx + (mx / len - p.adx) * k, ty = p.ady + (my / len - p.ady) * k, tl = Math.sqrt(tx * tx + ty * ty) || 1;
        p.adx = tx / tl; p.ady = ty / tl;
      }
      p.vx = p.adx * 430; p.vy = p.ady * 430;
    } else if (stunned) {
      approach(p, 0, 0, FRIC * 0.6 * dt);
    } else {
      approach(p, mx * maxSp, my * maxSp, (len > 0.01 ? accel : fric) * dt);
    }

    p.x += (p.vx + driftX) * dt; p.y += (p.vy + driftY) * dt;
    const px = p.x, py = p.y;
    if (!inLeap && !inPhase) collide(map, p, r);
    clampBounds(map, p, r);
    if (inRoll) {                                                  // ricochet: whatever pushed us back reflects that axis
      const hx = Math.abs(p.x - px) > 0.01, hy = Math.abs(p.y - py) > 0.01;
      if (hx) { p.adx = -p.adx; p.vx = -p.vx; }
      if (hy) { p.ady = -p.ady; p.vy = -p.vy; }
      if ((hx || hy) && ev) ev.push({ k: 'ab', n: 'bounce', id: p.id, x: p.x, y: p.y, dx: hx ? p.adx : 0, dy: hy ? p.ady : 0 });
    }

    // teleporters: step on a pad once, step off before it can fire again
    let onPad = false;
    for (let i = 0; i < map.tele.length; i++) {
      const z = map.tele[i], dx = p.x - z.x, dy = p.y - z.y, rr = z.r * 0.7;
      if (dx * dx + dy * dy < rr * rr) {
        onPad = true;
        if (!p.tp) {
          const to = map.zones[z.to];
          if (ev) ev.push({ k: 'ab', n: 'tele', id: p.id, x: p.x, y: p.y, x1: to.x, y1: to.y });
          p.x = to.x; p.y = to.y; p.tp = 1;
        }
        break;
      }
    }
    if (!onPad) p.tp = 0;
  }

  return {
    TICK, DT, MAX_PLAYERS, BASE_SPEED, IT_BOOST, ROUND_TIME, COUNTDOWN, RESULTS_TIME, HEAD_START, TWO_IT_AT, itCountFor, VOTE_TIME, MODES, MODE_BY_ID, POTATO_START, POTATO_MIN, POTATO_PASS_STEP, POTATO_ELIM_STEP, potatoFuse, MODE_MIN_PLAYERS, SEED_SPEED, SEED_RANGE, SEED_R, TAG_IMMUNITY, TAG_LOCK, TAG_REACH, LAG_COMP_MAX, STATE,
    COLORS, COLOR_NAMES, CUSTOM_BASE, CUSTOM_MAX, CUSTOM_TONES, cleanColor, cleanColorList, colorFor, customK, colorName, hslHex, HATS, cleanHat, CHARS, STARTERS, SHOP, SHOP_BY_ID, STARTER_ITEMS, ownsChar, MAPS, BIG_MAPS, MAP_BY_ID, SIM,
    SERVER_LIMITS, REGULAR_NAME, validateServer, validateName, validateUsername, validatePassword, cleanChat, clamp, mulberry32, circleFree, collide, clampBounds, inZone, newSim, packSim, unpackSim, stepPlayer,
  };
});
