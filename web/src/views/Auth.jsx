import React, { useState } from 'react';
import { api } from '../api.js';

// Signing up logs you straight in — there is nothing to confirm, so a
// confirmation step would only be somewhere to lose people.
export default function Auth({ onAuthed, config = {} }) {
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const signingUp = mode === 'signup';

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      onAuthed(signingUp ? await api.signup(email, password) : await api.login(email, password));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth" onSubmit={submit}>
        <div className="brand"><span className="dot" />SpriteForge</div>
        <p className="tagline">
          Animated sprite sheets from a prompt — with a real alpha channel, a
          packed atlas and a pivot at the feet.
        </p>

        {config.demo && (
          <div className="demo-note">
            <strong>This is a demo.</strong> No model is connected, so nothing
            is generated — “generating” returns a pre-rendered sample sheet.
            Sign up with a throwaway password: all data is wiped on each deploy.
            {config.signupCredits > 0 && ` New accounts get ${config.signupCredits} demo credits.`}
          </div>
        )}

        {config.full && (
          <div className="error">
            The demo is full for now. Try again later.
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email" type="email" value={email} autoComplete="username"
            onChange={e => setEmail(e.target.value)} required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password" type="password" value={password}
            autoComplete={signingUp ? 'new-password' : 'current-password'}
            onChange={e => setPassword(e.target.value)} required
            minLength={signingUp ? 10 : undefined}
          />
          {signingUp && <span className="muted small">At least 10 characters.</span>}
        </div>

        {error && <div className="error">{error}</div>}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'One moment…' : signingUp ? 'Create account' : 'Sign in'}
        </button>

        <div className="switch">
          {signingUp ? 'Already have an account?' : 'No account yet?'}{' '}
          <button
            type="button"
            onClick={() => { setMode(signingUp ? 'login' : 'signup'); setError(''); }}
          >
            {signingUp ? 'Sign in' : 'Sign up'}
          </button>
        </div>
      </form>
    </div>
  );
}
