// End-to-end over HTTP against the real pipeline.
//
// Nothing here spends a credit: /api/quote runs generate-sprites.js with
// --dry-run, which needs no API key and submits no jobs. Job submission is
// exercised only on the paths that refuse it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-http-'));
process.env.DATA_DIR = DATA_DIR;
process.env.ADMIN_TOKEN = 'test-admin-token';
process.env.PROVIDER = 'fal';

const { server } = require('../server');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

let base;

// A browser-ish client: remembers its cookie and sends the header the server
// requires on cookie-authenticated writes.
function client() {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    set cookie(v) { cookie = v; },
    async call(method, pathname, { body, key, admin, csrf = true, raw } = {}) {
      const headers = {};
      if (body) headers['Content-Type'] = 'application/json';
      if (key) headers.Authorization = `Bearer ${key}`;
      if (admin) headers['X-Admin-Token'] = admin;
      if (csrf) headers['X-Requested-With'] = 'spriteforge';
      if (cookie && !key) headers.Cookie = cookie;
      const res = await fetch(base + pathname, {
        method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual'
      });
      const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of set) {
        const pair = c.split(';')[0];
        if (pair.startsWith('sf_session=')) cookie = pair.endsWith('=') ? null : pair;
      }
      if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text, headers: res.headers, setCookie: set };
    }
  };
}

const CHARACTER = {
  id: 'hero',
  name: 'Test Hero',
  subject: 'a knight in battered plate armour holding a longsword',
  animations: [{ name: 'idle', motion: 'The knight breathes and shifts their weight in a ready stance.', frames: 16, fps: 8, cycle: true }]
};
const PW = 'correct horse battery';

