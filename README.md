# SpriteForge

Hosted animated sprite sheets: a prompt in, a looping sheet with a real alpha
channel and a TexturePacker atlas out.

The generator is **not** in this repo. It is
`../diablow/scripts/generate-sprites.js`, unchanged, run as a child process in
one workspace per customer. Everything here is the part that makes it a
business: who you are, what you have paid for, whose turn it is, and what you
are allowed to download.

```
npm run setup             # install + build the React UI (once)
npm start                 # → http://localhost:5180
npm test                  # 7 suites, 337 checks, spends nothing
```

Then sign up in the browser and fund the account:

```
ADMIN_TOKEN=... npm run grant -- dev@example.com 500 "launch promo"
```

### Working on the UI

```
npm start                 # API on 5180
npm run dev               # UI on 5173, proxying /api to 5180
```

The dev server proxies `/api`, so the browser sees one origin and the session
cookie behaves exactly as it does in production.

## Why the pipeline is a child process, not an import

It is a CLI with module-scope state — the chosen provider, the workspace path.
One process per job keeps customers isolated, makes a cancel a kill, and is
exactly how the local Sprite Studio already drives it, so the contract is
already proven in use.

The only changes needed on the pipeline side were two environment variables:
`SPRITE_WORKSPACE` (where this customer's characters live) and
`SPRITE_BUILTINS=0` (so nobody inherits DIABLOW's own cast).

## Billing: the charge is not the estimate

A sprite's true cost is only known after the run, so credits move in three
phases:

| | |
| --- | --- |
| `reserve` | holds the quote, so two jobs queued at once cannot spend the same balance |
| `settle` | the hold becomes a spend of what actually happened; the remainder returns |
| `release` | the hold is cancelled — nothing ran |

The actual figure comes from pricing the same job **again** after the run.
A dry run reports what is *still* unpaid, so:

```
charge = estimate_before - estimate_after
```

That is derived from the pipeline's own paid-job cache rather than from parsing
log lines or trusting an exit code. A run that produced three of four
animations bills for three. A run that died after the keyframe bills for the
keyframe. A run that produced nothing is free.

One bias is deliberate and in the customer's favour: a clip that was paid for
but whose download was interrupted still reads as unpaid, so we under-charge
and absorb it. The pipeline's pay-once cache means the retry resumes that same
provider job rather than buying a second one, so the money is not lost twice.

**1 credit = $0.01 of provider spend** — the same unit the pipeline prints, so
a plan's "~39 credits" *is* the charge. Credits are integers: money in floats
is a bug waiting for a rounding boundary.

### The ledger is append-only

Balances are derived by replaying `data/credits.jsonl`. Nothing is ever
mutated, so "why is my balance 318?" has a literal answer and a pricing bug
stays recoverable after the code that caused it is fixed. A half-written line
is fatal on startup rather than silently skipped — under-reporting what
customers are owed is not a recoverable error.

> ⚠️ **One writer only.** Balances live in memory and are rebuilt from the file
> at startup. A second process appending to `credits.jsonl` would leave the
> server serving stale balances until it restarted, and "stale" here means a
> customer's credits are missing. `npm run grant` therefore goes over HTTP to
> the running server instead of touching the file. Do not run two instances
> against one `DATA_DIR`.

Durability is `appendFileSync`: a crash loses at most the event being written
and cannot corrupt earlier ones. It is not fsync'd per write and not
replicated. Put `data/` on a snapshotted volume, and move to Postgres once
there is enough revenue to be worth protecting properly.

## Scheduling: two different constraints

**One job per (user, character)** is correctness. A character's
`_work/state.json` has exactly one writer; two runs on the same character race
over the paid-job cache and can pay twice for the same clip. The local studio
avoided this by running one job at a time *globally* — too strict with
customers, but per character it still holds.

**N jobs per user** is fairness. Worker slots are finite and one customer
generating a twelve-animation cast must not starve everybody else.

A blocked job never stalls the ones behind it: the scheduler scans for the
first *eligible* job rather than looking only at the head. With per-user caps,
head-of-line blocking is the default failure mode, so there is a test for it.

## Auth

Two mechanisms, for two audiences:

- **Session cookies** for the web UI. `HttpOnly`, `SameSite=Strict`, 30 days,
  stored as SHA-256 hashes so a leaked `sessions.jsonl` cannot assume a
  session. Persisted rather than in memory, because this gets deployed often
  and logging every customer out on each deploy is a bad trade for thirty
  lines. Changing a password bumps a credential version, which invalidates
  every existing session for that user.
- **API keys** (`Authorization: Bearer sf_…`) for scripts and build steps,
  issued from the Account tab. Shown once, stored as a SHA-256 hash.

Passwords use **scrypt**; API keys and session tokens use bare **SHA-256**.
That is deliberate, not an inconsistency: a key is 32 bytes of CSPRNG output,
so there is no dictionary to attack and the lookup runs on every request. A
password is human-chosen and reused across sites, so it has to be expensive to
guess.

**CSRF** is covered by one header. Writes authenticated by a cookie must carry
`X-Requested-With: spriteforge`. A cross-site form post cannot set a custom
header, and a cross-origin XHR that tries triggers a preflight this server
never answers. API keys are exempt, because CSRF needs ambient credentials and
a key never is. Nothing differs between development and production.

Login answers the same message for "no such account" and "wrong password", and
spends comparable time on both, so neither reveals whether an email is
registered.

## API

| | |
| --- | --- |
| `POST /api/auth/signup` | `{email, password}` → signs in. Grants **no** credits by default. |
| `POST /api/auth/login` · `POST /api/auth/logout` | |
| `POST /api/auth/password` | `{current, password}` — signs out every other device |
| `GET /api/me` | account, balance, keys |
| `GET /api/balance` · `GET /api/history` | credits now, and every movement |
| `POST /api/keys` · `DELETE /api/keys/:id` | issue / revoke |
| `GET /api/presets` | the house style and some starting motions |
| `GET /api/characters` · `POST /api/characters` | the customer's cast |
| `POST /api/quote` | what a job would cost. Free: it is a dry run. |
| `POST /api/jobs` | reserve and queue. `402` with `need`/`available` if short. |
| `GET /api/jobs` · `GET /api/jobs/:id` · `DELETE /api/jobs/:id` | list, poll, cancel |
| `GET /api/download/:character/:anim.(png\|json\|webp)` | the product; `?inline=1` to preview |
| `POST /api/admin/grant` | `X-Admin-Token`; `{email, credits}` |

Only those three output files per animation are ever reachable. `_work` — the
raw provider frames and the paid-job cache — is never served. Everything
outside `/api/` serves the built UI.

## The UI

React, built with Vite into `web/dist`, served by `server.js`. Three screens:

- **Auth** — sign up or sign in; signing up logs you straight in, because
  there is nothing to confirm.
- **Studio** — your cast on the left; pick a character, tick the animations
  you want, see the price, generate. The quote updates as you change the
  selection (debounced — each quote is a real dry run). A running job shows its
  live log; finished animations show the animated `.webp` preview over a
  checkerboard with `png` / `json` / `webp` download buttons.
- **Account** — balance breakdown, full billing history, API keys, password.

The generate form defaults to whatever has *not* been generated yet, since the
common case is finishing a character rather than redoing it. Regenerating
existing clips is a separate checkbox that says it costs full price again.

## The public demo

Live at **https://aislop.cloud/spriteforge/** — deployed with
`node C:\sites\aislop\deploy.js C:\sites\spriteforge`.

`PIPELINE_MODE=demo` swaps the generator for [lib/demo-pipeline.js](lib/demo-pipeline.js),
which holds no API key, spawns no child process and calls no provider. There is
nothing in that image that can spend money, which is the only safe way to put
"click here to generate" on a page anyone can reach. `ADMIN_TOKEN` is left
unset, so `/api/admin/*` answers 404 and the demo has no privileged surface at
all.

Everything around the generator stays real — accounts, sessions, the credit
ledger, reserve/settle, the queue with its per-user cap and per-character lock —
because those are the production classes, untouched. What is faked is narrow
and stated on the page: `estimate()` prices from the same table (4 for the
keyframe, 35 per clip) and treats an existing sheet as paid for, so
`charge = before − after` still comes out right; `run()` waits, logs, and copies
a pre-rendered sample chosen by hashing the character and animation name. The
sample has nothing to do with the prompt, and the banner says so.

The sample sheets in `demo/samples/` are real output from the real pipeline —
DIABLOW's own skeleton, warrior and ghoul — so the atlas, pivot and alpha a
visitor downloads are genuine. Their `meta.demo` flag marks them, and the
absolute Windows path in `meta.source.video` is stripped.

### Serving under a path prefix

aislop.cloud gives each project `/<slug>/` and **strips the prefix before
forwarding**, so the browser and the server see different paths. Three things
follow, and all three have tests:

- Vite builds with `base: './'`, so assets resolve relative to the prefix.
- `api.js` resolves against `document.baseURI`, so the browser asks for
  `/spriteforge/api/…` while the server still sees `/api/…`.
- `COOKIE_PATH=/spriteforge/` scopes the session cookie to the project. With
  the default `/` it would be sent to every other project on the domain.

`test-demo.js` runs the whole demo behind a proxy that mimics that strip, which
is how those were caught before deploying rather than after.

Data lives inside the container, so **every deploy wipes it**. For a demo that
is the point; the banner tells visitors not to reuse a password.

Limits for a public page: `MAX_ACCOUNTS=400`, `MAX_CHARACTERS=8`,
`SIGNUP_CREDITS=2000`, `WORKERS=2`, `PER_USER=1`. The container caps at 128 MB
and sits around 30 MB in practice.

## Configuration

| | |
| --- | --- |
| `PORT` | 5180 |
| `DATA_DIR` | `./data` — ledger, accounts, sessions, workspaces |
| `PIPELINE` | path to `generate-sprites.js` |
| `PROVIDER` | `fal` (default, licensed) or `apiframe` |
| `WORKERS` · `PER_USER` | 4 · 2 |
| `ADMIN_TOKEN` | required by `/api/admin/*`; unset disables admin entirely |
| `SIGNUP_CREDITS` | 0 — free credits invite abuse, and a key with no credits costs us nothing |
| `WEB_DIR` | `./web/dist` |
| `PIPELINE_MODE` | `demo` swaps the generator for pre-rendered samples |
| `COOKIE_PATH` | `/` — set to the URL prefix when served under one |
| `MAX_ACCOUNTS` · `MAX_CHARACTERS` | 0 = no limit |

Provider keys (`FAL_KEY`) come from the environment. `--dry-run`, and therefore
`/api/quote`, needs none.

**Use `PROVIDER=fal`.** Apiframe is an unofficial Midjourney proxy: fine for
generating art for our own game, not something to resell. See
`../diablow/scripts/PROVIDERS.md`.

## Tests

```
npm test
```

| | |
| --- | --- |
| `test-ledger.js` | 39 — overselling, double settles, restart replay, a damaged log |
| `test-accounts.js` | 65 — passwords, keys, revocation, and that neither hits disk in plaintext |
| `test-sessions.js` | 37 — expiry, logout, password-change invalidation, cookie flags |
| `test-queue.js` | 29 — worker and per-user caps, the character lock, head-of-line blocking |
| `test-jobs.js` | 36 — what a partial, failed, or unmeasurable run costs |
| `test-http.js` | 87 — the stack end to end, including a real `--dry-run` quote and CSRF |
| `test-demo.js` | 44 — the public demo behind a simulated aislop.cloud path prefix |

None of them spend a credit. The queue and billing suites inject a fake
pipeline; `test-http.js` drives the real one, but only through `--dry-run`.

## Not built yet

- **Payments.** `POST /api/admin/grant` is the whole billing system. A Stripe
  webhook calling `ledger.grant(user, credits, {source: 'stripe:pi_...'})` is
  the missing piece, and the grant already carries provenance for it. The
  Account tab says so plainly rather than pretending.
- **Password reset.** No email is sent anywhere, so a forgotten password needs
  an operator. Email delivery is the real dependency here, not the token.
- **Editing a character.** `POST /api/characters` overwrites by id, but the UI
  only offers create. Changing a description after generating would also need a
  rule for what that does to existing sheets.
- **Restart recovery for in-flight jobs.** Queue state is in memory: a restart
  mid-run leaves an open hold. The ledger makes these findable (`balance.held`
  with no running job), but nothing reconciles them automatically yet.
- **Rate limiting.** Signup is open and quoting spawns a process. Signup grants
  nothing, so the exposure is rows in a log rather than money, but both are
  unmetered.
- **Verifying fal's prices.** The figures in `../diablow/scripts/lib/providers.js`
  are list prices read on 2026-09-30. Re-check them before charging anyone.

## Built with

Written with [Claude Code](https://claude.com/claude-code). Model: Claude Opus 5 (`claude-opus-5`), 2026-10-01 to 2026-10-04.

Play it at https://aislop.cloud/spriteforge/. Part of the [aislop.cloud](https://aislop.cloud) portfolio.
