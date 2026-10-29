#!/usr/bin/env node
// SpriteForge — hosted sprite-sheet generation.
//
// The pipeline itself is diablow/scripts/generate-sprites.js, unchanged and
// run as a child process in one workspace per customer. Everything here is the
// part that makes it a business: who you are, what you have paid for, whose
// turn it is, and what you are allowed to download.
//
//   node server.js
//
// Configuration (all optional):
//   PORT            default 5180
//   DATA_DIR        where the ledger, accounts and workspaces live (./data)
//   PIPELINE        path to generate-sprites.js (../diablow/scripts/...)
//   PROVIDER        fal (default) or apiframe — fal is the licensed one
//   WORKERS         concurrent runs across all customers (4)
//   PER_USER        concurrent runs per customer (2)
//   ADMIN_TOKEN     required by /api/admin/*; without it, admin is disabled
//   SIGNUP_CREDITS  credits granted on signup (0 — free credits invite abuse)
//   WEB_DIR         built UI to serve (./web/dist)
//   PIPELINE_MODE   `demo` swaps the generator for pre-rendered samples: no
//                   API keys, no child processes, nothing to spend. Everything
//                   else — accounts, credits, the queue — stays real.
//   COOKIE_PATH     scope of the session cookie (/) — set to the URL prefix
//                   when the app is served under one
//   MAX_ACCOUNTS    refuse signups past this many (0 = no limit)
//   MAX_CHARACTERS  per account (0 = no limit)

const fs = require('fs');
const http = require('http');
const path = require('path');

const { EventLog } = require('./lib/events');
const { Ledger } = require('./lib/ledger');
const { Accounts } = require('./lib/accounts');
const { Sessions } = require('./lib/sessions');
const { Queue } = require('./lib/queue');
const { Pipeline } = require('./lib/pipeline');
const { DemoPipeline } = require('./lib/demo-pipeline');
const { Workspaces, OUTPUT_EXTS } = require('./lib/workspace');
const { Jobs } = require('./lib/jobs');

const PORT = Number(process.env.PORT) || 5180;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PIPELINE = path.resolve(process.env.PIPELINE || path.join(__dirname, '..', 'diablow', 'scripts', 'generate-sprites.js'));
const PROVIDER = process.env.PROVIDER || 'fal';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const SIGNUP_CREDITS = Number(process.env.SIGNUP_CREDITS) || 0;
const WEB_DIR = path.resolve(process.env.WEB_DIR || path.join(__dirname, 'web', 'dist'));
const DEMO = process.env.PIPELINE_MODE === 'demo';
const COOKIE_PATH = process.env.COOKIE_PATH || '/';
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS) || 0;
const MAX_CHARACTERS = Number(process.env.MAX_CHARACTERS) || 0;

const MIME = {
  '.png': 'image/png', '.json': 'application/json', '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json'
};

// A cross-site form post cannot set a custom header, and a cross-origin XHR
// that tries triggers a CORS preflight this server never answers. Combined
// with SameSite=Strict cookies that is CSRF covered, with no token plumbing
// and nothing to configure differently in development.
const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'spriteforge';

// ---- wiring -----------------------------------------------------------------

// In demo mode the style and presets are bundled, so the container does not
// need the game repo at all.
const { SPRITE_STYLE, PRESET_ANIMATIONS } = DEMO
  ? require('./demo/prompts.js')
  : require(path.join(path.dirname(PIPELINE), 'sprite-prompts.js'));

const ledger = new Ledger(new EventLog(path.join(DATA_DIR, 'credits.jsonl')));
const accounts = new Accounts(new EventLog(path.join(DATA_DIR, 'accounts.jsonl')));
const sessions = new Sessions({ file: path.join(DATA_DIR, 'sessions.jsonl'), cookiePath: COOKIE_PATH });
const workspaces = new Workspaces({
  root: path.join(DATA_DIR, 'workspaces'),
  style: SPRITE_STYLE,
  presets: PRESET_ANIMATIONS
});
const pipeline = DEMO
  ? new DemoPipeline({ samplesDir: path.join(__dirname, 'demo', 'samples'), workspaces })
  : new Pipeline({ scriptPath: PIPELINE, provider: PROVIDER });
