import { useState } from 'react';
import { api } from '../api';

export default function AuthScreen({ setUp, onDone }: { setUp: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [budgetName, setBudgetName] = useState('My Budget');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!setUp && password !== confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      if (setUp) {
        const r = await api.post<{ needsCode?: boolean; usedRecovery?: boolean; recoveryCodesLeft?: number }>('/auth/login', {
          password,
          code: needsCode ? code : undefined,
        });
        if (r.needsCode) {
          setNeedsCode(true);
          return;
        }
        if (r.usedRecovery) {
          window.alert(
            `You signed in with a recovery code. It can't be used again — ${r.recoveryCodesLeft} left. You can make new ones in Settings → Security.`,
          );
        }
      } else await api.post('/auth/setup', { password, budgetName, currency });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand brand-dark">
          <img src="/mani-coin-128.png" alt="" width={36} height={36} />
          <span>Mani</span>
        </div>
        <p className="auth-tagline">Lukautim mani</p>
        {setUp ? (
          <>
            <h1>Welcome back</h1>
            {!needsCode ? (
              <label>
                Password
                <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </label>
            ) : (
              <>
                <label>
                  Code from your authenticator app
                  <input
                    autoFocus
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="123 456"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                <p className="muted small">Lost your phone? Enter one of your recovery codes instead (looks like <code>a1b2c-3d4e5</code>).</p>
              </>
            )}
          </>
        ) : (
          <>
            <h1>Create your budget</h1>
            <p className="muted">This is a private, single-user app. Choose a password to protect your financial data.</p>
            <label>
              Budget name
              <input value={budgetName} onChange={(e) => setBudgetName(e.target.value)} />
            </label>
            <label>
              Currency
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {['USD', 'CAD', 'EUR', 'GBP', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'MXN', 'INR'].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </label>
            <label>
              Password (8+ characters)
              <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            <label>
              Confirm password
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
            </label>
          </>
        )}
        {error && <div className="error-text">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>
          {setUp ? (needsCode ? 'Verify' : 'Log in') : 'Get started'}
        </button>
      </form>
    </div>
  );
}
