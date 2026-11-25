'use strict';
/* A Room is one running game of tag: players (humans + bots), round state machine,
   tagging rules, abilities with world effects (stomp / goo / decoy) and snapshots. */
const T = require('../public/shared.js');
const { thinkBot, DIFFS } = require('./bots');
const { PropHunt } = require('./prophunt');

const { CHARS, DT, STATE } = T;
const IDX = {}; CHARS.forEach((c, i) => (IDX[c.id] = i));
const ghosted = (q) => (q.abT > 0 && (q.c === IDX.frog || q.c === IDX.mole)) || (q.c === IDX.god && q.z >= T.GOD_AIR);      // mid-leap or underground: can't be tagged, shoved, shot or trapped
const PIT_R = 34, PIT_TTL = 16, PIT_STUN = 1.8, PIT_SAFE = 1.4;                  // dog pits: radius, lifetime, how long a fallen player is stuck, grace after climbing out
const BOT_COUNT = 4;                   // practice rooms: you + 4 bots
const SNAP_HZ = Math.max(10, Math.min(60, +process.env.SNAP_HZ || 30));
const AFK_AFTER = 30000;   // ms of standing still before you count as afk (no win credit / survival score)
const IDLE_MOVE = 50;      // px you have to travel in a second to not count as standing still (standing still never removes you; only a lost connection does)
const SNAP_EVERY = Math.max(1, Math.round(T.TICK / SNAP_HZ));   // 60 Hz sim -> 30 Hz snapshots by default
const MIN_WIN_PLAYERS = Math.max(3, +process.env.MIN_WIN_PLAYERS || 3);   // humans needed in the main server for a win to count: always MORE than 2 (anti-farming); config can raise it, never lower it
const MIN_WIN_SCORE = 30;                                       // and the winner must have actually survived this long
const HIST = 16;                                                // position history (ticks) for lag compensation
const BOT_NAMES = ['Pixel', 'Mochi', 'Zippy', 'Nova', 'Biscuit', 'Turbo', 'Waffles', 'Comet', 'Noodle', 'Blip', 'Gizmo', 'Pickle', 'Sprout', 'Ziggle', 'Tofu', 'Jelly'];
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };

let nextPlayerId = 1;

class Room {
  constructor(code, opts = {}) {
    this.code = code;                                   // internal id only, never shown to players
    this.solo = opts.kind === 'bots';                   // practice room: one human + bots
    this.diff = DIFFS[opts.diff] ? opts.diff : 'normal';
    this.botSpeed = DIFFS[this.diff].sm;
    this.regular = opts.kind === 'public';              // the always-on Regular server
    this.testServer = opts.kind === 'test';             // the always-on Test Server: wins count (3+ players), every round votes on a test-only mode
    this.name = opts.name || (this.regular ? T.REGULAR_NAME : this.testServer ? T.TEST_NAME : 'Practice');
    this.roundTime = opts.roundTime || T.ROUND_TIME;    // seconds per game
    this.max = opts.max || T.MAX_PLAYERS;               // max players (bots use slots, humans push them out)
    this.botTarget = this.solo ? BOT_COUNT : Math.max(0, opts.bots | 0);
    this.lock = opts.lock || null;                      // { salt, hash } when the server has a password
    // game mode: a fixed one ('classic' | 'infection' | 'potato') or 'vote' (players vote on the map and the mode every round)
    const fixedMode = T.MODE_BY_ID[opts.mode] && !T.MODE_BY_ID[opts.mode].testOnly;       // test-only modes can only be voted for on the Test Server
    this.modeOpt = this.testServer ? 'vote' : fixedMode || opts.mode === 'vote' ? opts.mode : (this.regular || this.solo ? 'vote' : 'classic');
    this.customTime = !!opts.roundTime && !this.regular && !this.solo;
    this.voteTime = +process.env.VOTE_TIME || opts.voteTime || T.VOTE_TIME;
    this.pickTime = process.env.PICK_TIME !== undefined ? Math.max(0, +process.env.PICK_TIME || 0) : T.PICK_TIME;      // change-character window before each round's countdown
    this.mode = T.MODE_BY_ID[this.modeOpt] ? this.modeOpt : 'classic';
    this.vote = null; this.nextMap = null; this.elims = 0; this.passes = 0; this.tagCount = 0; this.itWant = 1;
    this.mapMode = opts.mapMode && T.MAP_BY_ID[opts.mapMode] ? opts.mapMode : 'rotate';
    this.map = this.mapMode !== 'rotate' ? T.MAP_BY_ID[this.mapMode] : T.MAPS[(Math.random() * T.MAPS.length) | 0];
    this.goos = [];
    this.ctx = { map: this.map, goos: this.goos, itBoost: T.MODE_BY_ID[this.mode].boost, hold: !!T.MODE_BY_ID[this.mode].hold, prop: !!T.MODE_BY_ID[this.mode].prop };
    this.ph = null; this.phWin = '';                    // Prop Hunt: per-round state (clutter, hide timer) and who won the last round
    this.players = new Map();
    this.decoys = [];
    this.seeds = [];                                   // avocado seeds in flight
    this.pits = [];                                    // dog pit traps
    this.events = [];
    this.state = STATE.WAIT;
    this.timer = 0; this.tl = 0; this.round = 0; this.tickN = 0;
    this.itId = 0; this.results = null; this.entId = 1;
    this.rosterDirty = false;
  }

  /* ----------------------------- membership ----------------------------- */
  humanCount() { let n = 0; for (const p of this.players.values()) if (!p.bot) n++; return n; }
  activeHumans() { let n = 0; for (const p of this.players.values()) if (!p.bot && !p.wait) n++; return n; }   // players actually in the current match
  /** Players needed to run rounds. The Test Server runs (and votes on its mode) for even a single player; everything else needs two. */
  minPlayers() { return this.testServer ? 1 : 2; }
  activeCount() { let n = 0; for (const p of this.players.values()) if (!p.wait) n++; return n; }
  aliveCount() { let n = 0; for (const p of this.players.values()) if (!p.out) n++; return n; }
  modeDef() { return T.MODE_BY_ID[this.mode]; }
  setMode(id) { this.mode = T.MODE_BY_ID[id] ? id : 'classic'; this.ctx.itBoost = this.modeDef().boost; this.ctx.hold = !!this.modeDef().hold; this.ctx.prop = !!this.modeDef().prop; }
  /** per-owner limit on lingering ability objects; Ability Hold lifts it so a long hold really does make that many clones / pits / clouds */
  cap(n) { return this.ctx.hold ? Math.max(n, T.HOLD_MAX) : n; }
  roundLen() { const m = this.modeDef(); return this.customTime || !m.time ? this.roundTime : m.time; }
  itPlayer() { const p = this.players.get(this.itId); return p && p.it ? p : null; }
  itPlayers() { const a = []; for (const p of this.players.values()) if (p.it) a.push(p); return a; }

  makePlayer(name, c, col, bot) {
    const p = T.newSim(nextPlayerId++, c, 0, 0);
    Object.assign(p, {
      name, col, bot, hat: bot && Math.random() < 0.5 ? 1 + ((Math.random() * (T.HATS.length - 1)) | 0) : 0, skin: bot && Math.random() < 0.3 ? T.SKIN_THEMES[(Math.random() * 7) | 0].id : '', ws: null, score: 0, tags: 0, queue: [], ack: 0, lastSeq: 0, lastInputAt: Date.now(), lastActiveAt: Date.now(),
      lastChat: 0, chatLog: [], lastMsg: '', rtt: 0, uid: 0, title: null, bowled: null, gone: 0,
      hx: new Float32Array(HIST), hy: new Float32Array(HIST),
      input: { x: 0, y: 0, a: 0 }, sm: bot ? this.botSpeed : 1,
    });
    return p;
  }

