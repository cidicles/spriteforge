// Account, password and API-key tests. The property that matters: the log must
// never be enough to impersonate a customer.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventLog } = require('../lib/events');
const { Accounts } = require('../lib/accounts');
const passwords = require('../lib/passwords');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);
const rejects = async (label, fn, re) => {
  try { await fn(); ok(label, false, 'did not throw'); }
  catch (e) { ok(label, re.test(e.message), `threw "${e.message}"`); }
};

const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-acct-')), 'accounts.jsonl');
const PW = 'correct horse battery';

(async () => {
  console.log('\nusers');
  {
    const a = new Accounts(new EventLog(fresh()));
    const u = await a.createUser('Dev@Example.COM', PW);
    eq('email is normalised', u.email, 'dev@example.com');
    ok('id is a uuid', /^[0-9a-f-]{36}$/.test(u.id));
    eq('lookup by email is case-insensitive', a.userByEmail('DEV@example.com').id, u.id);
    await rejects('duplicate signup is refused', () => a.createUser('dev@example.com', PW), /already has an account/);
    for (const bad of ['', 'nope', 'a@b', '@b.com', 'a b@c.com']) {
      await rejects(`"${bad}" is not an email`, () => a.createUser(bad, PW), /valid email/);
    }
  }

  console.log('\npasswords');
  {
    const a = new Accounts(new EventLog(fresh()));
    const u = await a.createUser('dev@example.com', PW);
    ok('the right password verifies', (await a.verify('dev@example.com', PW)).id === u.id);
    eq('a wrong password does not', await a.verify('dev@example.com', 'wrong wrong wrong'), null);
    eq('an unknown account does not', await a.verify('nobody@example.com', PW), null);
    eq('email case does not matter at login', (await a.verify('DEV@EXAMPLE.COM', PW)).id, u.id);
    await rejects('a short password is refused', () => a.createUser('b@c.com', 'short'), /at least 10 characters/);
    await rejects('an absurd password is refused', () => a.createUser('b@c.com', 'x'.repeat(500)), /under 200 characters/);
    eq('a user reports having a password', a.publicUser(u.id).hasPassword, true);
  }

  console.log('\nchanging a password invalidates old sessions');
  {
    const a = new Accounts(new EventLog(fresh()));
    const u = await a.createUser('dev@example.com', PW);
    eq('the credential version starts at zero', a.credentialVersion(u.id), 0);
    await a.setPassword(u.id, 'a whole new password');
    eq('changing it bumps the version', a.credentialVersion(u.id), 1);
    eq('the old password stops working', await a.verify('dev@example.com', PW), null);
    ok('the new one works', (await a.verify('dev@example.com', 'a whole new password')).id === u.id);
    await rejects('a short replacement is refused', () => a.setPassword(u.id, 'tiny'), /at least 10 characters/);
    await rejects('a stranger has no password to set', () => a.setPassword('nobody', PW), /No such user/);
  }

  console.log('\nan account can exist without a password (API only)');
  {
    const a = new Accounts(new EventLog(fresh()));
    const u = await a.createUser('robot@example.com', null);
    eq('it reports having none', a.publicUser(u.id).hasPassword, false);
    eq('and cannot be logged into', await a.verify('robot@example.com', ''), null);
    ok('but a key still works', a.authenticate(a.issueKey(u.id).secret).id === u.id);
  }

  console.log('\nkeys authenticate');
  {
    const a = new Accounts(new EventLog(fresh()));
    const u = await a.createUser('dev@example.com', PW);
    const key = a.issueKey(u.id, 'laptop');
    ok('the secret is prefixed', key.secret.startsWith('sf_'));
    ok('the secret is long', key.secret.length > 40);
    eq('authenticating returns the owner', a.authenticate(key.secret).id, u.id);
    eq('a wrong key is rejected', a.authenticate('sf_wrong'), null);
    eq('an unprefixed key is rejected', a.authenticate('wrong'), null);
    eq('a null key is rejected', a.authenticate(null), null);
    eq('an empty key is rejected', a.authenticate(''), null);
    await rejects('keys cannot be issued for strangers', () => Promise.resolve(a.issueKey('nobody')), /No such user/);
  }

  console.log('\nthe log never contains a usable secret');
  {
    const file = fresh();
    const a = new Accounts(new EventLog(file));
    const u = await a.createUser('dev@example.com', PW);
    const key = a.issueKey(u.id, 'laptop');
    const raw = fs.readFileSync(file, 'utf8');
    ok('the api key secret is absent from disk', !raw.includes(key.secret));
    ok('the password is absent from disk', !raw.includes(PW));
    ok('only a key hash is stored', /"hash":"[0-9a-f]{64}"/.test(raw));
    ok('the password is scrypt, not a bare digest', /scrypt\$16384\$8\$1\$/.test(raw));
    ok('the prefix is stored for display', raw.includes(key.prefix));
    ok('the prefix alone cannot authenticate', a.authenticate(key.prefix) === null);
    ok('publicUser never leaks the hash', !('password' in a.publicUser(u.id)));
  }

  console.log('\nrevocation');
  {
    const a = new Accounts(new EventLog(fresh()));
    const u = await a.createUser('dev@example.com', PW);
    const k1 = a.issueKey(u.id, 'laptop');
    const k2 = a.issueKey(u.id, 'ci');
    a.revokeKey(u.id, k1.id);
    eq('a revoked key stops working', a.authenticate(k1.secret), null);
    eq('other keys keep working', a.authenticate(k2.secret).id, u.id);
    eq('revoking twice is harmless', (a.revokeKey(u.id, k1.id), a.authenticate(k1.secret)), null);
    await rejects('an unknown key cannot be revoked', () => Promise.resolve(a.revokeKey(u.id, 'nope')), /No such key/);

    const other = await a.createUser('someone@else.com', PW);
    await rejects('one customer cannot revoke another\'s key', () => Promise.resolve(a.revokeKey(other.id, k2.id)), /No such key/);
    eq('the key survives the attempt', a.authenticate(k2.secret).id, u.id);
  }

  console.log('\nlisting keys');
  {
    const a = new Accounts(new EventLog(fresh()));
    const u = await a.createUser('dev@example.com', PW);
    const k = a.issueKey(u.id, 'laptop');
    const listed = a.listKeys(u.id);
    eq('one key is listed', listed.length, 1);
    eq('with its label', listed[0].label, 'laptop');
    ok('and its prefix', listed[0].prefix === k.prefix);
    ok('but no secret', !JSON.stringify(listed).includes(k.secret));
    ok('and no hash', !('hash' in listed[0]));
    const other = await a.createUser('b@c.com', PW);
    eq('other customers see nothing', a.listKeys(other.id).length, 0);
  }

  console.log('\nstate survives a restart');
  {
    const file = fresh();
    const a = new Accounts(new EventLog(file));
    const u = await a.createUser('dev@example.com', PW);
    const live = a.issueKey(u.id, 'live');
    const dead = a.issueKey(u.id, 'dead');
    a.revokeKey(u.id, dead.id);
    await a.setPassword(u.id, 'a whole new password');

    const b = new Accounts(new EventLog(file));
    eq('the user is still there', b.userByEmail('dev@example.com').id, u.id);
    eq('the live key still authenticates', b.authenticate(live.secret).id, u.id);
    eq('the revoked key is still revoked', b.authenticate(dead.secret), null);
    eq('both keys are still listed', b.listKeys(u.id).length, 2);
    ok('the changed password works', (await b.verify('dev@example.com', 'a whole new password')).id === u.id);
    eq('the old password is still dead', await b.verify('dev@example.com', PW), null);
    eq('the credential version replays', b.credentialVersion(u.id), 1);
  }

  console.log('\nhashing in isolation');
  {
    const h = await passwords.hash(PW);
    ok('verifies against itself', await passwords.verify(PW, h));
    ok('rejects a near miss', !(await passwords.verify(PW + 'x', h)));
    ok('two hashes of one password differ (salted)', (await passwords.hash(PW)) !== h);
    ok('a malformed hash is rejected, not thrown', !(await passwords.verify(PW, 'garbage')));
    ok('an empty hash is rejected', !(await passwords.verify(PW, '')));
    ok('a non-string password is rejected', !(await passwords.verify(null, h)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
