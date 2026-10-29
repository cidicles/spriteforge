import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import CharacterForm from '../components/CharacterForm.jsx';
import JobPanel from '../components/JobPanel.jsx';

const ACTIVE = new Set(['queued', 'running']);

export default function Studio({ me, config = {}, onBalanceChange }) {
  const [characters, setCharacters] = useState([]);
  const [presets, setPresets] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [error, setError] = useState('');

  const loadCharacters = useCallback(async () => {
    const list = await api.characters();
    setCharacters(list);
    return list;
  }, []);

  useEffect(() => {
    Promise.all([loadCharacters(), api.presets(), api.jobs()])
      .then(([list, p, j]) => {
        setPresets(p);
        setJobs(j);
        if (list.length) setSelectedId(prev => prev ?? list[0].id);
        else setEditing(true);
      })
      .catch(e => setError(e.message));
  }, [loadCharacters]);

  // Poll only while something is in flight, and reconcile when it lands: a
  // finished job means new sheets to show and a settled charge to display.
  const activeCount = jobs.filter(j => ACTIVE.has(j.status)).length;
  const prevActive = useRef(0);
  useEffect(() => {
    if (!activeCount) {
      if (prevActive.current > 0) { loadCharacters().catch(() => {}); onBalanceChange(); }
      prevActive.current = 0;
      return;
    }
    prevActive.current = activeCount;
    const timer = setInterval(() => { api.jobs().then(setJobs).catch(() => {}); }, 2000);
    return () => clearInterval(timer);
  }, [activeCount, loadCharacters, onBalanceChange]);

  const selected = characters.find(c => c.id === selectedId) || null;

  async function saveCharacter(def) {
    const saved = await api.saveCharacter(def);
    const list = await loadCharacters();
    setSelectedId(saved.id);
    setEditing(false);
    return list;
  }

  async function submit(request) {
    const job = await api.submit(request);
    setJobs(await api.jobs());
    onBalanceChange();
    return job;
  }

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="row" style={{ marginBottom: 12 }}>
          <strong className="small">Your cast</strong>
          <div className="spacer" />
          <button
            className="small"
            onClick={() => { setEditing(true); setSelectedId(null); }}
          >+ New</button>
        </div>

        {characters.length === 0 && !editing && (
          <p className="muted small">No characters yet.</p>
        )}

        {characters.map(c => {
          const ready = c.animations.filter(a => a.output).length;
          return (
            <button
              key={c.id}
              className={`cast-item${c.id === selectedId && !editing ? ' active' : ''}`}
              onClick={() => { setSelectedId(c.id); setEditing(false); }}
            >
              {c.name}
              <span className="sub">{ready} of {c.animations.length} generated</span>
            </button>
          );
        })}
      </aside>

      <main className="main">
        {error && <div className="error">{error}</div>}

        {editing && presets && (
          <CharacterForm
            presets={presets}
            existingIds={characters.map(c => c.id)}
            onSave={saveCharacter}
            onCancel={characters.length ? () => { setEditing(false); setSelectedId(characters[0].id); } : null}
          />
        )}

        {!editing && selected && (
          <CharacterView
            character={selected}
            config={config}
            jobs={jobs.filter(j => j.sprite === selected.id)}
            balance={me.balance}
            onSubmit={submit}
            onCancel={async id => { await api.cancel(id); setJobs(await api.jobs()); onBalanceChange(); }}
          />
        )}

        {!editing && !selected && characters.length > 0 && (
          <div className="empty-state"><p>Pick a character on the left.</p></div>
        )}
      </main>
    </div>
  );
}