// The runner is attached by Jobs, which needs the queue to construct.
const queue = new Queue({
  run: () => { throw new Error('runner not attached'); },
  workers: Number(process.env.WORKERS) || 4,
  perUser: Number(process.env.PER_USER) || 2
});
const jobs = new Jobs({ queue, ledger, pipeline, workspaces });

// ---- http helpers -----------------------------------------------------------

function httpError(status, message, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': json ? 'application/json' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(json ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { reject(httpError(413, 'Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(httpError(400, 'Invalid JSON')); }
    });
  });
}

// Behind Caddy the connection to us is plain http, so the forwarded header is
// what says whether the browser is on https.
const isSecure = req =>
  (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' ||
  !!req.socket.encrypted;

// Either a Bearer API key (machine clients) or a session cookie (the web UI).
// Returns { user, viaCookie }.
function authenticate(req) {
  const header = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(header)) {
    const user = accounts.authenticate(header.replace(/^Bearer\s+/i, '').trim());
    if (!user) throw httpError(401, 'A valid API key is required');
    return { user, viaCookie: false };
  }
  const token = Sessions.read(req.headers.cookie);
  const userId = token && sessions.lookup(token, id => accounts.credentialVersion(id));
  const user = userId && accounts.user(userId);
  if (!user) throw httpError(401, 'Please sign in');
  return { user, viaCookie: true };
}

// Only cookie-authenticated mutations need this: CSRF requires the browser to
// attach credentials by itself, which an API key never is.
function assertNotForged(req, viaCookie) {
  if (!viaCookie || req.method === 'GET' || req.method === 'HEAD') return;
  if (String(req.headers[CSRF_HEADER] || '').toLowerCase() !== CSRF_VALUE) {
    throw httpError(403, 'Missing X-Requested-With header');
  }
}

function requireAdmin(req) {
  if (!ADMIN_TOKEN) throw httpError(404, 'Admin is not enabled');
  const given = String(req.headers['x-admin-token'] || '');
  if (given.length !== ADMIN_TOKEN.length || given !== ADMIN_TOKEN) throw httpError(403, 'Forbidden');
}

function meFor(userId) {
  return {
    user: accounts.publicUser(userId),
    balance: ledger.balance(userId),
    keys: accounts.listKeys(userId)
  };
}

// ---- static -----------------------------------------------------------------

// The built React app. Hashed assets are immutable; index.html never is, or a
// deploy would not be visible until the browser felt like it.
function serveWeb(req, res, pathname) {
  if (!fs.existsSync(WEB_DIR)) {
    return send(res, 503, 'The web UI has not been built yet. Run `npm run build` in web/.');
  }
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.resolve(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR + path.sep) && file !== path.join(WEB_DIR, 'index.html')) {
    return send(res, 403, 'Forbidden');
  }
  // Single page app: anything that is not a real file is handled client-side.
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIR, 'index.html');
  const ext = path.extname(file).toLowerCase();
  const immutable = /\/assets\//.test(file.replace(/\\/g, '/'));
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
}

// ---- routes -----------------------------------------------------------------