  resetHist(p) { p.hx.fill(p.x); p.hy.fill(p.y); }

  spawnFor(p) {
    const it = this.itPlayer(); const sp = this.map.spawns;
    let best = sp[(Math.random() * sp.length) | 0];
    if (it) { let bd = -1; for (const s of sp) { const d = Math.hypot(s[0] - it.x, s[1] - it.y) + Math.random() * 300; if (d > bd) { bd = d; best = s; } } }
    p.x = best[0]; p.y = best[1]; this.resetHist(p);
  }

  addHuman(ws, name, c, col, uid, hat, skin) {
    const p = this.makePlayer(name, c, col, false);
    p.ws = ws; p.uid = uid || 0; p.hat = hat | 0; p.skin = skin || '';
    this.spawnFor(p);
    this.holdForNextRound(p);
    this.players.set(p.id, p);
    this.emit({ k: 'join', n: p.name });
    this.rebalanceBots();
    this.rosterDirty = true;
    return p;
  }

  addBot() {
    const used = new Set([...this.players.values()].map((p) => p.name.toLowerCase()));
    const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
    const name = free.length ? free[(Math.random() * free.length) | 0] : 'Bot' + ((Math.random() * 99) | 0);
    const p = this.makePlayer(name, (Math.random() * T.PUBLIC_CHARS) | 0, Math.random() < 0.5 ? 0 : 1 + ((Math.random() * 7) | 0), true);
    this.spawnFor(p);
    this.holdForNextRound(p);
    this.players.set(p.id, p);
  }

  /** Infection and Hot Potato can't be joined once started: arrivals during the countdown or a round float around as spectators until the next vote. */
  /** A connection that stopped answering (tab/laptop closed, network dropped) can't be tagged and can't hold the tag/potato while we wait for the socket to time out. */
  markGone(p, on) {
    on = on ? 1 : 0; if (!!p.gone === !!on) return;
    p.gone = on;
    if (on && p.it && this.state === STATE.PLAY && this.mode !== 'infection' && this.mode !== 'prophunt') { p.it = 0; p.pot = 0; if (this.itId === p.id) this.itId = 0; this.reassignIt(this.mode === 'potato' ? p.from : 0); }
    this.rosterDirty = true;
  }
  holdForNextRound(p) { if (!T.classicLike(this.mode) && (this.state === STATE.COUNT || this.state === STATE.PLAY)) { p.out = 1; p.wait = 1; } }      // classic tag can be joined any time

  rebalanceBots() {
    const humans = this.humanCount();
    const want = humans > 0 ? Math.min(this.botTarget, Math.max(0, this.max - humans)) : 0;
    let bots = [...this.players.values()].filter((p) => p.bot);
    while (bots.length > want) {
      bots.sort((a, b) => (a.it ? 1 : 0) - (b.it ? 1 : 0));
      this.removePlayer(bots.shift(), true);
    }
    while (bots.length < want && this.players.size < this.max) { this.addBot(); bots = [...this.players.values()].filter((p) => p.bot); }
    this.rosterDirty = true;
  }

  removePlayer(p, silent) {
    if (!this.players.delete(p.id)) return;
    for (const g of this.goos.slice()) if (g.o === p.id) this.goos.splice(this.goos.indexOf(g), 1);
    for (const d of this.decoys.slice()) if (d.o === p.id) this.decoys.splice(this.decoys.indexOf(d), 1);
    this.seeds = this.seeds.filter((x) => x.o !== p.id);
    this.pits = this.pits.filter((x) => x.o !== p.id);
    if (!silent && !p.bot) this.emit({ k: 'leave', n: p.name });
    this.rosterDirty = true;
    let redo = false;
    if (p.it) {
      if (this.mode === 'infection') { if (this.state === STATE.PLAY && !this.itPlayers().length) redo = true; }     // the infection is never handed to someone new
      else if (this.mode === 'prophunt') { /* the tick drafts a new seeker if none are left */ }
      else this.reassignIt(this.mode === 'potato' ? p.from : 0);
    }
    if (!p.bot) { if (this.humanCount() > 0) this.rebalanceBots(); }
    if (redo) this.redoRound('The infected player left. Voting again!');
    else if (this.activeCount() < this.minPlayers() && (this.state === STATE.COUNT || this.state === STATE.PLAY)) this.toWait();
    else if (this.state === STATE.VOTE && this.players.size < this.minPlayers()) this.toWait();
  }

  /** The only infected player left: handing the infection to someone else would be unfair, so the round is scrapped and everyone goes back to the vote. */
  redoRound(msg) {
    if (this.activeCount() < this.minPlayers()) { this.toWait(); return; }
    this.emit({ k: 'redo', m: msg });
    this.beginRound();
  }

  // hand the IT role to one more random player (an IT left or went AFK); never someone who already is IT.
  // Hot Potato: `notId` is whoever passed the potato to the player who just blew up or left; it never bounces straight back to them while anyone else is alive.
  reassignIt(notId) {
    let arr = [...this.players.values()].filter((p) => !p.it && !p.out && !p.gone);
    if (this.state !== STATE.PLAY || !arr.length || this.aliveCount() < 2) { if (!this.itPlayers().length) this.itId = 0; return; }
    if (notId && arr.length > 1) arr = arr.filter((p) => p.id !== notId);
    const pool = arr.filter((p) => !p.afk), n = (pool.length ? pool : arr)[(Math.random() * (pool.length || arr.length)) | 0];
    n.it = 1; n.lock = 1; this.itId = n.id; n.from = 0;
    if (this.mode === 'potato') n.pot = T.potatoFuse();
    this.emit({ k: 'tag', a: 0, b: n.id, x: n.x, y: n.y });
  }

  /* ------------------------------ round flow ---------------------------- */
  pickMap() {
    if (this.mapMode !== 'rotate') return T.MAP_BY_ID[this.mapMode];
    const others = T.MAPS.filter((m) => m !== this.map);
    return others[(Math.random() * others.length) | 0];
  }

  resetPlayer(p, s) {
    p.x = s[0]; p.y = s[1]; p.vx = p.vy = 0; p.cd = 0; p.abT = 0; p.stun = 0; p.boostT = 0; p.tp = 0; p.imm = 0; p.lock = 0; p.it = 0;
    p.out = 0; p.wait = 0; p.noScore = 0; p.pot = 0; p.score = 0; p.tags = 0; p.aux = 0; p.z = 0; p.bm = 0; p.hold = 0; p.rep = 0; p.repT = 0; p.pitT = 0; p.pr = 0; p.pv = 0; p.mt = 0; p.tt = 0; p.swT = 0; p.hPrev = 0; p.bowled = null; p.lastActiveAt = Date.now(); this.resetHist(p);
    if (p.ai) { p.ai.tgt = -1; p.ai.wp = null; }
  }

