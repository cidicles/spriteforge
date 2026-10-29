// The public demo, end to end, behind a simulated aislop.cloud path prefix.
//
// Two things are proved here that nothing else covers:
//   1. demo mode generates nothing, calls no provider and still bills correctly
//   2. the app works at /spriteforge/ — Caddy strips the prefix before
//      forwarding, so the browser and the server see different paths

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-demo-'));
process.env.DATA_DIR = DATA_DIR;
process.env.PIPELINE_MODE = 'demo';
process.env.SIGNUP_CREDITS = '2000';
process.env.COOKIE_PATH = '/spriteforge/';
process.env.MAX_ACCOUNTS = '3';
process.env.MAX_CHARACTERS = '2';
process.env.DEMO_STEP_MS = '40';
delete process.env.ADMIN_TOKEN;

const { server } = require('../server');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
};
const eq = (label, a, b) => ok(label, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`);

const PREFIX = '/spriteforge';
let appBase, proxyBase;

// Stands in for Caddy: serves the app at /spriteforge/ and strips the prefix
// before forwarding, exactly as the real deployment does.
function startProxy(target) {
  return new Promise(resolve => {
    const proxy = http.createServer((req, res) => {
      if (!req.url.startsWith(PREFIX)) { res.writeHead(404); return res.end('not this project'); }
      const stripped = req.url.slice(PREFIX.length) || '/';
      const upstream = http.request(target + stripped, { method: req.method, headers: req.headers }, up => {
        res.writeHead(up.statusCode, up.headers);
        up.pipe(res);
      });
      req.pipe(upstream);
    });
    proxy.listen(0, () => resolve(proxy));
  });
}

function client(base) {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    async call(method, p, { body, raw } = {}) {
      const headers = { 'X-Requested-With': 'spriteforge' };
      if (body) headers['Content-Type'] = 'application/json';
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(base + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
      for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
        const pair = c.split(';')[0];
        if (pair.startsWith('sf_session=')) { cookie = pair.endsWith('=') ? null : pair; this.lastSetCookie = c; }
      }
      if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, body: json, text };
    }
  };
}

const PW = 'correct horse battery';
const CHARACTER = {
  id: 'hero', name: 'Hero',
  subject: 'a knight in battered plate armour holding a longsword',
  animations: [
    { name: 'idle', motion: 'The knight breathes in a ready stance.', frames: 16, fps: 8, cycle: true },
    { name: 'walk', motion: 'The knight walks in place with a full stride.', frames: 12, fps: 12, cycle: true }
  ]
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  await new Promise(r => server.listen(0, r));
  appBase = `http://127.0.0.1:${server.address().port}`;
  const proxy = await startProxy(appBase);
  proxyBase = `http://127.0.0.1:${proxy.address().port}${PREFIX}`;

  console.log('\ndemo mode is announced');
  {
    const c = client(proxyBase);
    const cfg = await c.call('GET', '/api/config');
    eq('config says demo', cfg.body.demo, true);
    eq('and advertises the signup grant', cfg.body.signupCredits, 2000);
    const health = await c.call('GET', '/api/health');
    eq('health reports the demo provider', health.body.provider, 'demo');
  }

  console.log('\nno privileged surface exists');
  {
    const c = client(proxyBase);
    const r = await c.call('POST', '/api/admin/grant', { body: { email: 'a@b.com', credits: 999 } });
    eq('admin is 404 without ADMIN_TOKEN', r.status, 404);
  }

  console.log('\nthe app works under a stripped path prefix');
  const c = client(proxyBase);
  {
    const page = await c.call('GET', '/', { raw: true });
    eq('the page is served at /spriteforge/', page.status, 200);
    ok('its asset urls are relative', /src="\.\/assets\/|href="\.\/assets\//.test(page.text), page.text.match(/<script[^>]*>/)?.[0]);
    const asset = page.text.match(/\.\/(assets\/index-[\w-]+\.js)/)[1];
    eq('and resolve through the prefix', (await c.call('GET', '/' + asset, { raw: true })).status, 200);

    const up = await c.call('POST', '/api/auth/signup', { body: { email: 'demo@example.com', password: PW } });
    eq('signup works through the proxy', up.status, 201);
    eq('and grants demo credits', up.body.balance.available, 2000);
    ok('the cookie is scoped to the prefix', /Path=\/spriteforge\//.test(c.lastSetCookie), c.lastSetCookie);
    eq('the session is usable', (await c.call('GET', '/api/me')).status, 200);
  }

  console.log('\ngenerating produces a sample sheet and bills for it');
  {
    await c.call('POST', '/api/characters', { body: CHARACTER });
    const quote = await c.call('POST', '/api/quote', { body: { sprite: 'hero', anims: ['idle', 'walk'] } });
    // keyframe 4 + two clips at 35
    eq('priced like the real thing', quote.body.credits, 74);
    ok('the plan names the demo provider', /provider: demo/.test(quote.body.plan));

    const job = await c.call('POST', '/api/jobs', { body: { sprite: 'hero', anims: ['idle', 'walk'] } });
    eq('the job is accepted', job.status, 202);
    eq('and the quote is held', (await c.call('GET', '/api/balance')).body.held, 74);

    let done = null;
    for (let i = 0; i < 100 && !done; i++) {
      await sleep(100);
      const j = await c.call('GET', `/api/jobs/${job.body.id}`);
      if (j.body.status !== 'queued' && j.body.status !== 'running') done = j.body;
    }
    eq('it finishes', done && done.status, 'done');
    ok('the log says nothing was generated', /no provider was called/.test(done.log), done.log.slice(-200));
    eq('and it charges the full quote', done.charged, 74);
    ok('measured from the pipeline, not assumed', done.billingMeasured === true);

    const bal = await c.call('GET', '/api/balance');
    eq('the balance settles', [bal.body.spent, bal.body.held, bal.body.available], [74, 0, 1926]);
  }

  console.log('\nthe sheets are real files and download through the prefix');
  {
    const chars = await c.call('GET', '/api/characters');
    const hero = chars.body.find(x => x.id === 'hero');
    eq('both animations report output', hero.animations.filter(a => a.output).length, 2);
    for (const ext of ['png', 'json', 'webp']) {
      const r = await c.call('GET', `/api/download/hero/idle.${ext}`, { raw: true });
      eq(`${ext} downloads`, r.status, 200);
      ok(`${ext} is not empty`, r.text.length > 500, `${r.text.length} bytes`);
    }
    const atlas = JSON.parse((await c.call('GET', '/api/download/hero/idle.json', { raw: true })).text);
    ok('the atlas is a real TexturePacker hash', !!atlas.frames && !!atlas.meta);
    eq('and is marked as a sample', atlas.meta.demo, true);
    ok('with a pivot at the feet', Object.values(atlas.frames)[0].pivot.y > 0.9);
  }

  console.log('\nre-running is free, because nothing is left to make');
  {
    const again = await c.call('POST', '/api/quote', { body: { sprite: 'hero', anims: ['idle', 'walk'] } });
    eq('the quote drops to zero', again.body.credits, 0);
    const refused = await c.call('POST', '/api/jobs', { body: { sprite: 'hero', anims: ['idle', 'walk'] } });
    eq('and the job is refused rather than billed', refused.status, 409);
    eq('with a reason', refused.body.code, 'NOTHING_TO_DO');
  }

  console.log('\nthe same sprite comes back for the same name');
  {
    const first = (await c.call('GET', '/api/download/hero/idle.png', { raw: true })).text.length;
    await c.call('POST', '/api/characters', { body: { ...CHARACTER, id: 'hero2', name: 'Hero Two' } });
    const j = await c.call('POST', '/api/jobs', { body: { sprite: 'hero2', anims: ['idle'] } });
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      const s = await c.call('GET', `/api/jobs/${j.body.id}`);
      if (s.body.status === 'done') break;
    }
    const other = (await c.call('GET', '/api/download/hero2/idle.png', { raw: true })).text.length;
    ok('a different character can get a different sample', typeof other === 'number' && other > 500);
    ok('and the first one is unchanged', (await c.call('GET', '/api/download/hero/idle.png', { raw: true })).text.length === first);
  }

  console.log('\npublic-demo limits hold');
  {
    const third = await c.call('POST', '/api/characters', { body: { ...CHARACTER, id: 'hero3', name: 'Hero Three' } });
    eq('a third character is refused', third.status, 409);
    ok('with a reason a visitor can read', /limited to 2 characters/.test(third.body.error));
    const overwrite = await c.call('POST', '/api/characters', { body: { ...CHARACTER, name: 'Renamed' } });
    eq('but overwriting your own is still allowed', overwrite.status, 201);

    const b = client(proxyBase);
    eq('a second account is fine', (await b.call('POST', '/api/auth/signup', { body: { email: 'b@example.com', password: PW } })).status, 201);
    const d = client(proxyBase);
    eq('a third is fine', (await d.call('POST', '/api/auth/signup', { body: { email: 'd@example.com', password: PW } })).status, 201);
    const e = client(proxyBase);
    const full = await e.call('POST', '/api/auth/signup', { body: { email: 'e@example.com', password: PW } });
    eq('the fourth is turned away', full.status, 503);
    eq('and config advertises that it is full', (await e.call('GET', '/api/config')).body.full, true);
  }

  console.log('\ntenants are still isolated in the demo');
  {
    const b = client(proxyBase);
    await b.call('POST', '/api/auth/login', { body: { email: 'b@example.com', password: PW } });
    eq('a stranger sees no characters', (await b.call('GET', '/api/characters')).body, []);
    eq('and cannot fetch another tenant\'s sheet', (await b.call('GET', '/api/download/hero/idle.png')).status, 404);
  }

  server.close();
  proxy.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
