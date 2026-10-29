// One directory per customer, laid out exactly like the pipeline's own asset
// folder so generate-sprites.js needs no idea it is running hosted:
//
//   workspaces/<user>/<character>/sprite.json    the definition
//   workspaces/<user>/<character>/<anim>.png     the sheet
//   workspaces/<user>/<character>/<anim>.json    the atlas (TexturePacker)
//   workspaces/<user>/<character>/<anim>.webp    the preview
//   workspaces/<user>/<character>/_work/         intermediates + paid-job cache
//
// _work is private: it holds the paid-job state and the raw provider frames.
// Only the three output files per animation are ever served to a customer.

const fs = require('fs');
const path = require('path');
const { ID_RE } = require('./pipeline');
const { invalid } = require('./errors');

const OUTPUT_EXTS = ['png', 'json', 'webp'];

class Workspaces {
  constructor({ root, style, presets }) {
    this.root = path.resolve(root);
    this.style = style;
    this.presets = presets;
    fs.mkdirSync(this.root, { recursive: true });
  }

  // A user id is a server-generated UUID, never customer input, but the join
  // is still guarded: a path escape here would cross tenants.
  dirFor(userId) {
    const dir = path.join(this.root, userId);
    if (!dir.startsWith(this.root + path.sep)) throw new Error('Invalid workspace');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  characterDir(userId, id) {
    if (!ID_RE.test(id || '')) throw invalid('Character id must be lowercase letters, digits, - or _');
    return path.join(this.dirFor(userId), id);
  }

  // Mirrors the local studio's saveSprite: the prompt is the subject plus the
  // house style, and every animation field is clamped to a sane range.
  saveCharacter(userId, body) {
    const id = String(body.id || '');
    const dir = this.characterDir(userId, id);
    const subject = String(body.subject || '').trim();
    if (!subject) throw invalid('Describe the character');
    if (subject.length > 3000) throw invalid('Description is too long');

    const num = (v, min, max, fallback) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    };
    const animations = (body.animations || []).map(a => {
      if (!ID_RE.test(a.name || '')) throw invalid(`Invalid animation name "${a.name}"`);
      const motion = String(a.motion || '').trim();
      if (!motion) throw invalid(`Describe the ${a.name} motion`);
      return {
        name: a.name,
        motion: motion.slice(0, 1500),
        frames: Math.round(num(a.frames, 1, 64, 12)),
        fps: num(a.fps, 1, 60, 12),
        cycle: a.cycle !== false,
        minCycle: num(a.minCycle, 0.2, 5, 0.8),
        scale: num(a.scale, 0.3, 0.8, 0.6)
      };
    });
    if (!animations.length) throw invalid('Pick at least one animation');
    if (new Set(animations.map(a => a.name)).size !== animations.length) throw invalid('Animation names must be unique');

    const useStyle = body.useStyle !== false;
    const def = {
      id,
      name: String(body.name || id).slice(0, 80),
      subject,
      useStyle,
      prompt: useStyle ? `${subject}, ${this.style}` : subject,
      animations
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'sprite.json'), JSON.stringify(def, null, 2));
    return def;
  }

  character(userId, id) {
    const file = path.join(this.characterDir(userId, id), 'sprite.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  listCharacters(userId) {
    const dir = this.dirFor(userId);
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const def = this.character(userId, e.name);
        return def ? { ...def, animations: def.animations.map(a => ({ ...a, output: this.outputs(userId, e.name, a.name) })) } : null;
      })
      .filter(Boolean);
  }

  // Which of an animation's three output files exist, and when they changed.
  outputs(userId, id, anim) {
    const dir = this.characterDir(userId, id);
    const present = {};
    for (const ext of OUTPUT_EXTS) {
      const file = path.join(dir, `${anim}.${ext}`);
      try { present[ext] = Math.round(fs.statSync(file).mtimeMs); } catch { present[ext] = null; }
    }
    return present.png ? present : null;
  }

  // Resolves a download request to a real file, refusing anything outside the
  // customer's own character folder — notably all of _work.
  outputPath(userId, id, anim, ext) {
    if (!OUTPUT_EXTS.includes(ext)) throw invalid('Not a downloadable file');
    if (!ID_RE.test(anim || '')) throw invalid('Invalid animation name');
    const dir = this.characterDir(userId, id);
    const file = path.join(dir, `${anim}.${ext}`);
    if (!file.startsWith(dir + path.sep)) throw invalid('Invalid path');
    return fs.existsSync(file) ? file : null;
  }
}

module.exports = { Workspaces, OUTPUT_EXTS };