  /** Everything between rounds starts here: a vote (regular servers, practice, "vote" custom servers) or straight into the countdown. */
  beginRound() {
    if (this.modeOpt === 'vote') {
      const choice = this.testServer || this.mapMode === 'rotate' || this.players.size >= T.MIN_SPECIAL;      // nothing to vote on (fixed arena, too few players for special modes): skip the vote. The Test Server always votes on its mode.
      if (choice) this.startVote(); else { this.setMode('classic'); this.startCountdown(); }
    } else { this.setMode(this.modeOpt); this.startCountdown(); }
  }

  startVote() {
    for (const p of this.players.values()) { p.out = 0; p.wait = 0; p.pot = 0; p.it = 0; p.vm = -1; p.vd = -1; }     // spectators and eliminated players are back in
    this.itId = 0; this.results = null;
    const maps = this.mapMode !== 'rotate' ? [this.map.id] : shuffle(T.MAPS.filter((m) => m !== this.map)).slice(0, 3).map((m) => m.id);
    const n = this.players.size;                                         // each special mode has its own minimum: Prop Hunt works with a small group, Infection and Hot Potato want a crowd
    this.vote = { maps, modes: T.MODES.filter((m) => this.testServer ? m.testOnly : !m.testOnly && (m.id === 'classic' || n >= T.modeMin(m.id))).map((m) => m.id) };      // Test Server: only its two modes; everywhere else: never the test modes
    this.state = STATE.VOTE; this.timer = this.voteTime; this.tl = this.voteTime;
    this.emit({ k: 'st', s: STATE.VOTE, vc: { m: this.vote.maps, d: this.vote.modes } });
  }

  /** p votes for candidate i of kind 'm' (map) or 'd' (mode). */
  castVote(p, kind, i) {
    if (this.state !== STATE.VOTE || !this.vote || p.bot) return;
    i |= 0; const list = kind === 'm' ? this.vote.maps : kind === 'd' ? this.vote.modes : null;
    if (!list || i < 0 || i >= list.length) return;
    if (kind === 'm') p.vm = i; else p.vd = i;
    p.lastActiveAt = Date.now();
    const humans = [...this.players.values()].filter((q) => !q.bot);
    if (humans.length && humans.every((q) => (q.vd >= 0 || this.vote.modes.length < 2) && (q.vm >= 0 || this.vote.maps.length < 2))) this.timer = Math.min(this.timer, 1.5);   // everyone has voted: don't make them wait
  }

  tally() {
    const counts = (kind) => { const n = kind === 'm' ? this.vote.maps.length : this.vote.modes.length, c = new Array(n).fill(0); for (const p of this.players.values()) { const v = kind === 'm' ? p.vm : p.vd; if (!p.bot && v >= 0 && v < n) c[v]++; } return c; };
    return { m: counts('m'), d: counts('d') };
  }

  startCountdown() {
    if (this.state === STATE.VOTE && this.vote) {
      const t = this.tally(), best = (c) => { const top = Math.max(...c), ties = c.map((v, i) => (v === top ? i : -1)).filter((i) => i >= 0); return ties[(Math.random() * ties.length) | 0]; };
      const anyMode = t.d.some((v) => v > 0);
      this.setMode(this.vote.modes[anyMode || !this.solo ? best(t.d) : 0]);       // nobody voted in practice: classic; elsewhere a random pick
      this.nextMap = T.MAP_BY_ID[this.vote.maps[best(t.m)]];
    }
    if (!T.classicLike(this.mode) && this.players.size < T.modeMin(this.mode) && !this.forceMode) this.setMode('classic');      // too few players (or people left during the vote)
    let m = this.nextMap || (this.round > 0 && this.modeOpt !== 'vote' ? this.pickMap() : this.map);
    const need = this.modeDef().map;
    if (need) m = T.MAP_BY_ID[need];                    // Infection always plays on the big map
    else if (m.big) m = this.mapMode !== 'rotate' ? T.MAP_BY_ID[this.mapMode] : T.MAPS[(Math.random() * T.MAPS.length) | 0];
    this.nextMap = null; this.vote = null;
    if (m !== this.map) { this.map = m; this.ctx.map = m; this.itFields = null; for (const p of this.players.values()) p.ai = null; }
    this.round++;
    this.goos.length = 0; this.decoys.length = 0; this.seeds.length = 0; this.pits.length = 0; this.results = null; this.elims = 0; this.passes = 0; this.tagCount = 0;
    const sp = shuffle(this.map.spawns.slice()); let i = 0;
    for (const p of this.players.values()) this.resetPlayer(p, sp[i++ % sp.length]);
    this.itId = 0; this.state = STATE.COUNT; this.timer = T.COUNTDOWN + this.pickTime; this.tl = this.timer;
    if (this.mode === 'prophunt') PropHunt.reset(this); else { this.ph = null; this.phWin = ''; }
    this.emit({ k: 'st', s: STATE.COUNT, m: this.map.id, rd: this.round, md: this.mode });
  }

  /** Tagger Proximity: points per second for `p`, from how close they are to the nearest active tagger. Ghosted / freshly-tagged players only get the base rate. */
  proxRate(p, hunters) {
    if (!hunters.length || p.imm > 0 || ghosted(p)) return T.PROX_MIN;
    let gap = Infinity;
    for (const h of hunters) gap = Math.min(gap, Math.hypot(h.x - p.x, h.y - p.y) - (CHARS[h.c].radius + CHARS[p.c].radius + T.TAG_REACH));
    return T.proxRate(Math.max(0, gap));
  }

  /** The change-character window: the first part of the countdown (before the 4-3-2-1), after the vote has closed. */
  canPick() { return this.state === STATE.COUNT && this.timer > T.COUNTDOWN + 0.05; }

  /** Swap a player's character, colour and skin during the window. Their ability state starts fresh. */
  setLook(p, ci, col, skin) {
    if (!this.canPick() || p.bot || !CHARS[ci]) return false;
    p.c = ci; p.col = col; p.skin = skin || '';
    p.cd = 0; p.abT = 0; p.aux = 0; p.bx = 0; p.by = 0; p.z = 0; p.bm = 0; p.hold = 0; p.rep = 0; p.repT = 0; p.pitT = 0; p.stun = 0; p.boostT = 0; p.tp = 0; p.imm = 0; p.lock = 0; p.vx = p.vy = 0; p.bowled = null;
    this.rosterDirty = true; return true;
  }

  startPlay() {
    if (this.mode === 'prophunt') {
      const seekers = PropHunt.start(this);
      this.itWant = seekers.length; this.itId = seekers[0].id;
      this.state = STATE.PLAY; this.tl = this.roundLen();
      this.emit({ k: 'st', s: STATE.PLAY, it: seekers[0].id, its: seekers.map((p) => p.id), md: this.mode });
      this.rosterDirty = true;
      return;
    }
    const arr = shuffle([...this.players.values()].filter((p) => !p.out));
    this.itWant = T.classicLike(this.mode) ? T.itCountFor(arr.length) : 1;      // 7+ players: two taggers in classic tag; Infection and Hot Potato always start with exactly one
    const its = arr.slice(0, this.itWant);
    const fuse = T.potatoFuse();
    for (const it of its) { it.from = 0; it.it = 1; it.stun = T.HEAD_START; if (this.mode === 'potato') it.pot = fuse + T.HEAD_START; }
    this.itId = its[0].id;
    this.state = STATE.PLAY; this.tl = this.roundLen();
    this.emit({ k: 'st', s: STATE.PLAY, it: its[0].id, its: its.map((p) => p.id), md: this.mode });
  }

