// Accounts and API keys, on their own append-only log.
//
// A key is shown once, at creation, and stored only as a SHA-256 hash: a
// leaked accounts.jsonl must not hand over anyone's account. SHA-256 with no
// salt or stretching is the right choice *here* precisely because the secret
// is 32 bytes of CSPRNG output — there is no dictionary to attack, and key
// lookup has to be fast on every request. (A human-chosen password would
// need scrypt; this is not one.)
//
// The visible prefix exists so a customer can tell two keys apart in a list
// without us storing the secret.

const crypto = require('crypto');
const { invalid } = require('./errors');
const passwords = require('./passwords');

const PREFIX = 'sf_';
const EMAIL_RE = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/;

const hash = secret => crypto.createHash('sha256').update(secret).digest('hex');

class Accounts {
  constructor(log) {
    this.log = log;
    this.users = new Map();       // id -> { id, email, createdAt }
    this.byEmail = new Map();     // email -> id
    this.keys = new Map();        // hash -> { id, user, prefix, label, revoked }
    for (const e of log.events) this.#apply(e);
  }

  #apply(e) {
    switch (e.type) {
      case 'user':
        // `password` is absent on accounts created before passwords existed;
        // those stay API-key-only and simply cannot log in to the web UI.
        this.users.set(e.user, {
          id: e.user, email: e.email, createdAt: e.ts,
          password: e.password || null, credentialVersion: 0
        });
        this.byEmail.set(e.email, e.user);
        break;
      case 'password': {
        // Bumping the version is what logs every existing session out.
        const user = this.users.get(e.user);
        if (user) { user.password = e.password; user.credentialVersion++; }
        break;
      }
      case 'key':
        this.keys.set(e.hash, { id: e.keyId, user: e.user, prefix: e.prefix, label: e.label, createdAt: e.ts, revoked: false });
        break;
      case 'key-revoked': {
        for (const k of this.keys.values()) if (k.id === e.keyId) k.revoked = true;
        break;
      }
      default:
        throw new Error(`Unknown account event type "${e.type}" at seq ${e.seq}`);
    }
  }

  // Async because hashing a password is deliberately slow. A password is
  // optional: an account can exist for API use only.
  async createUser(email, password = null) {
    const clean = String(email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(clean)) throw invalid('A valid email is required');
    if (this.byEmail.has(clean)) throw invalid(`${clean} already has an account`);
    // Validate before hashing so a bad password fails fast.
    if (password !== null) passwords.check(password);
    const hashed = password === null ? null : await passwords.hash(password);
    const id = crypto.randomUUID();
    this.#apply(this.log.append({ type: 'user', user: id, email: clean, password: hashed }));
    return this.users.get(id);
  }

  user(id) { return this.users.get(id) || null; }
  userByEmail(email) { return this.users.get(this.byEmail.get(String(email || '').trim().toLowerCase())) || null; }

  // Returns the user, or null. Deliberately does not distinguish "no such
  // account" from "wrong password": that difference is an account-enumeration
  // oracle, and the UI has nothing useful to do with it either way.
  async verify(email, password) {
    const user = this.userByEmail(email);
    if (!user || !user.password) {
      // Spend comparable time anyway, so a missing account is not detectably
      // faster than a wrong password.
      await passwords.verify(String(password || ''), await this.#decoyHash());
      return null;
    }
    return (await passwords.verify(password, user.password)) ? user : null;
  }

  // One throwaway hash per process, reused: generating a fresh one per failed
  // login would itself cost more than a real verify.
  async #decoyHash() {
    if (!this._decoy) this._decoy = await passwords.hash(crypto.randomBytes(16).toString('hex'));
    return this._decoy;
  }

  async setPassword(userId, password) {
    const user = this.users.get(userId);
    if (!user) throw invalid('No such user');
    passwords.check(password);
    const hashed = await passwords.hash(password);
    this.#apply(this.log.append({ type: 'password', user: userId, password: hashed }));
    return this.users.get(userId);
  }

  credentialVersion(userId) {
    const user = this.users.get(userId);
    return user ? user.credentialVersion : -1;
  }

  // Never includes the password hash.
  publicUser(id) {
    const user = this.users.get(id);
    return user ? { id: user.id, email: user.email, createdAt: user.createdAt, hasPassword: !!user.password } : null;
  }

  // The only moment the secret exists in plaintext. Hand it to the customer
  // and forget it.
  issueKey(userId, label = '') {
    if (!this.users.has(userId)) throw invalid('No such user');
    const secret = PREFIX + crypto.randomBytes(32).toString('base64url');
    const keyId = crypto.randomUUID();
    const prefix = secret.slice(0, PREFIX.length + 6);
    this.#apply(this.log.append({
      type: 'key', user: userId, keyId, hash: hash(secret), prefix, label: String(label).slice(0, 80)
    }));
    return { id: keyId, secret, prefix, label };
  }

  // Constant-time-ish by construction: the lookup is a hash table keyed by the
  // digest, so no comparison loop leaks how much of a key matched.
  authenticate(secret) {
    if (typeof secret !== 'string' || !secret.startsWith(PREFIX)) return null;
    const record = this.keys.get(hash(secret));
    if (!record || record.revoked) return null;
    return this.users.get(record.user) || null;
  }

  listKeys(userId) {
    return [...this.keys.values()]
      .filter(k => k.user === userId)
      .map(({ id, prefix, label, createdAt, revoked }) => ({ id, prefix, label, createdAt, revoked }));
  }

  revokeKey(userId, keyId) {
    const record = [...this.keys.values()].find(k => k.id === keyId && k.user === userId);
    if (!record) throw invalid('No such key');
    if (record.revoked) return record;
    this.#apply(this.log.append({ type: 'key-revoked', user: userId, keyId }));
    return record;
  }
}

module.exports = { Accounts };