(async () => {
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
  const c = client();

  console.log('\nhealth');
  {
    const r = await c.call('GET', '/api/health');
    eq('health is public', r.status, 200);
    eq('it names the provider', r.body.provider, 'fal');
  }

  console.log('\nauth is required');
  {
    const anon = client();
    for (const p of ['/api/me', '/api/characters', '/api/jobs', '/api/balance']) {
      eq(`${p} rejects an anonymous caller`, (await anon.call('GET', p)).status, 401);
    }
    eq('a bogus key is rejected', (await anon.call('GET', '/api/me', { key: 'sf_nope' })).status, 401);
    eq('a bogus cookie is rejected', (await anon.call('GET', '/api/me', { body: null })).status, 401);
  }

  console.log('\nsignup signs you in');
  let user;
  {
    const r = await c.call('POST', '/api/auth/signup', { body: { email: 'dev@example.com', password: PW } });
    eq('signup succeeds', r.status, 201);
    user = r.body.user;
    ok('a session cookie is set', c.cookie && c.cookie.startsWith('sf_session='));
    ok('the cookie is HttpOnly and SameSite=Strict', r.setCookie.some(x => /HttpOnly/.test(x) && /SameSite=Strict/.test(x)));
    eq('with no free credits by default', r.body.balance.available, 0);
    eq('no API key is handed out unasked', r.body.keys.length, 0);
    ok('the password never comes back', !r.text.includes(PW));
    eq('the session works immediately', (await c.call('GET', '/api/me')).status, 200);

    const dup = await client().call('POST', '/api/auth/signup', { body: { email: 'dev@example.com', password: PW } });
    eq('a duplicate signup is refused', dup.status, 400);
    eq('a bad email is refused', (await client().call('POST', '/api/auth/signup', { body: { email: 'nope', password: PW } })).status, 400);
    eq('a short password is refused', (await client().call('POST', '/api/auth/signup', { body: { email: 'b@c.com', password: 'short' } })).status, 400);
  }

  console.log('\nlogin and logout');
  {
    const fresh = client();
    const bad = await fresh.call('POST', '/api/auth/login', { body: { email: 'dev@example.com', password: 'wrong wrong wrong' } });
    eq('a wrong password is 401', bad.status, 401);
    const missing = await fresh.call('POST', '/api/auth/login', { body: { email: 'nobody@example.com', password: PW } });
    eq('an unknown account is also 401', missing.status, 401);
    eq('with the same message, so accounts cannot be enumerated', missing.body.error, bad.body.error);

    const good = await fresh.call('POST', '/api/auth/login', { body: { email: 'dev@example.com', password: PW } });
    eq('the right password logs in', good.status, 200);
    eq('and the session works', (await fresh.call('GET', '/api/me')).status, 200);
    await fresh.call('POST', '/api/auth/logout');
    eq('logging out clears the cookie', fresh.cookie, null);
  }

  console.log('\ncookie writes need the un-forgeable header');
  {
    const r = await c.call('POST', '/api/characters', { body: CHARACTER, csrf: false });
    eq('a cookie write without it is refused', r.status, 403);
    ok('and says why', /X-Requested-With/.test(r.body.error));
    eq('reads are unaffected', (await c.call('GET', '/api/characters', { csrf: false })).status, 200);
  }

  console.log('\ncharacters');
  {
    eq('a new workspace is empty', (await c.call('GET', '/api/characters')).body, []);
    const r = await c.call('POST', '/api/characters', { body: CHARACTER });
    eq('a character is created', r.status, 201);
    ok('the house style is appended to the prompt', r.body.prompt.includes(CHARACTER.subject) && r.body.prompt.length > CHARACTER.subject.length);
    eq('it appears in the workspace', (await c.call('GET', '/api/characters')).body.length, 1);

    eq('a bad id is refused', (await c.call('POST', '/api/characters', { body: { id: 'Bad Id!', subject: 'x', animations: CHARACTER.animations } })).status, 400);
    eq('an empty description is refused', (await c.call('POST', '/api/characters', { body: { id: 'x', subject: '', animations: CHARACTER.animations } })).status, 400);
    eq('a character with no animations is refused', (await c.call('POST', '/api/characters', { body: { id: 'x', subject: 'a thing', animations: [] } })).status, 400);
  }

  console.log('\nquoting runs the real pipeline (--dry-run, no spend)');
  {
    const r = await c.call('POST', '/api/quote', { body: { sprite: 'hero' } });
    eq('a quote is returned', r.status, 200);
    // fal: flux-schnell keyframe 2 + bria 2 + one 5s Kling clip 35.
    eq('priced from the provider tables', r.body.credits, 39);
    ok('the plan is human-readable', /keyframe flux-schnell/.test(r.body.plan));
    ok('and itemises the animation', /idle: video kling-2\.5-turbo-pro \(35 cr\)/.test(r.body.plan));
  }

  console.log('\na job with no credits is refused, not queued');
  {
    const r = await c.call('POST', '/api/jobs', { body: { sprite: 'hero' } });
    eq('payment is required', r.status, 402);
    eq('with a machine-readable code', r.body.code, 'INSUFFICIENT_CREDITS');
    eq('and the shortfall', [r.body.need, r.body.available], [39, 0]);
    eq('nothing was queued', (await c.call('GET', '/api/jobs')).body.length, 0);
    eq('and nothing was held', (await c.call('GET', '/api/balance')).body.held, 0);
  }

  console.log('\na job for a character that does not exist is refused');
  {
    const r = await c.call('POST', '/api/jobs', { body: { sprite: 'ghost' } });
    eq('404, before any pricing', r.status, 404);
    eq('with a code', r.body.code, 'NO_SUCH_CHARACTER');
  }

  console.log('\nadmin grants');
  {
    eq('admin needs the token', (await c.call('POST', '/api/admin/grant', { body: { email: 'dev@example.com', credits: 100 } })).status, 403);
    eq('a wrong token is refused', (await c.call('POST', '/api/admin/grant', { admin: 'wrong', body: { email: 'dev@example.com', credits: 100 } })).status, 403);
    const r = await c.call('POST', '/api/admin/grant', { admin: 'test-admin-token', body: { email: 'dev@example.com', credits: 100, meta: { source: 'spoofed' } } });
    eq('a grant lands', r.status, 200);
    eq('the balance reflects it', r.body.balance.available, 100);
    eq('an unknown account cannot be granted', (await c.call('POST', '/api/admin/grant', { admin: 'test-admin-token', body: { email: 'nobody@example.com', credits: 5 } })).status, 404);
  }

  console.log('\nbilling history is auditable');
  {
    const r = await c.call('GET', '/api/history');
    eq('the grant is on the record', r.body.map(e => e.type), ['grant']);
    eq('provenance cannot be spoofed by the caller', r.body[0].meta.source, 'admin');
  }

  console.log('\nAPI keys are issued from the UI and bypass CSRF');
  let apiKey;
  {
    const issued = await c.call('POST', '/api/keys', { body: { label: 'ci' } });
    eq('a key can be issued', issued.status, 201);
    apiKey = issued.body.secret;
    const byKey = client();
    eq('it authenticates with no cookie', (await byKey.call('GET', '/api/me', { key: apiKey })).status, 200);
    // An API key is never ambient, so CSRF does not apply to it.
    eq('and can write without the header', (await byKey.call('POST', '/api/characters', { key: apiKey, csrf: false, body: { ...CHARACTER, id: 'via-key' } })).status, 201);
    eq('both keys are listed', (await c.call('GET', '/api/me')).body.keys.length, 1);
    eq('it can be revoked', (await c.call('DELETE', `/api/keys/${issued.body.id}`)).status, 200);
    eq('and then stops working', (await client().call('GET', '/api/me', { key: apiKey })).status, 401);
  }

  console.log('\nchanging a password signs other devices out');
  {
    const phone = client();
    await phone.call('POST', '/api/auth/login', { body: { email: 'dev@example.com', password: PW } });
    eq('the phone is signed in', (await phone.call('GET', '/api/me')).status, 200);

    eq('the current password must be right', (await c.call('POST', '/api/auth/password', { body: { current: 'wrong wrong wrong', password: 'a brand new secret' } })).status, 403);
    const changed = await c.call('POST', '/api/auth/password', { body: { current: PW, password: 'a brand new secret' } });
    eq('changing it succeeds', changed.status, 200);
    eq('this device stays signed in', (await c.call('GET', '/api/me')).status, 200);
    eq('the phone is signed out', (await phone.call('GET', '/api/me')).status, 401);
    eq('the old password no longer logs in', (await client().call('POST', '/api/auth/login', { body: { email: 'dev@example.com', password: PW } })).status, 401);
    eq('the new one does', (await client().call('POST', '/api/auth/login', { body: { email: 'dev@example.com', password: 'a brand new secret' } })).status, 200);
  }

  console.log('\ntenant isolation');
  const other = client();
  {
    await other.call('POST', '/api/auth/signup', { body: { email: 'someone@else.com', password: PW } });
    eq('a new tenant sees an empty workspace', (await other.call('GET', '/api/characters')).body, []);
    await other.call('POST', '/api/characters', { body: { ...CHARACTER, name: 'Their Hero' } });
    eq('same-named characters do not collide', (await c.call('GET', '/api/characters')).body.find(x => x.id === 'hero').name, 'Test Hero');
    eq('each tenant sees only their own', (await other.call('GET', '/api/characters')).body[0].name, 'Their Hero');
    eq('one tenant cannot read the other\'s balance', (await other.call('GET', '/api/balance')).body.available, 0);
  }

  console.log('\nthe game\'s own characters are not visible to tenants');
  {
    const names = (await c.call('GET', '/api/characters')).body.map(x => x.id);
    ok('no skeleton or warrior leaked in', !names.includes('skeleton') && !names.includes('warrior'));
  }

  console.log('\ndownloads');
  {
    eq('an ungenerated sheet is 404', (await c.call('GET', '/api/download/hero/idle.png')).status, 404);
    eq('an unknown character is 404', (await c.call('GET', '/api/download/ghost/idle.png')).status, 404);
    eq('a non-output extension is 404', (await c.call('GET', '/api/download/hero/idle.mp4')).status, 404);
    for (const attempt of ['/api/download/hero/_work.png', '/api/download/hero/../hero/idle.png', '/api/download/_work/state.json']) {
      const r = await c.call('GET', attempt);
      ok(`${attempt} does not escape the workspace`, r.status === 404 || r.status === 400, `status ${r.status}`);
    }
    // Prove a real file would be served, without generating one.
    fs.writeFileSync(path.join(DATA_DIR, 'workspaces', user.id, 'hero', 'idle.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const good = await c.call('GET', '/api/download/hero/idle.png', { raw: true });
    eq('a generated sheet downloads', good.status, 200);
    ok('as an attachment by default', /attachment/.test(good.headers.get('content-disposition')));
    const inline = await c.call('GET', '/api/download/hero/idle.png?inline=1', { raw: true });
    ok('and inline for the preview', /inline/.test(inline.headers.get('content-disposition')));
    eq('the other tenant cannot fetch it', (await other.call('GET', '/api/download/hero/idle.png')).status, 404);
  }

  console.log('\nthe web app is served outside /api');
  {
    const built = fs.existsSync(path.join(__dirname, '..', 'web', 'dist', 'index.html'));
    const r = await c.call('GET', '/', { raw: true });
    if (!built) {
      // Not built: the server must say so plainly rather than 404.
      eq('/ explains the UI is not built', r.status, 503);
    } else {
      eq('/ serves the built app', r.status, 200);
      ok('with the React root and bundle', /<div id="root">/.test(r.text) && /assets\/index-[\w-]+\.js/.test(r.text));
      const asset = r.text.match(/assets\/index-[\w-]+\.js/)[0];
      const js = await c.call('GET', '/' + asset, { raw: true });
      eq('hashed assets are served', js.status, 200);
      ok('and cached immutably', /immutable/.test(js.headers.get('cache-control')));
      ok('index.html is not cached, so a deploy is visible', !/immutable/.test(r.headers.get('cache-control')));
      const deep = await c.call('GET', '/account', { raw: true });
      ok('unknown paths fall back to the app', deep.status === 200 && /<div id="root">/.test(deep.text));
    }
    eq('unknown API routes are still 404, not the app', (await c.call('GET', '/api/nope')).status, 404);
  }

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
