// Runs diablow's generate-sprites.js inside one customer's workspace.
//
// A child process rather than an import, for three reasons: the pipeline is a
// CLI with module-scope state (chosen provider, workspace path), one process
// per job keeps customers isolated, and a cancel can just be a kill. It is
// also how the local studio already drives it, so the contract is proven.
//
// The workspace is passed as SPRITE_WORKSPACE and the game's own built-in
// characters are suppressed, so a customer sees only their own cast.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { invalid } = require('./errors');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

class Pipeline {
  // scriptPath: .../diablow/scripts/generate-sprites.js
  constructor({ scriptPath, provider = 'fal', timeoutMs = 45 * 60 * 1000 }) {
    this.scriptPath = path.resolve(scriptPath);
    if (!fs.existsSync(this.scriptPath)) throw new Error(`No pipeline at ${this.scriptPath}`);
    this.cwd = path.dirname(path.dirname(this.scriptPath));   // the project root
    this.provider = provider;
    this.timeoutMs = timeoutMs;
  }

  env(workspace) {
    return {
      ...process.env,
      SPRITE_WORKSPACE: path.resolve(workspace),
      SPRITE_BUILTINS: '0'
    };
  }

  // Translates a validated job into CLI flags. Everything the customer can
  // influence is either an id matched against ID_RE or a bounded number —
  // nothing reaches a shell, because spawn is given an argv array.
  args(job) {
    if (!ID_RE.test(job.sprite || '')) throw invalid('Invalid character id');
    const args = [`--provider=${this.provider}`, `--id=${job.sprite}`];
    const anims = (job.anims || []).filter(a => ID_RE.test(a));
    if (anims.length) args.push(`--anim=${anims.join(',')}`);
    if (job.model) {
      if (!ID_RE.test(job.model)) throw invalid('Invalid model id');
      args.push(`--model=${job.model}`);
    }
    for (const key of ['frames', 'fps', 'height', 'variant']) {
      const v = job[key];
      if (v == null || v === '') continue;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 10000) throw invalid(`Invalid ${key}`);
      args.push(`--${key}=${n}`);
    }
    const regen = (job.regen || []).filter(r => r === 'keyframe' || r === 'video');
    if (regen.length) args.push(`--regen=${regen.join(',')}`);
    return args;
  }

  #spawn(workspace, args, onLog) {
    const child = spawn(process.execPath, [this.scriptPath, ...args], {
      cwd: this.cwd,
      env: this.env(workspace),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const collect = d => {
      const text = d.toString();
      out += text;
      if (onLog) onLog(text);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const done = new Promise(resolve => {
      const timer = setTimeout(() => {
        // A hung provider must not hold a worker slot forever. The paid job id
        // is already cached, so a retry resumes rather than re-pays.
        if (onLog) onLog('\n[timeout] killing the run\n');
        child.kill();
      }, this.timeoutMs);
      child.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, code, out }); });
      child.on('error', err => { clearTimeout(timer); resolve({ ok: false, code: null, out: out + '\n' + err.message }); });
    });
    return { child, done };
  }

  // Prices a job without spending anything. --dry-run needs no API key.
  async estimate(workspace, args) {
    const { done } = this.#spawn(workspace, [...args, '--dry-run']);
    const { ok, out } = await done;
    if (!ok) {
      const err = new Error(out.trim().split('\n').slice(-3).join(' ') || 'Could not price this job');
      err.code = 'ESTIMATE_FAILED';
      throw err;
    }
    const m = out.match(/~(\d+) credits/);
    if (!m) {
      const err = new Error('The pipeline did not report a credit total');
      err.code = 'ESTIMATE_FAILED';
      throw err;
    }
    return { credits: Number(m[1]), plan: out.trim() };
  }

  // Returns { ok, code, out } and exposes kill() through the job.
  run(workspace, args, onLog, onKill) {
    const { child, done } = this.#spawn(workspace, args, onLog);
    if (onKill) onKill(() => child.kill());
    return done;
  }
}

module.exports = { Pipeline, ID_RE };
