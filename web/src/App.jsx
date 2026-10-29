import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import Auth from './views/Auth.jsx';
import Studio from './views/Studio.jsx';
import Account from './views/Account.jsx';

export default function App() {
  const [me, setMe] = useState(null);
  const [config, setConfig] = useState({ demo: false });
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState('studio');

  // One source of truth for "who am I and what do I have left". Everything
  // that can move the balance calls this afterwards.
  const refresh = useCallback(async () => {
    try { setMe(await api.me()); return true; }
    catch { setMe(null); return false; }
  }, []);

  useEffect(() => {
    api.config().then(setConfig).catch(() => {});
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  async function signOut() {
    await api.logout().catch(() => {});
    setMe(null);
    setView('studio');
  }

  if (loading) return <div className="auth-wrap"><span className="muted">Loading…</span></div>;
  if (!me) return <Auth onAuthed={setMe} config={config} />;

  const available = me.balance.available;

  return (
    <>
      {config.demo && <DemoBanner />}
      <header className="topbar">
        <div className="brand"><span className="dot" />SpriteForge</div>
        <div className="spacer" />
        <span className={available > 0 ? 'balance' : 'balance empty'}>
          {available} credit{available === 1 ? '' : 's'}
        </span>
        <button
          className="ghost small"
          onClick={() => setView(view === 'studio' ? 'account' : 'studio')}
        >
          {view === 'studio' ? 'Account' : 'Studio'}
        </button>
        <button className="ghost small" onClick={signOut}>Sign out</button>
      </header>

      {view === 'studio'
        ? <Studio me={me} config={config} onBalanceChange={refresh} />
        : <Account me={me} config={config} onChange={refresh} />}
    </>
  );
}

// Nothing on this page should imply a real sprite is being made from a real
// prompt, so the disclaimer is persistent and above everything else.
function DemoBanner() {
  return (
    <div className="demo-banner">
      <strong>Demo</strong>
      <span>
        No image or video model is connected and no API key exists here, so
        nothing is generated. “Generating” waits, then hands back a
        pre-rendered sample sheet that has nothing to do with your prompt.
        Accounts, credits and the job queue are the real code. Data is wiped on
        each deploy — don’t reuse a password you care about.
      </span>
    </div>
  );
}
