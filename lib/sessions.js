// Browser sessions.
//
// Stored as SHA-256 hashes of the token, like API keys: the token itself only
// ever exists in the customer's cookie. A leaked sessions file lets an attacker
// invalidate sessions, not assume them.
//
// Persisted, rather than kept in memory, because this project is deployed
// often and logging every customer out on each deploy is a bad trade for the
// ~30 lines it takes to avoid. The file is pruned of expired rows on load and
// rewritten, so it stays proportional to live sessions rather than to all
// logins ever.
//
// A password change bumps the user's credential version, which invalidates
// every existing session for that user — the thing you actually want after
// "someone else knows my password".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const COOKIE = 'sf_session';

const hash = token => crypto.createHash('sha256').update(token).digest('hex');

class Sessions {
  // cookiePath matters behind a path prefix: aislop.cloud serves this app at
  // /spriteforge/ and strips the prefix before forwarding, so the server never
  // sees it — but the browser does, and the cookie has to be scoped to what
  // the browser sees or it leaks to every other project on the domain.
  constructor({ file, ttlMs = TTL_MS, cookiePath = '/' }) {
    this.file = file;
    this.ttlMs = ttlMs;
    this.cookiePath = cookiePath;
    this.byHash = new Map();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#load();
  }

  #load() {
    if (!fs.existsSync(this.file)) return;
    const now = Date.now();
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let row;
      // A damaged session line costs one logout, not money: skip it. The
      // ledger cannot afford that leniency; this can.
      try { row = JSON.parse(line); } catch { continue; }
      if (row.expiresAt > now) this.byHash.set(row.hash, row);
    }
    this.#rewrite();
  }

  #rewrite() {
    const rows = [...this.byHash.values()].map(r => JSON.stringify(r)).join('\n');
    fs.writeFileSync(this.file, rows ? rows + '\n' : '');
  }

  #append(row) {
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
  }

  // Returns the raw token, which is handed to the browser and never stored.
  create(userId, credentialVersion = 0) {
    const token = crypto.randomBytes(32).toString('base64url');
    const row = {
      hash: hash(token), user: userId, credentialVersion,
      createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs
    };
    this.byHash.set(row.hash, row);
    this.#append(row);
    return token;
  }

  // `versionOf(userId)` supplies the user's credential version now. A session
  // issued before a password change no longer matches and is dropped. It is a
  // callback because the user id only becomes known once the row is found.
  lookup(token, versionOf = () => 0) {
    if (typeof token !== 'string' || !token) return null;
    const row = this.byHash.get(hash(token));
    if (!row) return null;
    if (row.expiresAt <= Date.now() || row.credentialVersion !== versionOf(row.user)) {
      this.byHash.delete(row.hash);
      this.#rewrite();
      return null;
    }
    return row.user;
  }

  destroy(token) {
    if (typeof token !== 'string') return;
    if (this.byHash.delete(hash(token))) this.#rewrite();
  }

  destroyAllFor(userId) {
    let changed = false;
    for (const [h, row] of this.byHash) {
      if (row.user === userId) { this.byHash.delete(h); changed = true; }
    }
    if (changed) this.#rewrite();
  }

  count() { return this.byHash.size; }

  // Secure is set only when the request arrived over https: a Secure cookie on
  // plain http://localhost is silently dropped, which would make the whole app
  // look broken in development.
  cookie(token, { secure, maxAge = this.ttlMs }) {
    const parts = [
      `${COOKIE}=${token}`,
      `Path=${this.cookiePath}`,
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(maxAge / 1000)}`
    ];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  clearCookie({ secure }) {
    const parts = [`${COOKIE}=`, `Path=${this.cookiePath}`, 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
    if (secure) parts.push('Secure');
    return parts.join('; ');
  }

  static read(cookieHeader) {
    for (const part of String(cookieHeader || '').split(';')) {
      const [name, ...rest] = part.trim().split('=');
      if (name === COOKIE) return rest.join('=');
    }
    return null;
  }
}

module.exports = { Sessions, COOKIE };
