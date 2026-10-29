// Password hashing with scrypt.
//
// This is the opposite case to an API key. A key is 32 bytes of CSPRNG output,
// so a bare SHA-256 is fine (see accounts.js). A password is human-chosen,
// low-entropy and reused across sites, so it needs to be deliberately
// expensive to guess: scrypt at ~100ms per attempt turns an offline dictionary
// run on a stolen accounts.jsonl from minutes into years.
//
// Hashing is async because 100ms of scrypt on the event loop is 100ms during
// which the server answers nobody. The cost parameters are stored *in* the
// hash string, so they can be raised later without invalidating old passwords.

const crypto = require('crypto');
const { invalid } = require('./errors');

// N=16384, r=8, p=1 is ~100ms and the usual interactive-login baseline.
const PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_LENGTH = 10;
// scrypt cost is driven by N, not input length, but an unbounded body is still
// free work for an attacker to hand us.
const MAX_LENGTH = 200;

function check(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    throw invalid(`Password must be at least ${MIN_LENGTH} characters`);
  }
  if (password.length > MAX_LENGTH) throw invalid(`Password must be under ${MAX_LENGTH} characters`);
  return password;
}

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    // maxmem must be raised to match N: the default 32MB rejects N=16384,r=8.
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)));
  });
}

// "scrypt$N$r$p$salt$hash" — self-describing, so raising the cost later is a
// per-user migration on next login rather than a flag day.
async function hash(password) {
  check(password);
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verify(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, expected] = parts;
  const expectedBuf = Buffer.from(expected, 'base64');
  let key;
  try {
    key = await scrypt(password, Buffer.from(salt, 'base64'), {
      N: Number(N), r: Number(r), p: Number(p), keylen: expectedBuf.length
    });
  } catch { return false; }
  // Constant-time: a length-dependent early return would leak nothing useful
  // here, but timingSafeEqual needs equal lengths anyway.
  return key.length === expectedBuf.length && crypto.timingSafeEqual(key, expectedBuf);
}

module.exports = { hash, verify, check, MIN_LENGTH, MAX_LENGTH };
