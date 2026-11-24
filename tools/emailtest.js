'use strict';
/* Email on accounts: required at sign-up, asked for when missing, validated, never public. Runs on a tiny server with just the account module. */
const http = require('http');
const db = require('../src/db');
const auth = require('../src/auth');
const T = require('../public/shared.js');
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('  FAIL:', m); } else console.log('  ok  :', m); };

(async () => {
  const store = await db.open({ file: null });
  const acc = auth.create(store, { registerPerHour: 500 });
  const server = http.createServer(async (req, res) => { if (!(await acc.handle(req, res, req.url))) { res.statusCode = 404; res.end(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port;
  const post = (u, b, cookie) => fetch(BASE + u, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}), body: JSON.stringify(b) });
  const me = async (cookie) => (await (await fetch(BASE + '/api/me', { headers: { cookie } })).json()).user;

  ok(T.validateEmail(' A@B.co ').email === 'a@b.co', 'validateEmail trims and lowercases');
  for (const bad of ['', 'a', 'a@b', 'a b@c.com', '@c.com', 'a@@c.com', 'a@c..com', 'a@-c.com', 'x'.repeat(130) + '@c.com', 'a,b@c.com']) ok(!T.validateEmail(bad).ok, 'rejects ' + JSON.stringify(bad.slice(0, 20)));

  let r = await post('/api/register', { username: 'NoMail', password: 'correct-horse-9' }); ok(r.status === 400, 'sign-up without an email is refused');
  r = await post('/api/register', { username: 'NoMail', password: 'correct-horse-9', email: 'nope' }); ok(r.status === 400, 'sign-up with a bad email is refused');
  ok(!(await store.nameTaken('NoMail')), 'a refused sign-up creates no account');
  r = await post('/api/register', { username: 'Good', password: 'correct-horse-9', email: ' Good@Example.COM ' }); const j = await r.json();
  ok(r.status === 200 && j.user.email === 'good@example.com' && j.user.needsEmail === false, 'sign-up with an email works and stores it normalised');
  const cookie = r.headers.get('set-cookie').split(';')[0];

  // an older account with no email: login says it needs one
  const old = await store.createUser('Oldie', await auth.hashPassword('correct-horse-9'));
  r = await post('/api/login', { username: 'Oldie', password: 'correct-horse-9' }); const lj = await r.json(); const oc = r.headers.get('set-cookie').split(';')[0];
  ok(r.status === 200 && lj.user.needsEmail === true && lj.user.email === '', 'login for an account without an email says needsEmail');
  ok((await me(oc)).needsEmail === true, '/api/me keeps asking until it is set');
  r = await post('/api/email', { email: 'bad' }, oc); ok(r.status === 400, 'setting a bad email is refused');
  r = await post('/api/email', { email: 'oldie@example.com' }); ok(r.status === 401, 'setting an email needs a login');
  r = await post('/api/email', { email: 'Oldie@Example.com' }, oc); const ej = await r.json();
  ok(r.status === 200 && ej.user.needsEmail === false && ej.user.email === 'oldie@example.com', 'setting the email clears needsEmail');
  ok((await me(oc)).needsEmail === false && (await store.userById(old.id)).email === 'oldie@example.com', 'and it is saved');
  r = await post('/api/email', { email: 'changed@example.com' }, cookie); ok((await r.json()).user.email === 'changed@example.com', 'you can change your own email');

  ok(!JSON.stringify(auth.publicUser(await store.userById(old.id))).includes('@'), 'the shared public view never carries the email');
  const all = await store.listEmails(); ok(all.length === 2 && all.every((x) => x.email), 'every account now has one');
  server.close();

  /* ---------------- email recovery: a fresh server with a fake mailer and a clock we control ---------------- */
  {
    let clock = 1e12; const sent = []; let mailFails = false; const banned = new Set();
    const mailer = { async send(m) { if (mailFails) throw new Error('smtp down'); sent.push(m); } };
    const off = auth.create(store, { registerPerHour: 500, mailer: null });
    const acc2 = auth.create(store, { registerPerHour: 500, recoverTries: 200, recoverPerIp: 200, recoverPerWho: 3, mailer, now: () => clock, isBanned: (n) => (banned.has(n) ? 'rule break' : '') });
    const srv = http.createServer(async (req, res) => { if (!(await acc2.handle(req, res, req.url))) { res.statusCode = 404; res.end(); } });
    const srvOff = http.createServer(async (req, res) => { if (!(await off.handle(req, res, req.url))) { res.statusCode = 404; res.end(); } });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r)); await new Promise((r) => srvOff.listen(0, '127.0.0.1', r));
    const B2 = 'http://127.0.0.1:' + srv.address().port, B3 = 'http://127.0.0.1:' + srvOff.address().port;
    const p2 = (u, b, cookie, base) => fetch((base || B2) + u, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}), body: JSON.stringify(b) });
    const me2 = async (cookie) => (await (await fetch(B2 + '/api/me', { headers: { cookie } })).json()).user;
    const until = async (f, ms = 1500) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (f()) return true; await new Promise((r) => setTimeout(r, 20)); } return f(); };
    const settle = () => new Promise((r) => setTimeout(r, 120));
    const codeOf = (m, who) => { const re = who ? new RegExp('Username: ' + who + '\\nCode: (\\d{6})') : /Code: (\d{6})/; const x = re.exec(m.text); return x && x[1]; };

    ok((await (await fetch(B3 + '/api/me')).json()).recovery === false && (await (await fetch(B2 + '/api/me')).json()).recovery === true, '/api/me says whether email recovery is available');
    let r = await p2('/api/recover/start', { who: 'Rec' }, null, B3); ok(r.status === 503, 'without a mailer recovery is switched off (start)');
    r = await p2('/api/recover/finish', { username: 'Rec', code: '123456', password: 'brand-new-pass-1' }, null, B3); ok(r.status === 503, 'and finishing is off too');

    r = await p2('/api/register', { username: 'Rec', password: 'old-password-1', email: 'Rec@Example.com' }); const oldCookie = r.headers.get('set-cookie').split(';')[0];
    await p2('/api/register', { username: 'Twin', password: 'old-password-2', email: 'rec@example.com' });          // shares the address
    await store.createUser('Mailless', await auth.hashPassword('old-password-3'));                                    // no email on file
    await p2('/api/register', { username: 'Ban', password: 'old-password-4', email: 'ban@example.com' });

    r = await p2('/api/recover/start', { who: '' }); ok(r.status === 400, 'asking with nothing typed is refused');
    const ghost = await (await p2('/api/recover/start', { who: 'NoSuchPerson' })).text(); await settle();
    ok(sent.length === 0, 'an unknown name sends nothing');
    r = await p2('/api/recover/start', { who: 'Rec' }); const known = await r.text(); await until(() => sent.length === 1);
    ok(r.status === 200 && known === ghost, 'the answer is identical whether or not the account exists');
    ok(sent.length === 1 && sent[0].to === 'rec@example.com' && /^Daymap/.test(sent[0].subject) && codeOf(sent[0], 'Rec') && !/Twin/.test(sent[0].text), 'a code goes to the address on the account');
    const code1 = codeOf(sent[0]);
    ok(!JSON.stringify(await store.kvGet('reset:' + (await store.userByName('Rec')).id)).includes(code1), 'only a hash of the code is stored');

    await p2('/api/recover/start', { who: 'rec' }); await settle(); ok(sent.length === 1, 'asking again within a minute sends nothing new');
    clock += 61e3; await p2('/api/recover/start', { who: 'REC' }); await until(() => sent.length === 2); const code2 = codeOf(sent[1]);
    ok(sent.length === 2 && code2 && code2 !== code1, 'after a minute a new code is sent');
    r = await p2('/api/recover/finish', { username: 'Rec', code: code1, password: 'brand-new-pass-1' }); ok(r.status === 400, 'the older code stops working once a new one is sent');
    clock += 61e3; r = await p2('/api/recover/start', { who: 'rec' }); ok(r.status === 429, 'a fourth ask in an hour is refused (inbox flood guard)');

    // by email address: every account on it is listed, each with its own code
    const sent0 = sent.length; await p2('/api/recover/start', { who: ' REC@example.com ' }); await until(() => sent.length > sent0);
    const both = sent[sent.length - 1]; ok(sent.length === sent0 + 1 && both.to === 'rec@example.com' && /Username: Rec/.test(both.text) && /Username: Twin/.test(both.text), 'asking by email lists every account on that address');
    await p2('/api/recover/start', { who: 'Mailless' }); await p2('/api/recover/start', { who: 'nobody@nowhere.com' }); banned.add('Ban'); await p2('/api/recover/start', { who: 'Ban' }); await settle();
    ok(sent.length === sent0 + 1, 'accounts with no email, unknown addresses and suspended accounts get nothing');

    // finishing
    const goodCode = codeOf(both, 'Rec');
    r = await p2('/api/recover/finish', { username: 'Rec', code: goodCode, password: 'short' }); ok(r.status === 400 && /8/.test((await r.json()).error), 'a weak new password is refused ...');
    r = await p2('/api/recover/finish', { username: 'Rec', code: '000000', password: 'brand-new-pass-1' }); ok(r.status === 400, 'a wrong code is refused');
    r = await p2('/api/recover/finish', { username: 'Nobody', code: goodCode, password: 'brand-new-pass-1' }); ok(r.status === 400, 'a code for another name is refused');
    clock += 16 * 60e3; r = await p2('/api/recover/finish', { username: 'Rec', code: goodCode, password: 'brand-new-pass-1' }); ok(r.status === 400, 'an expired code (16 min) is refused');
    clock += 61e3; mailFails = false; const s1 = sent.length; await p2('/api/recover/start', { who: 'Twin' }); await until(() => sent.length > s1); let tc = codeOf(sent[sent.length - 1], 'Twin');
    for (let i = 0; i < 5; i++) await p2('/api/recover/finish', { username: 'Twin', code: i === 0 ? '000001' : '00000' + (i + 1), password: 'brand-new-pass-1' });
    r = await p2('/api/recover/finish', { username: 'Twin', code: tc, password: 'brand-new-pass-1' }); ok(r.status === 400, 'five wrong guesses kill the code, even the right one then fails');

    clock += 61e3; const s2 = sent.length; await p2('/api/recover/start', { who: 'rec@example.com' }); await until(() => sent.length > s2); const rc = codeOf(sent[sent.length - 1], 'Rec');
    r = await p2('/api/recover/finish', { username: 'rEc', code: rc.slice(0, 3) + ' ' + rc.slice(3), password: 'brand-new-pass-1' }); const fj = await r.json();
    ok(r.status === 200 && fj.user.username === 'Rec', 'the right code (spaces and case forgiven) sets the new password and logs you in');
    const newCookie = r.headers.get('set-cookie').split(';')[0];
    ok((await me2(newCookie)).username === 'Rec' && (await me2(oldCookie)) === null, 'the new session works and every old session is signed out');
    r = await p2('/api/login', { username: 'Rec', password: 'old-password-1' }); ok(r.status === 401, 'the old password no longer works');
    r = await p2('/api/login', { username: 'Rec', password: 'brand-new-pass-1' }); ok(r.status === 200, 'the new password works');
    r = await p2('/api/recover/finish', { username: 'Rec', code: rc, password: 'another-pass-22' }); ok(r.status === 400, 'a code can only be used once');
    ok(await until(() => sent.some((m) => /password was changed/.test(m.subject) && m.to === 'rec@example.com')), 'a "your password was changed" email is sent too');

    // a broken mail server must not break the request
    mailFails = true; clock += 61e3 * 3; r = await p2('/api/recover/start', { who: 'Mailless' }); ok(r.status === 200, 'a failing mail server still answers normally');
    // trying codes is limited per visitor
    const acc3 = auth.create(store, { registerPerHour: 500, recoverTries: 3, recoverPerIp: 2, mailer, now: () => clock });
    const srv3 = http.createServer(async (req, res) => { if (!(await acc3.handle(req, res, req.url))) { res.statusCode = 404; res.end(); } }); await new Promise((r) => srv3.listen(0, '127.0.0.1', r));
    const B4 = 'http://127.0.0.1:' + srv3.address().port, st = [];
    for (let i = 0; i < 5; i++) st.push((await p2('/api/recover/finish', { username: 'Rec', code: '111111', password: 'brand-new-pass-1' }, null, B4)).status);
    ok(st.slice(0, 3).every((x) => x === 400) && st.slice(3).every((x) => x === 429), 'guessing codes is rate limited per visitor (' + st.join(',') + ')');
    const sa = []; for (const w of ['aa', 'bb', 'cc']) sa.push((await p2('/api/recover/start', { who: w }, null, B4)).status);
    ok(sa.join() === '200,200,429', 'asking for codes is rate limited per visitor (' + sa.join(',') + ')');
    srv.close(); srvOff.close(); srv3.close();
  }
  console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