  /** `noWins`: staff ended the match early, so nobody is paid for it (and no last-standing bonus). */
  endRound(noWins) {
    for (const p of this.players.values()) if (p.noScore) p.score = 0;                 // staff who jumped in with G never show or win points
    if (this.mode === 'prophunt') this.phWin = PropHunt.hidersLeft(this) > 0 ? 'h' : 's';      // hiders win if any survived the clock
    if (!noWins && !T.classicLike(this.mode)) for (const p of this.players.values()) if (!p.out && !p.it && !p.wait && !p.noScore) p.score += 10;      // last ones standing get a bonus (and break the tie with whoever went out just before)
    const inMatch = [...this.players.values()].filter((p) => !p.wait);
    const list = inMatch.map((p) => ({ id: p.id, s: p.score, t: p.tags })).map((r) => ({ ...r, tie: Math.random() })).sort((a, b) => b.s - a.s || b.t - a.t || a.tie - b.tie);   // display ord
    this.results = list.map((r) => [r.id, Math.floor(r.s), r.t]);
    // wins are only paid out in the main (public) server, with at least MIN_WIN_PLAYERS real players, to registered accounts that were actually playing. Private/custom servers and practice never pay wins (anti-farming).
    if (!noWins && this.onWin && (this.regular || this.testServer) && !this.solo && list.length && this.activeHumans() >= MIN_WIN_PLAYERS) {
      const best = Math.floor(list[0].s);                // the displayed top score: everyone who finished on it shares the win
      if (list[0].s >= MIN_WIN_SCORE) for (const r of list) {
        if (Math.floor(r.s) !== best) break;
        const w = this.players.get(r.id);
        if (w && w.uid && !w.bot && !w.afk && !w.noScore) this.onWin(w);
      }
    }
    for (const p of this.players.values()) { p.it = 0; p.pot = 0; p.pr = 0; }
    this.itId = 0; this.state = STATE.RESULTS; this.timer = T.RESULTS_TIME; this.tl = T.RESULTS_TIME;
    this.emit({ k: 'st', s: STATE.RESULTS, md: this.mode });
  }

  /** Staff: restart the round right now in `id`, even a mode that normally needs more players. Returns '' or the reason it can't. The room's own rule (vote / fixed mode) applies again from the next round. */
  staffSetMode(id) {
    if (!T.MODE_BY_ID[id]) return 'Unknown game mode.';
    if (this.state === STATE.WAIT || this.activeCount() < this.minPlayers()) return 'There are not enough players in that room.';
    this.emit({ k: 'redo', m: `Staff switched the game to ${T.MODE_BY_ID[id].name}. Fresh round!` });
    this.vote = null; this.nextMap = null; this.setMode(id); this.forceMode = true;
    try { this.startCountdown(); } finally { this.forceMode = false; }
    return '';
  }

  /** Staff pressing G while out or waiting for the next round: jump into the running round as a normal player, but with no points: the score is held at 0 and they can never win it. Returns true when they joined. */
  staffJoin(p) {
    if (!p || !p.staff || p.bot || p.gone || !(p.out || p.wait) || (this.state !== STATE.PLAY && this.state !== STATE.COUNT)) return false;
    const sp = shuffle(this.map.spawns.slice())[0];
    this.resetPlayer(p, sp); p.noScore = 1; p.imm = T.TAG_IMMUNITY;           // a moment of safety so they are not tagged the instant they land
    if (this.mode === 'prophunt' && this.state === STATE.PLAY) PropHunt.makeHider(p);      // in Prop Hunt they hide like everyone else
    this.rosterDirty = true; return true;
  }

  /** Staff: end the running match now (scores show, but no wins are paid). A round still in its countdown is dropped and a new one starts. */
  staffEnd() {
    if (this.state === STATE.PLAY) { this.emit({ k: 'redo', m: 'Staff ended the match. No wins for this one.' }); this.endRound(true); return ''; }
    if (this.state === STATE.COUNT) { this.emit({ k: 'redo', m: 'Staff ended the round before it started.' }); this.beginRound(); return ''; }
    return 'There is no match running in that room.';
  }

  toWait() {
    for (const p of this.players.values()) { p.it = 0; p.pot = 0; p.out = 0; p.wait = 0; p.pr = 0; }
    this.ph = null; this.phWin = '';
    this.itId = 0; this.state = STATE.WAIT; this.tl = 0; this.results = null; this.vote = null; this.nextMap = null;
    this.emit({ k: 'st', s: STATE.WAIT });
  }

  /** IT touched `victim`. Classic: the role moves. Infection: the victim joins the infected. Potato: the potato moves and its fuse restarts. */
  tag(it, victim) {
    if (this.mode === 'prophunt') { PropHunt.find(this, it, victim); return; }          // a seed that hits a hider counts as finding them
    this.tagCount++; it.tags++;
    if (this.mode === 'points') it.score += T.TAG_POINTS;                    // Tagger Points: a tag is worth 10
    if (this.mode === 'infection') {
      victim.it = 1; victim.lock = 0.9; victim.stun = 0; victim.imm = 0;
      this.itId = victim.id;
      this.emit({ k: 'tag', a: it.id, b: victim.id, x: victim.x, y: victim.y, z: 1 });
      return;
    }
    it.it = 0; it.pot = 0; it.imm = T.TAG_IMMUNITY;
    victim.it = 1; victim.lock = T.TAG_LOCK; victim.stun = 0;
    if (this.mode === 'potato') { this.passes++; victim.pot = T.potatoFuse(); victim.from = it.id; }
    this.itId = victim.id;
    this.emit({ k: 'tag', a: it.id, b: victim.id, x: victim.x, y: victim.y, ...(this.mode === 'points' ? { pts: T.TAG_POINTS } : null) });
  }

  /** Hot Potato: the fuse ran out. The holder is eliminated (becomes a spectator ghost) and the potato lands on a random survivor. */
  explode(p) {
    this.emit({ k: 'boom', id: p.id, x: r1(p.x), y: r1(p.y) });
    p.it = 0; p.pot = 0; p.out = 1; p.vx = p.vy = 0; this.elims++;
    const want = Math.min(this.itWant, Math.max(1, this.aliveCount() - 1));
    for (let k = 0; k < 3 && this.aliveCount() > 1 && this.itPlayers().length < want; k++) this.reassignIt(p.from);
    if (this.itPlayers().length) this.itId = this.itPlayers()[0].id;
  }

  /* ------------------------------- inputs ------------------------------- */
  queueInputs(p, arr) {
    const now = Date.now(); p.lastInputAt = now;
    for (const e of arr) {
      if (!Array.isArray(e) || e.length < 4) continue;
      const s = e[0] | 0;
      if (s <= p.lastSeq) continue;
      p.lastSeq = s;
      let x = +e[1], y = +e[2];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      x = Math.round(T.clamp(x, -1, 1) * 100) / 100; y = Math.round(T.clamp(y, -1, 1) * 100) / 100;
      const inp = { s, x, y, a: e[3] ? 1 : 0 };
      if (e.length >= 7) { let h = e[6] | 0, keep = 0; if (p.c === IDX.god && p.staff) keep |= 3; if (this.ctx.hold) keep |= 4; if (this.ctx.prop) keep |= 56; h &= keep; if (h) inp.h = h; }      // held inputs: 1 = ascend, 2 = beam (God only, staff), 4 = ability held (Ability Hold), 8 = swing / freeze, 16 = taunt, 32 = change prop (Prop Hunt)
      if ((e[3] || (e.length >= 7 && (e[6] & 4))) && e.length >= 6) { const ax = +e[4], ay = +e[5]; if (Number.isFinite(ax) && Number.isFinite(ay)) { const L = Math.hypot(ax, ay); if (L > 0.05) { inp.ax = Math.round(ax / L * 100) / 100; inp.ay = Math.round(ay / L * 100) / 100; } } }
      p.queue.push(inp);
      if (e[3]) p.lastActiveAt = now;           // using an ability counts as playing; plain movement is judged by how far you actually got (see the idle check in tick)
    }
    if (p.queue.length > 24) p.queue.splice(0, p.queue.length - 8);
  }

