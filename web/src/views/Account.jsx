import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const EVENT_LABEL = {
  grant: 'Credits added',
  reserve: 'Held for a job',
  settle: 'Charged',
  release: 'Hold returned'
};

export default function Account({ me, config = {}, onChange }) {
  const [history, setHistory] = useState([]);
  const [error, setError] = useState('');

  useEffect(() => { api.history().then(setHistory).catch(e => setError(e.message)); }, [me.balance.granted, me.balance.spent]);

  return (
    <main className="main" style={{ maxWidth: 820, margin: '0 auto' }}>
      {error && <div className="error">{error}</div>}

      <div className="panel">
        <h2>Credits</h2>
        <p className="hint">One credit is one cent of generation cost. A 5-second clip is 35.</p>
        <table>
          <tbody>
            <tr><td>Available to spend</td><td className="num"><strong>{me.balance.available}</strong></td></tr>
            <tr><td className="muted">Held by running jobs</td><td className="num muted">{me.balance.held}</td></tr>
            <tr><td className="muted">Spent all time</td><td className="num muted">{me.balance.spent}</td></tr>
            <tr><td className="muted">Added all time</td><td className="num muted">{me.balance.granted}</td></tr>
          </tbody>
        </table>
        <p className="notice small" style={{ marginTop: 14 }}>
          {config.demo
            ? 'Payments are not wired up. In the demo, credits are granted on signup and spent against simulated runs — the arithmetic is real, the money is not.'
            : <>Self-service top-up is not wired up yet. Ask an administrator to add credits to <code className="mono">{me.user.email}</code>.</>}
        </p>
      </div>

      <Keys me={me} onChange={onChange} />

      <Password />

      <div className="panel">
        <h3>Billing history</h3>
        <p className="hint">Every credit movement on this account, oldest first.</p>
        {history.length === 0
          ? <p className="muted small">Nothing yet.</p>
          : (
            <table>
              <thead>
                <tr><th>When</th><th>What</th><th className="num">Credits</th></tr>
              </thead>
              <tbody>
                {history.map(e => (
                  <tr key={e.seq}>
                    <td className="muted small">{new Date(e.ts).toLocaleString()}</td>
                    <td>
                      {EVENT_LABEL[e.type] || e.type}
                      {e.meta && e.meta.source && <span className="muted small"> · {e.meta.source}</span>}
                      {e.type === 'settle' && e.meta && e.meta.reserved != null &&
                        <span className="muted small"> · {e.meta.reserved} held</span>}
                    </td>
                    <td className="num">
                      {e.type === 'grant' ? `+${e.amount}` : e.type === 'settle' ? `−${e.amount}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </div>
    </main>
  );
}

function Keys({ me, onChange }) {
  const [label, setLabel] = useState('');
  const [revealed, setRevealed] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setRevealed(await api.createKey(label || 'untitled'));
      setLabel('');
      await onChange();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function revoke(id) {
    setBusy(true);
    try { await api.revokeKey(id); await onChange(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const live = me.keys.filter(k => !k.revoked);

  return (
    <div className="panel">
      <h3>API keys</h3>
      <p className="hint">
        For driving generation from a script or a build step. Send it as
        <code className="mono"> Authorization: Bearer …</code>
      </p>

      {revealed && (
        <>
          <p className="notice small" style={{ margin: 0 }}>
            Copy this now — it is not shown again.
          </p>
          <div className="key-reveal">{revealed.secret}</div>
        </>
      )}

      {live.length > 0 && (
        <table style={{ marginBottom: 14 }}>
          <thead>
            <tr><th>Label</th><th>Key</th><th>Created</th><th /></tr>
          </thead>
          <tbody>
            {live.map(k => (
              <tr key={k.id}>
                <td>{k.label || <span className="muted">untitled</span>}</td>
                <td className="mono muted small">{k.prefix}…</td>
                <td className="muted small">{new Date(k.createdAt).toLocaleDateString()}</td>
                <td className="num">
                  <button className="small danger" disabled={busy} onClick={() => revoke(k.id)}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {error && <div className="error">{error}</div>}

      <form className="row" onSubmit={create}>
        <input
          type="text" value={label} onChange={e => setLabel(e.target.value)}
          placeholder="What is this key for?" style={{ maxWidth: 260 }}
        />
        <button type="submit" disabled={busy}>Create key</button>
      </form>
    </div>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    setDone(false);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setDone(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h3>Change password</h3>
      <p className="hint">Changing it signs out every other device.</p>

      <div className="field">
        <label htmlFor="current">Current password</label>
        <input id="current" type="password" autoComplete="current-password" value={current} onChange={e => setCurrent(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor="next">New password</label>
        <input id="next" type="password" autoComplete="new-password" minLength={10} value={next} onChange={e => setNext(e.target.value)} required />
        <span className="muted small">At least 10 characters.</span>
      </div>

      {error && <div className="error">{error}</div>}
      {done && <p className="small" style={{ color: 'var(--good)' }}>Password changed.</p>}

      <button type="submit" disabled={busy}>{busy ? 'Changing…' : 'Change password'}</button>
    </form>
  );
}
