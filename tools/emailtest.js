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
  server.close(); console.log(fails ? fails + ' FAILED' : 'ALL PASSED'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