async function route(req, res, url) {
  const r = `${req.method} ${url.pathname}`;

  if (r === 'GET /api/health') {
    return send(res, 200, { ok: true, demo: DEMO, provider: DEMO ? 'demo' : PROVIDER, sessions: sessions.count(), ...queue.stats() });
  }

  // What the UI needs before anyone signs in — notably whether to show the
  // demo banner, so the page never implies real generation.
  if (r === 'GET /api/config') {
    return send(res, 200, { demo: DEMO, signupCredits: SIGNUP_CREDITS, full: MAX_ACCOUNTS > 0 && accounts.users.size >= MAX_ACCOUNTS });
  }

  // --- unauthenticated -------------------------------------------------------

  // Signing up logs you straight in: a confirmation step with nothing to
  // confirm is just a place to lose people.
  if (r === 'POST /api/auth/signup') {
    // A public demo is a public disk. Cap it rather than discover the limit.
    if (MAX_ACCOUNTS > 0 && accounts.users.size >= MAX_ACCOUNTS) {
      throw httpError(503, 'The demo is full for now — try again later');
    }
    const { email, password } = await readBody(req);
    const user = await accounts.createUser(email, String(password || ''));
    if (SIGNUP_CREDITS > 0) ledger.grant(user.id, SIGNUP_CREDITS, { source: 'signup' });
    const token = sessions.create(user.id, accounts.credentialVersion(user.id));
    return send(res, 201, meFor(user.id), { 'Set-Cookie': sessions.cookie(token, { secure: isSecure(req) }) });
  }

  if (r === 'POST /api/auth/login') {
    const { email, password } = await readBody(req);
    const user = await accounts.verify(email, password);
    // One message for both "no such account" and "wrong password".
    if (!user) throw httpError(401, 'That email and password do not match');
    const token = sessions.create(user.id, accounts.credentialVersion(user.id));
    return send(res, 200, meFor(user.id), { 'Set-Cookie': sessions.cookie(token, { secure: isSecure(req) }) });
  }

  if (r === 'POST /api/auth/logout') {
    const token = Sessions.read(req.headers.cookie);
    sessions.destroy(token);
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessions.clearCookie({ secure: isSecure(req) }) });
  }

  if (r === 'POST /api/admin/grant') {
    requireAdmin(req);
    const { email, credits, meta } = await readBody(req);
    const user = accounts.userByEmail(email);
    if (!user) throw httpError(404, `No account for ${email}`);
    // meta is spread first: a caller must not be able to overwrite the
    // provenance marker the audit trail relies on.
    ledger.grant(user.id, Math.round(Number(credits)), { ...(meta || {}), source: 'admin' });
    return send(res, 200, { user: user.email, balance: ledger.balance(user.id) });
  }

  // --- authenticated ---------------------------------------------------------

  const { user, viaCookie } = authenticate(req);
  assertNotForged(req, viaCookie);

  if (r === 'GET /api/me' || r === 'GET /api/auth/me') return send(res, 200, meFor(user.id));
  if (r === 'GET /api/balance') return send(res, 200, ledger.balance(user.id));
  if (r === 'GET /api/history') return send(res, 200, ledger.history(user.id));

  if (r === 'POST /api/auth/password') {
    const { current, password } = await readBody(req);
    // Proving the current password is what stops a stolen session from
    // becoming a permanent takeover.
    if (!(await accounts.verify(user.email, current))) throw httpError(403, 'Your current password is wrong');
    await accounts.setPassword(user.id, String(password || ''));
    sessions.destroyAllFor(user.id);   // every other device is logged out
    const token = sessions.create(user.id, accounts.credentialVersion(user.id));
    return send(res, 200, { ok: true }, { 'Set-Cookie': sessions.cookie(token, { secure: isSecure(req) }) });
  }

  if (r === 'POST /api/keys') {
    const { label } = await readBody(req);
    return send(res, 201, accounts.issueKey(user.id, label || ''));
  }

  const keyMatch = url.pathname.match(/^\/api\/keys\/([\w-]+)$/);
  if (keyMatch && req.method === 'DELETE') {
    accounts.revokeKey(user.id, keyMatch[1]);
    return send(res, 200, { revoked: keyMatch[1] });
  }

  // What the "new character" form offers: the house style and some motions.
  if (r === 'GET /api/presets') {
    return send(res, 200, { style: SPRITE_STYLE, animations: PRESET_ANIMATIONS });
  }

  if (r === 'GET /api/characters') return send(res, 200, workspaces.listCharacters(user.id));

  if (r === 'POST /api/characters') {
    const body = await readBody(req);
    const existing = workspaces.listCharacters(user.id);
    // Overwriting one of your own is always allowed; only growing the set is capped.
    if (MAX_CHARACTERS > 0 && existing.length >= MAX_CHARACTERS && !existing.some(c => c.id === body.id)) {
      throw httpError(409, `This account is limited to ${MAX_CHARACTERS} characters`);
    }
    return send(res, 201, workspaces.saveCharacter(user.id, body));
  }

  if (r === 'POST /api/quote') return send(res, 200, await jobs.quote(user.id, await readBody(req)));
  if (r === 'POST /api/jobs') return send(res, 202, await jobs.submit(user.id, await readBody(req)));
  if (r === 'GET /api/jobs') return send(res, 200, jobs.list(user.id));

  const jobMatch = url.pathname.match(/^\/api\/jobs\/(\d+)$/);
  if (jobMatch) {
    const job = req.method === 'DELETE' ? jobs.cancel(user.id, jobMatch[1]) : jobs.get(user.id, jobMatch[1]);
    if (!job) throw httpError(404, 'No such job');
    return send(res, 200, job);
  }

  // Downloads are the product. Only the three output files are reachable:
  // _work (raw provider frames and the paid-job cache) is never served.
  const dl = url.pathname.match(/^\/api\/download\/([a-z0-9_-]+)\/([a-z0-9_-]+)\.(\w+)$/);
  if (dl && req.method === 'GET') {
    const [, character, anim, ext] = dl;
    if (!OUTPUT_EXTS.includes(ext)) throw httpError(404, 'Not a downloadable file');
    // A download url is either a file or it is not. Answering 404 rather than
    // "invalid animation name" keeps probing uninformative.
    let file;
    try { file = workspaces.outputPath(user.id, character, anim, ext); }
    catch { throw httpError(404, 'Not generated yet'); }
    if (!file) throw httpError(404, 'Not generated yet');
    const stat = fs.statSync(file);
    const inline = url.searchParams.get('inline') === '1';
    res.writeHead(200, {
      'Content-Type': MIME['.' + ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      // The UI previews the webp inline; a download button wants an attachment.
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${character}-${anim}.${ext}"`,
      'Cache-Control': 'no-store'
    });
    return fs.createReadStream(file).pipe(res);
  }

  throw httpError(404, 'No such endpoint');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  // Everything outside /api is the single page app.
  if (!url.pathname.startsWith('/api/')) {
    try { return serveWeb(req, res, url.pathname); }
    catch (e) { console.error('[web]', e); return send(res, 500, 'Internal error'); }
  }
  try {
    await route(req, res, url);
  } catch (e) {
    // A thrown ledger/queue/workspace error is a client mistake unless it says
    // otherwise; anything unrecognised is ours and is not echoed back.
    const known = { INSUFFICIENT_CREDITS: 402, NOTHING_TO_DO: 409, NO_SUCH_CHARACTER: 404, ESTIMATE_FAILED: 400, INVALID: 400 };
    const status = e.status || known[e.code] || (e.code ? 400 : 500);
    // An explicit status is a decision we made ("the demo is full"), not a
    // fault. Only unrecognised errors are worth a stack trace in the log.
    if (status >= 500 && !e.status) console.error(`[${status}] ${req.method} ${url.pathname}:`, e);
    const body = { error: status >= 500 ? 'Internal error' : e.message };
    if (e.code) body.code = e.code;
    if (e.available != null) { body.available = e.available; body.need = e.need; }
    if (!res.headersSent) send(res, status, body);
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`SpriteForge → http://localhost:${PORT}`);
    console.log(DEMO
      ? '  pipeline  DEMO — pre-rendered samples, no provider, no API keys, nothing to spend'
      : `  pipeline  ${PIPELINE}`);
    if (!DEMO) console.log(`  provider  ${PROVIDER}`);
    console.log(`  data      ${DATA_DIR}`);
    console.log(`  web       ${fs.existsSync(WEB_DIR) ? WEB_DIR : WEB_DIR + '  (not built — run npm run build in web/)'}`);
    console.log(`  admin     ${ADMIN_TOKEN ? 'enabled' : 'disabled (set ADMIN_TOKEN)'}`);
  });
}

module.exports = { server, ledger, accounts, sessions, jobs, workspaces, queue };
