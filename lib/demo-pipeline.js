// The pipeline, replaced by a stand-in that generates nothing.
//
// This is what the public demo runs. It holds no API keys, spawns no child
// processes and calls no provider — so it cannot spend money and cannot be
// made to, which is the only safe way to put "click here to generate" on a
// page anyone can reach.
//
// Everything *around* it stays real: accounts, sessions, the credit ledger,
// the reserve/settle arithmetic, the queue with its per-user cap and
// per-character lock. Those are the parts worth showing, and they behave
// exactly as they do in production because they are the production code.
//
// What is faked, precisely:
//
//   estimate()  prices from the same table the real provider list uses
//               (keyframe 4 credits, 35 per 5-second clip), and treats an
//               animation as already paid for when its sheet exists — which
//               is what makes `charge = before - after` still come out right.
//
//   run()       waits, emits a log that mirrors the real one's shape, then
//               copies a pre-rendered sample sheet into the workspace. The
//               sample is chosen by hashing the character and animation name,
//               so a given request always yields the same sprite, and it has
//               nothing to do with the prompt. The UI says so plainly.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { invalid } = require('./errors');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

// Mirrors PROVIDER_INFO.fal in diablow/scripts/lib/providers.js: flux-schnell
// at 4 variants plus background removal, then one Kling clip per animation.
const KEYFRAME_CREDITS = 4;
const CLIP_CREDITS = 35;

// Long enough to see the queue, the log and the spinner do their jobs; short
// enough that nobody waits around on a demo.
const STEP_MS = Number(process.env.DEMO_STEP_MS) || 1400;

class DemoPipeline {
  constructor({ samplesDir, workspaces }) {
    this.samplesDir = path.resolve(samplesDir);
    this.workspaces = workspaces;
    const manifestPath = path.join(this.samplesDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) throw new Error(`No demo samples at ${this.samplesDir}`);
    this.samples = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!this.samples.length) throw new Error('The demo sample pool is empty');
  }

  // Same validation as the real pipeline, so the demo rejects what production
  // would reject. The returned "args" are only ever used for display here.
  args(job) {
    if (!ID_RE.test(job.sprite || '')) throw invalid('Invalid character id');
    const anims = (job.anims || []).filter(a => ID_RE.test(a));
    const args = ['--demo', `--id=${job.sprite}`];
    if (anims.length) args.push(`--anim=${anims.join(',')}`);
    const regen = (job.regen || []).filter(r => r === 'keyframe' || r === 'video');
    if (regen.length) args.push(`--regen=${regen.join(',')}`);
    return args;
  }

  // Which animations a job covers: those named, or all the character has.
  #targets(workspace, args) {
    const id = args.find(a => a.startsWith('--id=')).slice('--id='.length);
    const animArg = args.find(a => a.startsWith('--anim='));
    const def = this.#definition(workspace, id);
    const all = def ? def.animations.map(a => a.name) : [];
    const named = animArg ? animArg.slice('--anim='.length).split(',').filter(Boolean) : all;
    return { id, anims: named.filter(n => all.includes(n)), regen: args.some(a => a.startsWith('--regen=')) };
  }

  #definition(workspace, id) {
    const file = path.join(workspace, id, 'sprite.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  #sheetExists(workspace, id, anim) {
    return fs.existsSync(path.join(workspace, id, `${anim}.png`));
  }

  // A stable, prompt-independent choice, so the same character always looks
  // the same and a reload never swaps the sprite underneath you.
  #sampleFor(id, anim) {
    const digest = crypto.createHash('sha256').update(`${id}/${anim}`).digest();
    return this.samples[digest.readUInt32BE(0) % this.samples.length];
  }

  async estimate(workspace, args) {
    const { id, anims, regen } = this.#targets(workspace, args);
    const def = this.#definition(workspace, id);
    if (!def) {
      const err = new Error(`No character "${id}" in this workspace`);
      err.code = 'ESTIMATE_FAILED';
      throw err;
    }

    const lines = [];
    let credits = 0;

    // The keyframe is shared by every animation, so it is charged once and
    // only while nothing has been generated for the character yet.
    const anySheet = def.animations.some(a => this.#sheetExists(workspace, id, a.name));
    const keyframe = anySheet && !regen ? 0 : KEYFRAME_CREDITS;
    credits += keyframe;
    lines.push(`[plan] ${id}: keyframe ${keyframe ? 'flux-schnell + bg-remove' : 'cached'} (${keyframe} cr)`);

    for (const name of anims) {
      const cached = this.#sheetExists(workspace, id, name) && !regen;
      const cost = cached ? 0 : CLIP_CREDITS;
      credits += cost;
      const anim = def.animations.find(a => a.name === name);
      lines.push(`  ${name}: video ${cached ? 'cached' : 'kling-2.5-turbo-pro'} (${cost} cr), matte chroma (0 cr), ${anim ? anim.frames : 12} frames`);
    }
    lines.push(`~${credits} credits total (provider: demo — nothing is generated).`);
    return { credits, plan: lines.join('\n') };
  }

  async run(workspace, args, onLog, onKill) {
    const { id, anims, regen } = this.#targets(workspace, args);
    let cancelled = false;
    if (onKill) onKill(() => { cancelled = true; });
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const log = line => onLog && onLog(line + '\n');

    log(`[demo] no provider is configured — serving pre-rendered sample sheets`);
    log(`[sprite] ${id}`);
    await wait(STEP_MS);
    if (cancelled) return { ok: false, code: null, cancelled: true };
    log('  keyframe: flux-schnell (sample)');

    const dir = path.join(workspace, id);
    fs.mkdirSync(dir, { recursive: true });

    for (const anim of anims) {
      if (cancelled) return { ok: false, code: null, cancelled: true };
      if (this.#sheetExists(workspace, id, anim) && !regen) {
        log(`[anim] ${id}/${anim}: already generated, skipping`);
        continue;
      }
      const sample = this.#sampleFor(id, anim);
      log(`[anim] ${id}/${anim}`);
      await wait(STEP_MS);
      if (cancelled) return { ok: false, code: null, cancelled: true };
      log(`  video (kling-2.5-turbo-pro): sample ${sample.id}`);
      await wait(STEP_MS);
      if (cancelled) return { ok: false, code: null, cancelled: true };
      log(`  frames: ${sample.frames} sampled @ ${sample.fps}fps${sample.loop ? ', loop seam matched' : ''}`);
      log('  matte: chroma, edge un-mix + despill');

      for (const ext of ['png', 'json', 'webp']) {
        const src = path.join(this.samplesDir, `${sample.id}.${ext}`);
        if (!fs.existsSync(src)) throw new Error(`Demo sample missing: ${sample.id}.${ext}`);
        fs.copyFileSync(src, path.join(dir, `${anim}.${ext}`));
      }
      log(`[saved] ${id}/${anim}.png — ${sample.frames} frames (sample)`);
    }

    log('Done — sample sheets copied. Nothing was generated and no provider was called.');
    return { ok: true, code: 0 };
  }
}

module.exports = { DemoPipeline, KEYFRAME_CREDITS, CLIP_CREDITS };