  /** Player chat: sanitised, rate limited (1 per 0.6 s, 5 per 8 s) and broadcast to the room as an event. */
  chat(p, raw) {
    const now = Date.now(); p.typeAt = 0;
    if (now - p.lastChat < 600) return;
    p.chatLog = p.chatLog.filter((t) => now - t < 8000);
    if (p.chatLog.length >= 5) return;
    const m = T.cleanChat(raw);
    if (!m || (m === p.lastMsg && now - p.lastChat < 6000)) return;
    p.lastChat = now; p.lastMsg = m; p.chatLog.push(now); p.lastActiveAt = now;
    this.emit({ k: 'chat', id: p.id, n: p.name, m, a: p.uid ? 1 : 0, ...(p.title ? { tt: p.title.t, tc: p.title.c } : {}) });
  }

  emit(e) { this.events.push(e); }

  /* ------------------------------- the tick ----------------------------- */
  runStep(p, inp) {
    let i = inp;
    if (this.state === STATE.COUNT || (this.ctx.prop && this.ph && this.ph.hide > 0 && p.it)) i = { s: inp.s, x: 0, y: 0, a: 0, h: 0 };      // the countdown, and the seekers' blindfold while the hiders scatter
    else if (this.ctx.prop && !p.bot) PropHunt.input(this, p, inp);
    const ev = [], wasLeap = p.c === IDX.frog && p.abT > 0;
    T.stepPlayer(p, i, this.ctx, ev);
    if (!p.bot) p.ack = inp.s;
    for (const e of ev) this.abilityEvent(p, e);
    if (wasLeap && p.abT <= 0) {                        // frog landing: sticky splash that slows everyone but the frog
      const mine = this.goos.filter((g) => g.o === p.id && g.splash);
      if (mine.length >= 2) this.goos.splice(this.goos.indexOf(mine[0]), 1);
      this.goos.push({ id: this.entId++, x: p.x, y: p.y, r: 54, o: p.id, ttl: 2.2, splash: 1 });
      this.emit({ k: 'ab', n: 'splash', id: p.id, x: r1(p.x), y: r1(p.y), dx: 0, dy: 0 });
    }
  }

