'use strict';
process.env.VOTE_TIME = '0.4'; process.env.PICK_TIME = '3';
/* Change-character window + typing bubble, over real sockets. */
process.env.PORT = '3130';
const srv = require('../server.js');
const T = require('../public/shared.js');
const WebSocket = require('ws');
const BASE = 'http://127.0.0.1:3130', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) fails++; };
function join(name, c = 0) {
  return new Promise((res) => {
    const ws = new WebSocket('ws://127.0.0.1:3130/ws'); const o = { ws, msgs: [], snap: null, looks: [], send: (m) => ws.send(JSON.stringify(m)) };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, mode: 'online', c, k: 0 })));
    ws.on('message', (d) => { const m = JSON.parse(d); if (m.t === 'init') { o.id = m.id; res(o); } if (m.t === 's') o.snap = m; if (m.t === 'look') o.looks.push(m); });
  });
}
(async () => {
  await srv.server.listen(3130, '127.0.0.1');
  await srv.init({ file: null, auth: { registerPerHour: 500 } });
  const starter = T.CHARS.findIndex((c) => T.STARTERS.includes(c.id)), starter2 = T.CHARS.findIndex((c, i) => i !== starter && T.STARTERS.includes(c.id)), locked = T.CHARS.findIndex((c) => !T.STARTERS.includes(c.id));
  const A = await join('Aaa', starter), B = await join('Bbb', starter);
  for (let i = 0; i < 80 && !(A.snap && A.snap.s === T.STATE.COUNT && A.snap.tl > T.COUNTDOWN); i++) await sleep(100);
  ok(A.snap && A.snap.s === T.STATE.COUNT && A.snap.tl > T.COUNTDOWN, 'countdown opens with the change window (tl above the 4-3-2-1)');
  A.send({ t: 'char', c: starter2, k: 3, sk: 'lava' }); await sleep(300);
  ok(A.looks.length === 1 && A.looks[0].c === starter2 && A.looks[0].k === 3 && A.looks[0].sk === '', 'a starter swap is confirmed (guests never get a skin)');
  A.send({ t: 'char', c: locked, k: 0 }); await sleep(300);
  ok(A.looks.length === 1, 'a character you have not unlocked is refused');
  // typing bubble reaches other players
  B.send({ t: 'typing', on: 1 }); await sleep(250);
  ok(((A.snap.p.find((e) => e[0] === B.id) || [])[7] & 64) === 64, 'others see the typing flag');
  B.send({ t: 'typing', on: 0 }); await sleep(250);
  ok(((A.snap.p.find((e) => e[0] === B.id) || [])[7] & 64) === 0, 'and it goes away when you stop');
  for (let i = 0; i < 60 && !(A.snap.s === T.STATE.COUNT && A.snap.tl <= T.COUNTDOWN); i++) await sleep(100);
  A.send({ t: 'char', c: starter, k: 0 }); await sleep(300);
  ok(A.looks.length === 1, 'no change once the 4-3-2-1 has started');
  A.ws.close(); B.ws.close(); await sleep(200);
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
