import React, { useMemo, useState } from 'react';

const slug = s => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

// One keyframe is generated per character and every animation starts from it,
// which is what keeps the design identical across sheets. So the description
// is the important field here, and the motions are per animation.
export default function CharacterForm({ presets, existingIds, onSave, onCancel }) {
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [useStyle, setUseStyle] = useState(true);
  const [picked, setPicked] = useState(() => new Set(['idle', 'walk', 'attack']));
  const [motions, setMotions] = useState(() =>
    Object.fromEntries(presets.animations.map(a => [a.name, { motion: a.motion, frames: a.frames, fps: a.fps }])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const id = useMemo(() => slug(name), [name]);
  const taken = id && existingIds.includes(id);

  function toggle(animName) {
    setPicked(prev => {
      const next = new Set(prev);
      next.has(animName) ? next.delete(animName) : next.add(animName);
      return next;
    });
  }

  function patch(animName, field, value) {
    setMotions(prev => ({ ...prev, [animName]: { ...prev[animName], [field]: value } }));
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!id) return setError('Give the character a name.');
    if (taken) return setError(`You already have a character called "${id}".`);
    if (!picked.size) return setError('Pick at least one animation.');

    setBusy(true);
    try {
      await onSave({
        id,
        name: name.trim(),
        subject: subject.trim(),
        useStyle,
        animations: presets.animations
          .filter(a => picked.has(a.name))
          .map(a => ({ ...a, ...motions[a.name] }))
      });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>New character</h2>
      <p className="hint">
        Describe the character once. Every animation is generated from a single
        shared keyframe, so the design stays identical from sheet to sheet.
      </p>

      <div className="field">
        <label htmlFor="name">Name</label>
        <input id="name" type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Skeleton Warrior" required />
        {id && <span className="muted small">Saved as <code className="mono">{id}</code>{taken && ' — already taken'}</span>}
      </div>

      <div className="field">
        <label htmlFor="subject">What they look like</label>
        <textarea
          id="subject" value={subject} onChange={e => setSubject(e.target.value)} required
          rows={3}
          placeholder="an undead skeleton warrior holding a rusted notched sword and a cracked round wooden shield, faint cold blue glow in its eye sockets"
        />
        <span className="muted small">
          Describe the body, clothing, weapon and colours. Leave out the camera,
          the background and the pose — those are handled for you.
        </span>
      </div>

      <label className="row small field" style={{ cursor: 'pointer' }}>
        <input type="checkbox" checked={useStyle} onChange={e => setUseStyle(e.target.checked)} />
        <span className="muted">Apply the house sprite style (recommended)</span>
      </label>

      {!useStyle && (
        <p className="notice small">
          Without it your description must specify the view, framing and a plain
          flat background itself, or the matte will struggle.
        </p>
      )}

      <h3 style={{ marginTop: 22 }}>Animations</h3>
      <p className="hint">Each one is priced and generated separately. You can add more later.</p>

      {presets.animations.map(a => {
        const on = picked.has(a.name);
        return (
          <div key={a.name} className={`anim-row${on ? '' : ' off'}`}>
            <div className="head">
              <label>
                <input type="checkbox" checked={on} onChange={() => toggle(a.name)} />
                <strong>{a.name}</strong>
              </label>
              <div className="spacer" />
              <span className="muted small">{a.cycle ? 'loops' : 'one-shot'}</span>
            </div>
            {on && (
              <>
                <textarea
                  rows={2}
                  value={motions[a.name].motion}
                  onChange={e => patch(a.name, 'motion', e.target.value)}
                  style={{ marginTop: 10 }}
                />
                <div className="nums">
                  <div>
                    <label htmlFor={`${a.name}-frames`}>Frames</label>
                    <input
                      id={`${a.name}-frames`} type="number" min="1" max="64"
                      value={motions[a.name].frames}
                      onChange={e => patch(a.name, 'frames', Number(e.target.value))}
                    />
                  </div>
                  <div>
                    <label htmlFor={`${a.name}-fps`}>FPS</label>
                    <input
                      id={`${a.name}-fps`} type="number" min="1" max="60"
                      value={motions[a.name].fps}
                      onChange={e => patch(a.name, 'fps', Number(e.target.value))}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })}

      {error && <div className="error">{error}</div>}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="primary" type="submit" disabled={busy || taken}>
          {busy ? 'Saving…' : 'Save character'}
        </button>
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>Cancel</button>}
        <div className="spacer" />
        <span className="muted small">Saving costs nothing — you pick what to generate next.</span>
      </div>
    </form>
  );
}
