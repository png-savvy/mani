import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { fmtDateTime, money } from '../format';
import { openPlaidLink } from '../plaid';
import { Confirm, Modal } from './ui';
import { ConnectBankModal, LinkHelp, MapAccounts } from './ConnectBank';
import type { Connection } from '../types';
import TwoFactorSettings from './TwoFactorSettings';
import NotificationSettings from './NotificationSettings';
import AmazonSettings from './AmazonSettings';

export default function SettingsPage() {
  const { data, version, run, toast, bump } = useApp();
  const [conns, setConns] = useState<Connection[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [mapping, setMapping] = useState<number | null>(null);
  const [removing, setRemoving] = useState<Connection | null>(null);
  const [syncing, setSyncing] = useState<number | 'all' | null>(null);
  const [s, setS] = useState(data.settings);
  const [pw, setPw] = useState({ current: '', next: '' });

  useEffect(() => {
    api.get<{ connections: Connection[] }>('/connections').then((r) => setConns(r.connections)).catch((e) => toast(e.message, 'error'));
  }, [version, toast]);
  useEffect(() => setS(data.settings), [data.settings]);

  const sync = async (id: number | 'all') => {
    setSyncing(id);
    const r = await run(() => api.post(id === 'all' ? '/connections/sync-all' : `/connections/${id}/sync`));
    setSyncing(null);
    if (r && id !== 'all') toast(`Imported ${r.imported} new, matched ${r.matched}`, 'success');
    if (r && id === 'all') toast('Sync finished — see each connection for details', 'success');
  };

  const fixPlaid = async (c: Connection) => {
    try {
      const { linkToken } = await api.post<{ linkToken: string }>('/plaid/link-token', { connectionId: c.id });
      const r = await openPlaidLink(linkToken, { connectionId: c.id });
      if (!r) return;
      await api.post(`/plaid/reauthed/${c.id}`);
      toast('Connection fixed', 'success');
      bump();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="page settings">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <section className="card">
        <div className="card-head">
          <h2>Bank Connections (Direct Import)</h2>
          <div className="row-gap">
            {conns && conns.length > 0 && (
              <button className="btn btn-small" disabled={syncing !== null} onClick={() => sync('all')}>
                {syncing === 'all' ? 'Syncing…' : '⟳ Sync all now'}
              </button>
            )}
            <button className="btn btn-small btn-primary" onClick={() => setAdding(true)}>+ Link a bank</button>
          </div>
        </div>
        <p className="muted small">
          Linked accounts are imported automatically every {data.settings.syncIntervalHours || '—'} hour(s) while the server is running
          {data.settings.syncIntervalHours === 0 && ' (automatic sync is off)'}. New transactions appear in the account for you to approve.
        </p>
        {conns === null && <div className="spinner" />}
        {conns?.length === 0 && <p>No banks linked yet.</p>}
        {conns?.map((c) => (
          <div key={c.id} className={`conn ${c.status !== 'ok' ? 'conn-bad' : ''}`}>
            <div className="conn-head">
              <div>
                <b>{c.institution || 'Bank'}</b> <span className="tag">{c.provider === 'plaid' ? 'Plaid' : 'SimpleFIN'}</span>
                <div className="muted small">Last sync: {fmtDateTime(c.last_sync_at)}</div>
                {c.error && <div className={c.status === 'ok' ? 'warn-text small' : 'error-text small'}>{c.error}</div>}
                {c.status === 'reauth' && <div className="error-text small">Your bank needs you to log in again.</div>}
                {c.accounts.length > 0 && c.accounts.every((a) => !a.localAccountId) && (
                  <div className="warn-text small">Nothing is being imported yet — click <b>Choose accounts</b>.</div>
                )}
              </div>
              <div className="row-gap">
                {c.provider === 'plaid' && c.status === 'reauth' && (
                  <button className="btn btn-small btn-primary" onClick={() => fixPlaid(c)}>Fix connection</button>
                )}
                <button className="btn btn-small" disabled={syncing !== null} onClick={() => sync(c.id)}>
                  {syncing === c.id ? 'Syncing…' : 'Sync now'}
                </button>
                <button className="btn btn-small" onClick={() => setMapping(c.id)}>Choose accounts</button>
                <button className="btn btn-small btn-danger-ghost" onClick={() => setRemoving(c)}>Remove</button>
              </div>
            </div>
            <table className="simple-table">
              <tbody>
                {c.accounts.map((a) => (
                  <tr key={a.externalId}>
                    <td>{a.name}{a.mask ? ` ••${a.mask}` : ''}</td>
                    <td className="num">{a.balance !== null ? money(a.balance) : ''}</td>
                    <td>{a.localAccountName ? <>→ <b>{a.localAccountName}</b></> : <span className="muted">not imported</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        <details className="help">
          <summary>How to set up SimpleFIN</summary>
          <LinkHelp provider="simplefin" />
        </details>
        <details className="help">
          <summary>How to set up Plaid</summary>
          <LinkHelp provider="plaid" />
        </details>
      </section>

      <NotificationSettings />

      <AmazonSettings />

      <section className="card">
        <h2>Budget Settings</h2>
        <div className="form grid-2">
          <label>
            Budget style
            <select value={s.budgetMode} onChange={(e) => setS({ ...s, budgetMode: e.target.value as 'rolling' | 'monthly' })}>
              <option value="rolling">Rolling — balances carry over, cover overspending whenever you want</option>
              <option value="monthly">Monthly — overspending resets each month</option>
            </select>
          </label>
          <label>
            Credit card payment categories
            <select value={s.showCcPayments ? 'show' : 'hide'} onChange={(e) => setS({ ...s, showCcPayments: e.target.value === 'show' })}>
              <option value="show">Show on the Budget page</option>
              <option value="hide">Hide (I don't budget for card payments)</option>
            </select>
          </label>
          <label>
            Budget name
            <input value={s.budgetName} onChange={(e) => setS({ ...s, budgetName: e.target.value })} />
          </label>
          <label>
            Currency (ISO code)
            <input value={s.currency} maxLength={3} onChange={(e) => setS({ ...s, currency: e.target.value.toUpperCase() })} />
          </label>
          <label>
            Number format (locale)
            <select value={s.locale} onChange={(e) => setS({ ...s, locale: e.target.value })}>
              {['en-US', 'en-GB', 'en-CA', 'en-AU', 'de-DE', 'fr-FR', 'es-ES', 'it-IT', 'nl-NL', 'ja-JP', 'en-IN'].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
          </label>
          <label>
            Date format
            <select value={s.dateFormat} onChange={(e) => setS({ ...s, dateFormat: e.target.value })}>
              <option>MM/DD/YYYY</option>
              <option>DD/MM/YYYY</option>
              <option>YYYY-MM-DD</option>
            </select>
          </label>
          <label>
            Automatic bank sync every (hours, 0 = off)
            <input type="number" min={0} max={168} value={s.syncIntervalHours} onChange={(e) => setS({ ...s, syncIntervalHours: Number(e.target.value) })} />
          </label>
        </div>
        <p className="muted small">SimpleFIN asks apps to make at most ~24 requests a day; 4+ hours is a good interval.</p>
        <button className="btn btn-primary" onClick={() => run(() => api.put('/settings', s), 'Settings saved')}>Save settings</button>
      </section>

      <section className="card">
        <h2>Security</h2>
        <form
          className="form grid-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => api.post('/auth/password', pw), 'Password changed — please log in again');
            if (r !== undefined) window.location.reload();
          }}
        >
          <label>
            Current password
            <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
          </label>
          <label>
            New password
            <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
          </label>
          <div>
            <button className="btn" disabled={!pw.current || pw.next.length < 8}>Change password</button>
          </div>
        </form>
        <TwoFactorSettings />
      </section>

      <section className="card">
        <h2>Your Data</h2>
        <p className="muted small">Everything is stored in a single SQLite file on your server. Back it up regularly.</p>
        <div className="row-gap">
          <a className="btn" href="/api/export/transactions.csv">Export transactions (CSV)</a>
          <a className="btn" href="/api/export/backup.db">Download full backup (.db)</a>
        </div>
      </section>

      {adding && <ConnectBankModal onClose={() => setAdding(false)} />}
      {mapping !== null && (
        <Modal title="Choose accounts to import" onClose={() => setMapping(null)} wide>
          <MapAccounts
            connectionId={mapping}
            onDone={() => {
              setMapping(null);
              bump();
            }}
          />
        </Modal>
      )}
      {removing && (
        <Confirm
          title={`Remove ${removing.institution || 'connection'}?`}
          danger
          confirmLabel="Remove connection"
          message="Automatic import stops for its accounts. Your accounts and transactions here are kept."
          onConfirm={() => run(() => api.del(`/connections/${removing.id}`), 'Connection removed')}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}