  abilityEvent(p, e) {
    if (e.n === 'stomp') {
      const R = 175;
      for (const q of this.players.values()) {
        if (q === p || (q.out || q.gone)) continue;
        if (ghosted(q)) continue;
        let dx = q.x - p.x, dy = q.y - p.y; const d = Math.hypot(dx, dy);
        if (d > R) continue;
        if (d < 1) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
        const f = 1 - d / R * 0.4;
        q.vx += dx * 760 * f; q.vy += dy * 760 * f;
        q.stun = Math.max(q.stun, 0.5);
        if (q.c === IDX.fox) q.abT = 0;
      }
      for (const dd of this.decoys.slice()) if (Math.hypot(dd.x - p.x, dd.y - p.y) < R) this.popDecoy(dd);
    } else if (e.n === 'gust') {
      const R = 340;                                          // a wide, stun-free blast: it buys distance, not a free tag
      for (const q of this.players.values()) {
        if (q === p || (q.out || q.gone)) continue;
        if (ghosted(q)) continue;
        let dx = q.x - p.x, dy = q.y - p.y; const d = Math.hypot(dx, dy);
        if (d > R) continue;
        if (d < 1) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
        const f = 1 - d / R * 0.45;
        q.vx += dx * 860 * f; q.vy += dy * 860 * f;
        if (q.c === IDX.fox) q.abT = 0;
      }
      for (const dd of this.decoys.slice()) if (Math.hypot(dd.x - p.x, dd.y - p.y) < R) this.popDecoy(dd);
    } else if (e.n === 'seed') {
      const L = Math.hypot(e.dx, e.dy) || 1, ux = e.dx / L, uy = e.dy / L, off = CHARS[p.c].radius + 6;
      if (this.seeds.filter((x) => x.o === p.id).length >= this.cap(2)) return;
      this.seeds.push({ id: this.entId++, o: p.id, x: p.x + ux * off, y: p.y + uy * off, vx: ux * T.SEED_SPEED, vy: uy * T.SEED_SPEED, it: p.it ? 1 : 0, ttl: T.SEED_RANGE / T.SEED_SPEED });
    } else if (e.n === 'pit') {
      const mine = this.pits.filter((x) => x.o === p.id);
      if (mine.length >= this.cap(3)) this.pits.splice(this.pits.indexOf(mine[0]), 1);
      this.pits.push({ id: this.entId++, x: p.x, y: p.y + 6, r: PIT_R, o: p.id, ttl: PIT_TTL });
    } else if (e.n === 'stink') {
      const mine = this.goos.filter((g) => g.o === p.id && g.s === 2);
      if (mine.length >= this.cap(2)) this.goos.splice(this.goos.indexOf(mine[0]), 1);
      this.goos.push({ id: this.entId++, x: p.x, y: p.y, r: 88, o: p.id, ttl: 3.2, s: 2 });
    } else if (e.n === 'kick') {                              // both hind legs: a wide cone BEHIND the direction of travel
      const R = 150, bx = -e.dx, by = -e.dy;
      for (const q of this.players.values()) {
        if (q === p || (q.out || q.gone) || ghosted(q)) continue;
        let dx = q.x - p.x, dy = q.y - p.y; const d = Math.hypot(dx, dy);
        if (d > R + CHARS[q.c].radius) continue;
        if (d < 1) { dx = bx; dy = by; } else { dx /= d; dy /= d; }
        if (dx * bx + dy * by < 0.42) continue;                // outside the ~130 degree cone
        if (q.c === IDX.robot && q.abT > 0) { q.abT = 0; p.stun = Math.max(p.stun, 0.8); this.emit({ k: 'ab', n: 'shieldhit', id: q.id, x: r1(q.x), y: r1(q.y), dx: r2(-dx), dy: r2(-dy) }); continue; }
        q.vx += dx * 700; q.vy += dy * 700;
        q.stun = Math.max(q.stun, 0.8);
        if (q.c === IDX.fox) q.abT = 0;
      }
      for (const dd of this.decoys.slice()) { const dx = dd.x - p.x, dy = dd.y - p.y, d = Math.hypot(dx, dy) || 1; if (d < R && (dx * bx + dy * by) / d > 0.42) this.popDecoy(dd); }
    } else if (e.n === 'surface') {                           // mole pops out of the ground: dirt everywhere dazes everyone close
      const R = 100;
      for (const q of this.players.values()) {
        if (q === p || (q.out || q.gone) || ghosted(q)) continue;
        let dx = q.x - p.x, dy = q.y - p.y; const d = Math.hypot(dx, dy);
        if (d > R) continue;
        if (d < 1) { dx = 1; dy = 0; } else { dx /= d; dy /= d; }
        q.vx += dx * 260; q.vy += dy * 260;
        q.stun = Math.max(q.stun, 0.65);
        if (q.c === IDX.fox) q.abT = 0;
      }
    } else if (e.n === 'goo') {
      const mine = this.goos.filter((g) => g.o === p.id);
      if (mine.length >= this.cap(3)) this.goos.splice(this.goos.indexOf(mine[0]), 1);
      this.goos.push({ id: this.entId++, x: p.x, y: p.y, r: 80, o: p.id, ttl: 8 });
    } else if (e.n === 'decoy') {
      const mine = this.decoys.filter((d) => d.o === p.id);
      if (mine.length >= this.cap(2)) this.decoys.splice(this.decoys.indexOf(mine[0]), 1);
      if (this.ctx.hold && p.rax === 0 && p.ray === 0) { const a = ((p.rep % 5) - 2) * 0.3, ca = Math.cos(a), sa = Math.sin(a), dx = e.dx * ca - e.dy * sa; e.dy = e.dx * sa + e.dy * ca; e.dx = dx; }       // a fan of clones, not a stack
      this.decoys.push({ id: this.entId++, x: p.x + e.dx * 30, y: p.y + e.dy * 30, vx: e.dx * 235, vy: e.dy * 235, c: p.c, k: p.col, o: p.id, ttl: 5.5 });
    }
    else if (e.n === 'swap') {
      let best = null, bd = 380;
      for (const q of this.players.values()) {
        if (q === p || (ghosted(q))) continue;
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d < bd) { bd = d; best = q; }
      }
      if (!best) { p.cd = 1.2; return; }                      // nobody in range: no cooldown wasted
      const ox = p.x, oy = p.y;
      p.x = best.x; p.y = best.y; best.x = ox; best.y = oy;
      p.tp = 1; best.tp = 1;
      best.stun = Math.max(best.stun, 0.55);
      this.resetHist(p); this.resetHist(best);
      this.emit({ k: 'ab', n: 'swap', id: p.id, x: r1(ox), y: r1(oy), x1: r1(p.x), y1: r1(p.y), dx: 0, dy: 0 });
      return;
    }
    this.emit({ k: 'ab', n: e.n, id: p.id, x: r1(e.x), y: r1(e.y), dx: r2(e.dx || 0), dy: r2(e.dy || 0), x1: e.x1 !== undefined ? r1(e.x1) : undefined, y1: e.y1 !== undefined ? r1(e.y1) : undefined });
  }

  /* dog pits: anyone on the other side of the tag (a runner for an IT dog, the IT for a runner dog) who steps into one drops in and is stuck for a moment. */
  stepPits() {
    for (const q of this.players.values()) if (q.pitT > 0) q.pitT -= DT;
    for (let i = this.pits.length - 1; i >= 0; i--) {
      const pit = this.pits[i], o = this.players.get(pit.o);
      pit.ttl -= DT;
      if (pit.ttl <= 0 || !o || this.state !== STATE.PLAY) { this.pits.splice(i, 1); continue; }
      for (const q of this.players.values()) {
        if (q === o || q.out || q.gone || q.pitT > 0 || ghosted(q) || q.it === o.it || (q.c === IDX.ghost && q.abT > 0)) continue;
        const rr = pit.r + CHARS[q.c].radius * 0.2, dx = q.x - pit.x, dy = q.y - pit.y;
        if (dx * dx + dy * dy >= rr * rr) continue;
        q.stun = Math.max(q.stun, PIT_STUN); q.pitT = PIT_STUN + PIT_SAFE; q.vx = q.vy = 0; q.x = pit.x; q.y = pit.y - 6;
        if (q.c === IDX.star || q.c === IDX.fox) q.abT = 0;
        this.resetHist(q);
        this.emit({ k: 'ab', n: 'pitfall', id: q.id, x: r1(pit.x), y: r1(pit.y), dx: 0, dy: 0, o: o.id });
        this.pits.splice(i, 1);
        break;
      }
    }
  }

  /* avocado seeds: fly straight, stop at walls. From an IT avocado a hit tags the runner; from a runner it stuns the IT. */
  stepSeeds() {
    for (let i = this.seeds.length - 1; i >= 0; i--) {
      const s = this.seeds[i], o = this.players.get(s.o);
      s.ttl -= DT; s.x += s.vx * DT; s.y += s.vy * DT;
      let dead = s.ttl <= 0 || !o || this.state !== STATE.PLAY;
      if (!dead && !T.circleFree(this.map, s.x, s.y, T.SEED_R * 0.6)) { dead = true; this.emit({ k: 'ab', n: 'seedpop', id: s.o, x: r1(s.x - s.vx * DT), y: r1(s.y - s.vy * DT), dx: 0, dy: 0 }); }
      if (!dead) for (const d of this.decoys.slice()) if (d.o !== s.o && Math.hypot(d.x - s.x, d.y - s.y) < 22 + T.SEED_R) { this.popDecoy(d); dead = true; break; }
      if (!dead) for (const q of this.players.values()) {
        if (q === o || (q.out || q.gone) || (ghosted(q))) continue;
        const rr = CHARS[q.c].radius + T.SEED_R, dx = q.x - s.x, dy = q.y - s.y;
        if (dx * dx + dy * dy >= rr * rr) continue;
        if (q.c === IDX.robot && q.abT > 0) {                  // shield eats the seed
          q.abT = 0; this.emit({ k: 'ab', n: 'shieldhit', id: q.id, x: r1(q.x), y: r1(q.y), dx: r2(s.vx / T.SEED_SPEED), dy: r2(s.vy / T.SEED_SPEED) });
          dead = true; break;
        }
        if (s.it) {
          if (q.it || q.imm > 0) continue;                      // seeds fly through other taggers and freshly tagged runners
          if (!o.it) { dead = true; break; }                  // the avocado lost its IT status while the seed was flying
          this.tag(o, q); dead = true; break;
        }
        if (q.it) {                                            // a runner's seed: stun and shove the tagger
          q.stun = Math.max(q.stun, 1.3); q.vx += s.vx * 0.45; q.vy += s.vy * 0.45;
          if (q.c === IDX.fox) q.abT = 0;
          this.emit({ k: 'ab', n: 'seedhit', id: o.id, x: r1(q.x), y: r1(q.y), dx: r2(s.vx / T.SEED_SPEED), dy: r2(s.vy / T.SEED_SPEED) });
          dead = true; break;
        }
      }
      if (dead) this.seeds.splice(i, 1);
    }
  }

  /** God's beam of light: a horizontal bar from God to the edge of the arena, through walls and everything else. Anyone in it is stunned (and any ability cancelled) for as long as it touches them: no immunity, shield, leap or tunnel helps. */
  stepBeams() {
    for (const g of this.players.values()) {
      if (g.c !== IDX.god || !g.bm || g.out || g.gone) continue;
      const dir = g.fx >= 0 ? 1 : -1, hw = T.GOD_BEAM_W / 2;
      for (const q of this.players.values()) {
        if (q === g || q.out || q.gone || q.c === IDX.god) continue;
        const r = CHARS[q.c].radius;
        if ((q.x - g.x) * dir < -r || Math.abs(q.y - g.y) > hw + r) continue;
        if (q.stun <= 0) this.emit({ k: 'ab', n: 'beamhit', id: q.id, x: r1(q.x), y: r1(q.y), dx: dir, dy: 0 });
        q.stun = Math.max(q.stun, 0.45);
        q.abT = 0; q.pitT = 0;
      }
    }
  }

  /** God's second move: jump next to any other player. Chosen from a menu on the client; checked here (staff only, off cooldown, not stunned). */
  godTeleport(p, toId) {
    if (!p.staff || p.c !== IDX.god || p.out || p.gone || p.stun > 0 || p.cd > 0 || this.state === STATE.COUNT) return false;
    const q = this.players.get(toId | 0);
    if (!q || q === p || q.gone) return false;
    const r = CHARS[p.c].radius, ox = p.x, oy = p.y;
    let nx = q.x, ny = q.y;
    for (let k = 0; k < 12; k++) {                                   // land beside them, on free ground
      const a = (k / 12) * Math.PI * 2 + 0.6, tx = q.x + Math.cos(a) * 58, ty = q.y + Math.sin(a) * 58;
      if (T.circleFree(this.map, tx, ty, r)) { nx = tx; ny = ty; break; }
    }
    p.x = nx; p.y = ny; p.vx = p.vy = 0; p.cd = T.GOD_TP_CD; this.resetHist(p);
    this.emit({ k: 'ab', n: 'godtp', id: p.id, x: r1(ox), y: r1(oy), x1: r1(nx), y1: r1(ny), dx: 0, dy: 0 });
    return true;
  }

  popDecoy(d) {
    const i = this.decoys.indexOf(d); if (i < 0) return;
    this.decoys.splice(i, 1);
    this.emit({ k: 'pop', x: r1(d.x), y: r1(d.y), c: d.c });
  }

  tick() {
    this.tickN++;
    // ---- state timers
    if (this.state === STATE.COUNT) { this.timer -= DT; this.tl = Math.max(0, this.timer); if (this.timer <= 0) this.startPlay(); }
    else if (this.state === STATE.PLAY) { this.tl -= DT; if (this.tl <= 0) this.endRound(); }
    else if (this.state === STATE.RESULTS) {
      this.timer -= DT; this.tl = Math.max(0, this.timer);
      if (this.timer <= 0) { if (this.players.size >= this.minPlayers()) this.beginRound(); else this.toWait(); }
    }
    else if (this.state === STATE.VOTE) {
      this.timer -= DT; this.tl = Math.max(0, this.timer);
      if (this.timer <= 0) { if (this.players.size >= this.minPlayers()) this.startCountdown(); else this.toWait(); }
    }
    else if (this.state === STATE.WAIT && this.players.size >= this.minPlayers()) this.beginRound();

    // ---- players
    for (const p of this.players.values()) {
      if (p.bot) {
        thinkBot(this, p);
        this.runStep(p, p.input); p.input.a = 0;
        continue;
      }
      const ql = p.queue.length;
      if (!ql) continue;
      const n = ql > 8 ? 3 : ql > 4 ? 2 : 1;
      for (let k = 0; k < n && p.queue.length; k++) this.runStep(p, p.queue.shift());
    }

    // ---- position history (lag compensation) + penguin bowling
    const hi = this.tickN % HIST;
    for (const p of this.players.values()) { p.hx[hi] = p.x; p.hy[hi] = p.y; }
    for (const p of this.players.values()) {
      if (p.c !== IDX.penguin) continue;
      if (p.abT <= 0) { p.bowled = null; continue; }
      if (Math.hypot(p.vx, p.vy) < 170) continue;
      const rp = CHARS[p.c].radius;
      for (const q of this.players.values()) {
        if (q === p || (q.out || q.gone) || (ghosted(q)) || (p.bowled && p.bowled.has(q.id))) continue;
        const dx = q.x - p.x, dy = q.y - p.y, rr = rp + CHARS[q.c].radius + 6;
        if (dx * dx + dy * dy >= rr * rr) continue;
        const d = Math.hypot(dx, dy) || 1;
        (p.bowled || (p.bowled = new Set())).add(q.id);
        q.stun = Math.max(q.stun, 0.6); q.vx += (dx / d) * 520; q.vy += (dy / d) * 520;
        if (q.c === IDX.fox) q.abT = 0;
        this.emit({ k: 'ab', n: 'bowl', id: p.id, x: r1(q.x), y: r1(q.y), dx: r2(dx / d), dy: r2(dy / d) });
      }
    }

    // ---- decoys & goos
    for (const d of this.decoys.slice()) {
      d.ttl -= DT;
      if (d.ttl <= 0) { this.popDecoy(d); continue; }
      const sim = { x: d.x + d.vx * DT, y: d.y + d.vy * DT, vx: d.vx, vy: d.vy };
      const ovx = sim.vx, ovy = sim.vy;
      const hit = T.collide(this.map, sim, 16);
      T.clampBounds(this.map, sim, 16);
      if (hit || sim.vx !== ovx || sim.vy !== ovy) {
        if (Math.abs(sim.vx - ovx) > 1e-3) sim.vx = -ovx; else sim.vx = ovx;
        if (Math.abs(sim.vy - ovy) > 1e-3) sim.vy = -ovy; else sim.vy = ovy;
      }
      d.x = sim.x; d.y = sim.y; d.vx = sim.vx; d.vy = sim.vy;
    }
    for (let i = this.goos.length - 1; i >= 0; i--) { this.goos[i].ttl -= DT; if (this.goos[i].ttl <= 0) this.goos.splice(i, 1); }

    this.stepSeeds();
    this.stepPits();
    this.stepBeams();

    // ---- tagging & scoring
    if (this.state === STATE.PLAY && this.mode === 'prophunt') {
      const ph = this.ph;
      if (ph && ph.hide <= 0) for (const p of this.players.values()) if (!p.out && !p.gone && !p.afk && !p.it && !p.wait) p.score += DT;      // a point for every second a hider stays hidden
      for (const p of this.players.values()) if (p.noScore) p.score = 0;
      PropHunt.tick(this);
    } else if (this.state === STATE.PLAY) {
      const potato = this.mode === 'potato', infection = this.mode === 'infection';
      const prox = this.mode === 'proximity', hunters = prox ? this.itPlayers().filter((h) => h.stun <= 0 && h.lock <= 0 && !h.out && !h.gone) : null;      // proximity only counts a tagger who can actually tag right now (no farming a stunned one)
      for (const p of this.players.values()) if (!p.out && !p.gone && !p.afk && (potato || !p.it)) p.score += DT * (prox && !p.it ? this.proxRate(p, hunters) : 1);          // time survived (Tagger Proximity: faster the closer you are to IT)
      for (const p of this.players.values()) if (p.noScore) p.score = 0;                                       // staff who jumped in with G never earn points (from time, tags or anything else)
      for (const it of this.itPlayers()) {
        if (!it.it || it.out || it.gone) continue;                       // already handed over by an earlier tag this tick
        if (potato) { it.pot -= DT; if (it.pot <= 0) { this.explode(it); continue; } }
        const ri = CHARS[it.c].radius;
        for (const d of this.decoys.slice()) {
          if (d.o !== it.id && Math.hypot(d.x - it.x, d.y - it.y) < ri + 16) { this.popDecoy(d); it.stun = Math.max(it.stun, 1.0); }
        }
        if (it.stun <= 0 && it.lock <= 0 && !(it.c === IDX.mole && it.abT > 0) && !(it.c === IDX.god && it.z >= T.GOD_AIR)) {       // a mole can't tag from underground
          // Generous reach (TAG_REACH) plus a little rewind for laggy taggers: they saw their target a moment in the past,
          // so a tag also counts if the target WAS in reach shortly before. Capped at LAG_COMP_MAX so dodging still works.
          const comp = it.bot ? 0 : T.clamp((it.rtt + 90) / 1000 * 0.8, 0, T.LAG_COMP_MAX), kmax = Math.min(HIST - 2, Math.round(comp * T.TICK));
          for (const q of this.players.values()) {
            if (q === it || q.it || (q.out || q.gone) || q.imm > 0 || (ghosted(q))) continue;
            const rr = ri + CHARS[q.c].radius + T.TAG_REACH;
            let dx = q.x - it.x, dy = q.y - it.y, hit = dx * dx + dy * dy < rr * rr;
            if (!hit && kmax >= 2) {
              for (const k of [kmax >> 1, kmax]) {
                const j = (this.tickN - k + HIST * 4) % HIST, hx = q.hx[j] - it.x, hy = q.hy[j] - it.y;
                if (hx * hx + hy * hy < rr * rr) { hit = true; dx = hx; dy = hy; break; }
              }
            }
            if (!hit) continue;
            if (q.c === IDX.robot && q.abT > 0) {            // shield: block the tag, stun + shove the tagger, shield pops
              const d = Math.sqrt(dx * dx + dy * dy) || 1;
              q.abT = 0; it.stun = Math.max(it.stun, 0.8); it.vx = (-dx / d) * 520; it.vy = (-dy / d) * 520;
              this.emit({ k: 'ab', n: 'shieldhit', id: q.id, x: r1(q.x), y: r1(q.y), dx: r2(-dx / d), dy: r2(-dy / d) });
              break;
            }
            this.tag(it, q); break;
          }
        }
      }
      if (this.state === STATE.PLAY) {
        if (!infection && !potato) {
          const want = Math.min(this.itWant || 1, Math.max(1, this.players.size - 1));
          if (this.itPlayers().length < want && this.activeCount() >= 2) this.reassignIt();
        } else if (!this.itPlayers().length && this.aliveCount() >= 2) {
          if (infection) this.redoRound('The infected player left. Voting again!');
          else this.reassignIt();                                                                             // the last potato holder left
        }
        // last one standing: Hot Potato ends with one player left; Infection when one survivor is left after the outbreak began
        if (this.state !== STATE.PLAY) { /* the round was just scrapped */ }
        else if (potato && this.aliveCount() <= 1) this.endRound();
        else if (infection) { let surv = 0; for (const p of this.players.values()) if (!p.out && !p.it) surv++; if (surv <= (this.tagCount > 0 ? 1 : 0)) this.endRound(); }
        else if (this.activeCount() < this.minPlayers()) this.toWait();
      }
    }

    // ---- standing still (once per second). Nobody is ever removed for standing still: as long as the connection is alive you stay in.
    // Only the "afk" flag is set after 30 seconds of not moving; afk players don't earn win credit or survival score (anti-farming).
    if (this.tickN % 60 === 0) {
      const now = Date.now();
      for (const p of this.players.values()) {
        if (p.bot) continue;
        if (this.state !== STATE.PLAY || p.out || (this.mode === 'prophunt' && ((this.ph && this.ph.hide > 0) || !p.it))) { p.lastActiveAt = now; p.afk = false; p.ax0 = p.x; p.ay0 = p.y; continue; }      // Prop Hunt hiders are supposed to stand still (and seekers are held during the hide phase)
        if (p.ax0 === undefined || Math.hypot(p.x - p.ax0, p.y - p.ay0) > IDLE_MOVE || p.stun > 0.5) { p.ax0 = p.x; p.ay0 = p.y; p.lastActiveAt = now; }
        p.afk = now - p.lastActiveAt > AFK_AFTER;
      }
    }

    // ---- network
    if (this.rosterDirty) { this.rosterDirty = false; this.broadcast({ t: 'roster', ps: this.roster() }); }
    if (this.tickN % SNAP_EVERY === 0) this.sendSnapshots();
    if (this.events.length) { this.broadcast({ t: 'ev', e: this.events }); this.events = []; }
  }

  /* ------------------------------ networking ---------------------------- */
  roster() { return [...this.players.values()].map((p) => ({ id: p.id, n: p.name, c: p.c, k: p.col, h: p.hat || 0, b: p.bot ? 1 : 0, a: p.uid ? 1 : 0, w: p.wait ? 1 : 0, ...(p.skin ? { sk: p.skin } : {}), ...(p.title ? { tt: p.title.t, tc: p.title.c } : {}) })); }

  send(p, obj) { if (p.ws && p.ws.readyState === 1) p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const p of this.players.values()) if (!p.bot) this.send(p, s);
  }

  sendSnapshots() {
    const ps = [];
    const tnow = Date.now();
    for (const p of this.players.values()) {
      const flags = (p.it ? 1 : 0) | (p.stun > 0 ? 2 : 0) | (p.imm > 0 ? 4 : 0) | (p.afk ? 8 : 0) | (p.out || p.gone ? 16 : 0) | (p.wait ? 32 : 0) | (p.typeAt > tnow ? 64 : 0) | (p.bm ? 128 : 0);
      const row = [p.id, r1(p.x), r1(p.y), r1(p.vx), r1(p.vy), r2(p.fx), r2(p.fy), flags, r2(p.abT), Math.floor(p.score), p.tags, r1(p.z || 0)];
      if (this.ctx.prop) row.push(p.pr | 0, p.pv | 0);       // Prop Hunt: which prop a hider is disguised as, and its turn
      ps.push(row);
    }
    const head = {
      t: 's', n: this.tickN, ts: performance.now(), s: this.state, tl: r1(this.tl), m: this.map.id, rd: this.round, it: this.itId, md: this.mode, p: ps,
      g: this.goos.map((g) => [g.id, r1(g.x), r1(g.y), g.r, g.o, r1(g.ttl), g.splash ? 1 : g.s === 2 ? 2 : 0]),
      d: this.decoys.map((d) => [d.id, r1(d.x), r1(d.y), r1(d.vx), r1(d.vy), d.c, d.k, d.o, r1(d.ttl)]),
      sd: this.seeds.map((x) => [x.id, r1(x.x), r1(x.y), r1(x.vx), r1(x.vy), x.o]),
      pi: this.pits.map((x) => [x.id, r1(x.x), r1(x.y), x.r, x.o, r1(x.ttl)]),
    };
    if (this.state === STATE.RESULTS) { head.res = this.results; if (this.phWin) head.pw = this.phWin; }
    if (this.ctx.prop && this.ph && this.state === STATE.PLAY && this.ph.hide > 0) head.hd = r1(this.ph.hide);
    if (this.mode === 'potato' && this.state === STATE.PLAY) head.pt = this.itPlayers().map((p) => [p.id, r1(Math.max(0, p.pot))]);
    if (this.state === STATE.VOTE && this.vote) { head.vc = { m: this.vote.maps, d: this.vote.modes }; head.vt = this.tally(); }
    const base = JSON.stringify(head).slice(0, -1);
    for (const p of this.players.values()) {
      if (p.bot || !p.ws || p.ws.readyState !== 1) continue;
      if (p.ws.bufferedAmount > 512 * 1024) continue;       // slow client: skip this frame
      p.ws.send(base + ',"me":' + JSON.stringify(T.packSim(p)) + ',"ack":' + p.ack + '}');
    }
  }
}

module.exports = { Room };
