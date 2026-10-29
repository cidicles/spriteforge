// Session store tests.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Sessions } = require('../lib/sessions');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-sess-')), 'sessions.jsonl');

console.log('\nissuing and looking up');
{
  const s = new Sessions({ file: fresh() });
  const token = s.create('u1', 0);
  eq('a fresh token resolves to its user', s.lookup(token, () => 0), 'u1');
  eq('an unknown token does not', s.lookup('nope', () => 0), null);
  eq('an empty token does not', s.lookup('', () => 0), null);
  eq('a null token does not', s.lookup(null, () => 0), null);
  eq('one session is live', s.count(), 1);
}

console.log('\na password change invalidates every session');
{
  const s = new Sessions({ file: fresh() });
  const phone = s.create('u1', 0);
  const laptop = s.create('u1', 0);
  eq('both work', [s.lookup(phone, () => 0), s.lookup(laptop, () => 0)], ['u1', 'u1']);
  // The user changed their password, so their credential version moved on.
  eq('the phone session is now invalid', s.lookup(phone, () => 1), null);
  eq('and the laptop one too', s.lookup(laptop, () => 1), null);
  eq('they are dropped, not just hidden', s.count(), 0);
}

console.log('\nexpiry');
{
  const s = new Sessions({ file: fresh(), ttlMs: -1 });   // already expired
  const token = s.create('u1', 0);
  eq('an expired session does not resolve', s.lookup(token, () => 0), null);
  eq('and is pruned', s.count(), 0);
}

console.log('\nlogout');
{
  const s = new Sessions({ file: fresh() });
  const a = s.create('u1', 0);
  const b = s.create('u1', 0);
  s.destroy(a);
  eq('the destroyed session is gone', s.lookup(a, () => 0), null);
  eq('the other device stays signed in', s.lookup(b, () => 0), 'u1');
  s.destroyAllFor('u1');
  eq('signing out everywhere clears them all', s.count(), 0);
  eq('destroying an unknown token is harmless', (s.destroy('nope'), s.count()), 0);
}

console.log('\nsessions are isolated by user');
{
  const s = new Sessions({ file: fresh() });
  const mine = s.create('u1', 0);
  const theirs = s.create('u2', 0);
  s.destroyAllFor('u2');
  eq('mine survives', s.lookup(mine, () => 0), 'u1');
  eq('theirs is gone', s.lookup(theirs, () => 0), null);
}

console.log('\npersistence across a restart');
{
  const file = fresh();
  const a = new Sessions({ file });
  const token = a.create('u1', 0);
  const b = new Sessions({ file });
  eq('a deploy does not sign everyone out', b.lookup(token, () => 0), 'u1');
}

console.log('\nthe file holds no usable token');
{
  const file = fresh();
  const s = new Sessions({ file });
  const token = s.create('u1', 0);
  const raw = fs.readFileSync(file, 'utf8');
  ok('the token itself is absent', !raw.includes(token));
  ok('only a hash is stored', /"hash":"[0-9a-f]{64}"/.test(raw));
}

console.log('\nexpired rows are pruned on load, not accumulated');
{
  const file = fresh();
  const s = new Sessions({ file, ttlMs: 50 });
  s.create('u1', 0);
  s.create('u2', 0);
  const live = new Sessions({ file }).count();
  eq('both are live immediately', live, 2);
  // Wait them out, then reload.
  const until = Date.now() + 80;
  while (Date.now() < until) { /* spin briefly */ }
  const after = new Sessions({ file });
  eq('expired sessions are dropped on load', after.count(), 0);
  eq('and the file is rewritten, not appended forever', fs.readFileSync(file, 'utf8').trim(), '');
}

console.log('\na damaged line costs one logout, not a crash');
{
  const file = fresh();
  const s = new Sessions({ file });
  const good = s.create('u1', 0);
  fs.appendFileSync(file, '{"hash":"trunc\n');
  const reloaded = new Sessions({ file });
  eq('the good session survives', reloaded.lookup(good, () => 0), 'u1');
  eq('the damaged one is skipped', reloaded.count(), 1);
}

console.log('\ncookies');
{
  const s = new Sessions({ file: fresh() });
  const plain = s.cookie('abc', { secure: false });
  ok('HttpOnly, so script cannot read it', /HttpOnly/.test(plain));
  ok('SameSite=Strict, so it is not sent cross-site', /SameSite=Strict/.test(plain));
  ok('scoped to the whole site', /Path=\//.test(plain));
  ok('no Secure flag on http, or the cookie would be dropped', !/Secure/.test(plain));
  ok('Secure on https', /Secure/.test(s.cookie('abc', { secure: true })));
  ok('clearing it expires immediately', /Max-Age=0/.test(s.clearCookie({ secure: false })));

  eq('reads its own cookie back', Sessions.read('sf_session=xyz'), 'xyz');
  eq('finds it among others', Sessions.read('other=1; sf_session=xyz; more=2'), 'xyz');
  eq('tolerates whitespace', Sessions.read(' sf_session=xyz '), 'xyz');
  eq('absent when not set', Sessions.read('other=1'), null);
  eq('absent with no header', Sessions.read(undefined), null);
  eq('is not fooled by a similar name', Sessions.read('xsf_session=xyz'), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
