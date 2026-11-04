'use strict';
/* Balance harness: simulates full rounds with one bot per character (same AI, hard difficulty) and prints
   how each character performs. Higher score = spent more of the round NOT being IT.
   usage: node tools/balance.js [rounds=60] [map=all] [playersPerChar=1] */
const T = require('../public/shared.js');
const { Room } = require('../src/room');
const { DIFFS } = require('../src/bots');

const rounds = +process.argv[2] || 60, onlyMap = process.argv[3] && process.argv[3] !== 'all' ? process.argv[3] : null, per = +process.argv[4] || 1;
const room = new Room('BAL', { kind: 'public' });
room.diff = 'hard'; room.botSpeed = DIFFS.hard.sm;
const charOf = new Map();
for (let k = 0; k < per; k++) for (let c = 0; c < T.CHARS.length; c++) {
  const p = room.makePlayer(T.CHARS[c].species + k, c, 0, true); room.players.set(p.id, p); charOf.set(p.id, c);
}
if (onlyMap) { room.mapMode = onlyMap; }
const agg = T.CHARS.map(() => ({ score: 0, tags: 0, uses: 0, n: 0, wins: 0 }));
const byMap = {};
room.emit = function (e) {
  if (e.k === 'ab' && charOf.has(e.id) && e.n !== 'tele' && e.n !== 'shieldhit') agg[charOf.get(e.id)].uses++;
  if (e.k === 'st' && e.s === T.STATE.RESULTS) {
    let best = -1, bs = -1;
    for (const [id, s, t] of room.results) { const c = charOf.get(id), a = agg[c]; a.score += s; a.tags += t; a.n++; (byMap[room.map.id] = byMap[room.map.id] || T.CHARS.map(() => ({ s: 0, n: 0 })))[c].s += s; byMap[room.map.id][c].n++; if (s > bs) { bs = s; best = c; } }
    if (best >= 0) agg[best].wins++;
    done++;
  }
  this.events.push(e);
};
let done = 0;
room.events = [];
room.startCountdown();
const t0 = Date.now();
for (let i = 0; done < rounds && i < rounds * 60 * 120; i++) { room.tick(); room.events.length = 0; }
const mean = agg.reduce((a, x) => a + x.score / x.n, 0) / agg.length;
console.log(`\n${rounds} rounds, ${per} bot(s) per character, ${(Date.now() - t0) / 1000}s CPU. Mean score ${mean.toFixed(1)} / 90`);
console.log('char     score  vs mean   tags/rd  ability/rd  wins');
T.CHARS.forEach((c, i) => {
  const a = agg[i], sc = a.score / a.n;
  console.log(c.species.padEnd(8), sc.toFixed(1).padStart(5), ((sc / mean - 1) * 100).toFixed(1).padStart(7) + '%', (a.tags / a.n).toFixed(2).padStart(8), (a.uses / a.n).toFixed(2).padStart(10), String(a.wins).padStart(6));
});
if (!onlyMap) {
  console.log('\nscore by map (vs that map mean):');
  for (const [m, arr] of Object.entries(byMap)) {
    const mm = arr.reduce((a, x) => a + x.s / Math.max(1, x.n), 0) / arr.length;
    console.log(m.padEnd(8), arr.map((x, i) => T.CHARS[i].id.slice(0, 4) + ' ' + (((x.s / Math.max(1, x.n)) / mm - 1) * 100).toFixed(0).padStart(3) + '%').join('  '));
  }
}