function CharacterView({ character, config, jobs, balance, onSubmit, onCancel }) {
  // Default to whatever has not been generated yet — the common case is
  // "finish this character", not "regenerate everything".
  const missing = character.animations.filter(a => !a.output).map(a => a.name);
  const [picked, setPicked] = useState(missing.length ? missing : character.animations.map(a => a.name));
  const [regen, setRegen] = useState(false);
  const [quote, setQuote] = useState(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const activeJob = jobs.find(j => ACTIVE.has(j.status)) || null;
  const lastJob = jobs[0] || null;

  const request = useMemo(() => ({
    sprite: character.id,
    anims: picked,
    ...(regen ? { regen: ['video'] } : {})
  }), [character.id, picked, regen]);

  // Quoting spawns a dry run, so it is debounced rather than fired per click.
  useEffect(() => {
    if (!picked.length) { setQuote(null); return; }
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      api.quote(request)
        .then(q => { if (!cancelled) { setQuote(q); setError(''); } })
        .catch(e => { if (!cancelled) { setQuote(null); setError(e.message); } })
        .finally(() => { if (!cancelled) setQuoting(false); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [request]);

  const cost = quote ? quote.credits : null;
  const affordable = cost !== null && cost <= balance.available;

  async function generate() {
    setBusy(true);
    setError('');
    try { await onSubmit(request); }
    catch (e) { setError(e.code === 'INSUFFICIENT_CREDITS' ? `${e.message}. Add credits on the Account tab.` : e.message); }
    finally { setBusy(false); }
  }

  function toggle(name) {
    setPicked(p => (p.includes(name) ? p.filter(n => n !== name) : [...p, name]));
  }

  return (
    <>
      <div className="panel">
        <div className="row wrap">
          <div>
            <h2>{character.name}</h2>
            <p className="hint" style={{ margin: '4px 0 0', maxWidth: 620 }}>{character.subject}</p>
          </div>
        </div>
      </div>

      {activeJob
        ? <JobPanel job={activeJob} onCancel={onCancel} />
        : (
          <div className="panel">
            <h3>Generate</h3>
            <p className="hint">
              Pick the animations to produce. Each one is a separate clip, matted
              to transparency and packed into a sheet.
            </p>

            <div style={{ marginBottom: 14 }}>
              {character.animations.map(a => (
                <label key={a.name} className="row" style={{ marginBottom: 6, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={picked.includes(a.name)}
                    onChange={() => toggle(a.name)}
                  />
                  <strong className="small">{a.name}</strong>
                  {a.output
                    ? <span className="pill done">generated</span>
                    : <span className="pill">not yet</span>}
                  <span className="muted small">{a.frames} frames @ {a.fps}fps</span>
                </label>
              ))}
            </div>

            <label className="row small" style={{ cursor: 'pointer', marginBottom: 14 }}>
              <input type="checkbox" checked={regen} onChange={e => setRegen(e.target.checked)} />
              <span className="muted">
                Regenerate clips that already exist (costs full price again)
              </span>
            </label>

            {quote && (
              <div className="quote">
                <span className="n">{quote.credits}</span>
                <span className="muted small">
                  credits — you have {balance.available}
                  {balance.held > 0 && `, with ${balance.held} held by a running job`}
                </span>
              </div>
            )}

            {error && <div className="error">{error}</div>}

            <div className="row">
              <button
                className="primary"
                disabled={busy || quoting || !picked.length || !quote || !affordable}
                onClick={generate}
              >
                {busy ? 'Starting…'
                  : quoting ? 'Pricing…'
                  : !picked.length ? 'Pick an animation'
                  : !quote ? 'Cannot price this'
                  : affordable ? `${config.demo ? 'Simulate' : 'Generate'} — ${cost} credits`
                  : `Need ${cost - balance.available} more credits`}
              </button>
              {quote && <span className="muted small">Quoting is free.</span>}
            </div>

            {quote && (
              <details style={{ marginTop: 14 }}>
                <summary className="muted small" style={{ cursor: 'pointer' }}>What this costs, item by item</summary>
                <pre className="log" style={{ marginTop: 10 }}>{quote.plan}</pre>
              </details>
            )}
          </div>
        )}

      {!activeJob && lastJob && lastJob.status !== 'done' && (
        <JobPanel job={lastJob} onCancel={onCancel} />
      )}

      <div className="panel">
        <h3>Sheets</h3>
        {config.demo && (
          <p className="hint" style={{ margin: '0 0 14px' }}>
            These are pre-rendered samples, picked by name — not made from this
            character's description. The files are real output from the actual
            pipeline, so the atlas, pivot and alpha are genuine.
          </p>
        )}
        <div className="anim-grid">
          {character.animations.map(a => (
            <div key={a.name} className="anim-card">
              <header>
                <strong>{a.name}</strong>
                <div className="spacer" />
                {a.output ? <span className="pill done">ready</span> : <span className="pill">—</span>}
              </header>
              <div className="preview">
                {a.output
                  ? <img src={api.download(character.id, a.name, 'webp', true)} alt={`${a.name} preview`} />
                  : <span className="none">Not generated</span>}
              </div>
              {a.output && (
                <div className="row" style={{ gap: 6 }}>
                  {['png', 'json', 'webp'].map(ext => (
                    <a key={ext} href={api.download(character.id, a.name, ext)} download>
                      <button className="small ghost">{ext}</button>
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        <p className="hint" style={{ margin: '14px 0 0' }}>
          <strong>png</strong> is the sheet, <strong>json</strong> the TexturePacker
          atlas (pivot at the feet), <strong>webp</strong> an animated preview.
        </p>
      </div>
    </>
  );
}
