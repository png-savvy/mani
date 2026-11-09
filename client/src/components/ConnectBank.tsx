import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { money } from '../format';
import { openPlaidLink } from '../plaid';
import { Modal } from './ui';
import type { Connection } from '../types';
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, addDays, todayISO } from '../../../shared/util';

/** In-app instructions shown before linking (mirrors the README). */
export function LinkHelp({ provider }: { provider: 'plaid' | 'simplefin' }) {
  const { data } = useApp();
  if (provider === 'simplefin') {
    return (
      <ol className="steps">
        <li>
          Go to <a href="https://bridge.simplefin.org/simplefin/create" target="_blank" rel="noreferrer">SimpleFIN Bridge</a> and sign up
          ($1.50/month or $15/year, paid to SimpleFIN — up to 25 institutions).
        </li>
        <li>In SimpleFIN Bridge, add your institutions: log in to each bank and credit card you want to import (thousands of US banks are supported).</li>
        <li>
          Create a new <b>Setup Token</b> for an app (at <code>bridge.simplefin.org/simplefin/create</code>) and copy the long token it shows you.
        </li>
        <li>Paste that token below and press <b>Connect</b>. A token works only once — this app exchanges it for a private access key that is stored encrypted on your server.</li>
        <li>Choose which bank accounts to import and whether each one creates a new account here or links to one you already have.</li>
      </ol>
    );
  }
  return (
    <div>
      {!data.plaid.configured && (
        <div className="callout callout-warn">
          Plaid isn't set up on this server yet. Follow the steps below, then restart the server.
        </div>
      )}
      <ol className="steps">
        <li>
          Create a free developer account at <a href="https://dashboard.plaid.com/signup" target="_blank" rel="noreferrer">dashboard.plaid.com</a>.
        </li>
        <li>
          In the Plaid Dashboard open <b>Developers → Keys</b> and copy your <code>client_id</code> and the <b>Sandbox</b> secret (for testing) or <b>Production</b> secret (for real banks).
          New Plaid teams get a free Trial plan that covers a small number of real (Production) bank connections — enough for personal use. Check the Plaid dashboard for your plan's current limits.
        </li>
        <li>
          Put them in the server's <code>.env</code> file:
          <pre>{`PLAID_CLIENT_ID=your_client_id
PLAID_SECRET=your_secret
PLAID_ENV=sandbox   # or production`}</pre>
          and restart the server.
        </li>
        <li>
          Banks that use OAuth (Chase, Bank of America, Wells Fargo, …) open their own login page in a popup — allow popups for this site.
          On the free Trial plan, removing a connection does not give back one of your 10 slots, so use <b>Fix connection</b> instead of linking a bank again.
        </li>
        <li>
          Click <b>Connect with Plaid</b>. In Sandbox use the test login <code>user_good</code> / <code>pass_good</code>.
        </li>
      </ol>
      <p className="muted small">Current mode: {data.plaid.configured ? <b>{data.plaid.env}</b> : 'not configured'}</p>
    </div>
  );
}

function guessType(a: Connection['accounts'][number]): string {
  const n = (a.name || '').toLowerCase();
  if (a.kind === 'credit') return 'credit_card';
  if (a.kind === 'loan') return a.subtype === 'mortgage' ? 'mortgage' : 'loan';
  if (a.kind === 'investment' || a.kind === 'brokerage') return 'asset';
  if (a.kind === 'depository') return a.subtype === 'savings' ? 'savings' : 'checking';
  if (/credit|card|visa|mastercard|amex|discover/.test(n)) return 'credit_card';
  if (/mortgage/.test(n)) return 'mortgage';
  if (/loan/.test(n)) return 'loan';
  if (/saving/.test(n)) return 'savings';
  if (/invest|brokerage|401k|ira|roth/.test(n)) return 'asset';
  return 'checking';
}

interface RowState {
  action: 'create' | 'link' | 'ignore';
  name: string;
  type: string;
  localAccountId: number | null;
  startDate: string;
}

/** Step 2: decide what each bank account maps to. */
export function MapAccounts({ connectionId, presetAccountId, onDone }: { connectionId: number; presetAccountId?: number; onDone: () => void }) {
  const { data, run, toast } = useApp();
  const [conn, setConn] = useState<Connection | null>(null);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ connections: Connection[] }>('/connections').then((r) => {
      const c = r.connections.find((x) => x.id === connectionId) ?? null;
      setConn(c);
      if (!c) return;
      const init: Record<string, RowState> = {};
      const defaultStart = addDays(todayISO(), -30);
      c.accounts.forEach((a, i) => {
        init[a.externalId] = {
          // Bank & card accounts are imported by default; investments/loans don't get transactions from Plaid, so they're opt-in.
          action: a.localAccountId ? 'link' : presetAccountId && i === 0 ? 'link' : a.kind === 'investment' || a.kind === 'loan' ? 'ignore' : 'create',
          name: a.name,
          type: guessType(a),
          localAccountId: a.localAccountId ?? (presetAccountId && i === 0 ? presetAccountId : null),
          startDate: defaultStart,
        };
      });
      setRows(init);
    });
  }, [connectionId, presetAccountId]);

  if (!conn) return <div className="spinner" />;
  if (conn.accounts.length === 0) {
    return (
      <div>
        <p>No accounts were returned by this connection yet.</p>
        {conn.error && <p className="error-text">{conn.error}</p>}
        <p className="muted">For SimpleFIN, make sure you connected at least one institution at bridge.simplefin.org. You can retry from Settings → Bank Connections.</p>
        <button className="btn" onClick={onDone}>Close</button>
      </div>
    );
  }

  const set = (id: string, patch: Partial<RowState>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const linkable = data.accounts.filter((a) => !a.closed);

  const submit = async () => {
    const mappings = Object.entries(rows).map(([externalId, r]) => ({
      externalId,
      action: r.action === 'link' && !r.localAccountId ? 'ignore' : r.action,
      name: r.name,
      type: r.type,
      localAccountId: r.localAccountId,
      startDate: r.startDate,
    }));
    setBusy(true);
    const res = await run(
      () => api.post<{ imported: number; matched: number; warnings?: string[] }>(`/connections/${connectionId}/map`, { mappings }),
    );
    setBusy(false);
    if (res) {
      if (res.warnings?.length) toast(res.warnings.join('; '), 'error');
      else if (res.imported === 0) toast('Linked. Your bank may still be preparing transactions — they will appear on the next sync (or press Import in a few minutes).', 'info');
      onDone();
    }
  };

  return (
    <div>
      <p>
        Connected to <b>{conn.institution || 'your bank'}</b>. Choose how each account should be imported. Transactions dated on or after the
        start date will be imported and appear for approval.
      </p>
      {conn.error && <div className="callout callout-warn">{conn.error}</div>}
      <table className="map-table">
        <thead>
          <tr>
            <th>Bank account</th>
            <th>Import as</th>
            <th>Import from</th>
          </tr>
        </thead>
        <tbody>
          {conn.accounts.map((a) => {
            const r = rows[a.externalId];
            if (!r) return null;
            return (
              <tr key={a.externalId}>
                <td>
                  <div className="strong">{a.name}{a.mask ? ` ••${a.mask}` : ''}</div>
                  {a.balance !== null && <div className="muted small">Balance {money(a.balance)}</div>}
                </td>
                <td>
                  <select value={r.action} onChange={(e) => set(a.externalId, { action: e.target.value as RowState['action'] })}>
                    <option value="create">New account</option>
                    <option value="link">Existing account</option>
                    <option value="ignore">Don't import</option>
                  </select>
                  {r.action === 'create' && (
                    <div className="row-gap">
                      <input value={r.name} onChange={(e) => set(a.externalId, { name: e.target.value })} aria-label="Account name" />
                      <select value={r.type} onChange={(e) => set(a.externalId, { type: e.target.value })} aria-label="Account type">
                        {ACCOUNT_TYPES.map((t) => (
                          <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>
                        ))}
                      </select>
                    </div>
                  )}
                  {r.action === 'link' && (
                    <div className="row-gap">
                      <select
                        value={r.localAccountId ?? ''}
                        onChange={(e) => set(a.externalId, { localAccountId: e.target.value ? Number(e.target.value) : null })}
                        aria-label="Existing account"
                      >
                        <option value="">Choose account…</option>
                        {linkable.map((l) => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </td>
                <td>
                  {r.action !== 'ignore' && (
                    <input type="date" value={r.startDate} onChange={(e) => set(a.externalId, { startDate: e.target.value })} aria-label="Import start date" />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">
        New accounts get a starting balance so they match the bank's current balance. When linking an existing account, imported transactions that match
        ones you already entered (same amount, within 10 days) are merged instead of duplicated.
      </p>
      <div className="modal-footer-inline">
        <button className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Importing…' : 'Import transactions'}
        </button>
      </div>
    </div>
  );
}

/** The whole "link a bank" flow: pick provider → authenticate → map accounts. */
export function ConnectBankModal({ onClose, presetAccountId }: { onClose: () => void; presetAccountId?: number }) {
  const { data, toast, bump } = useApp();
  const [provider, setProvider] = useState<'plaid' | 'simplefin'>(data.plaid.configured ? 'plaid' : 'simplefin');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [connectionId, setConnectionId] = useState<number | null>(null);

  const connectPlaid = async () => {
    setBusy(true);
    try {
      const { linkToken } = await api.post<{ linkToken: string }>('/plaid/link-token');
      const result = await openPlaidLink(linkToken);
      if (!result) return;
      const r = await api.post<{ connectionId: number }>('/plaid/exchange', result);
      setConnectionId(r.connectionId);
      bump();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const connectSimplefin = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ connectionId: number }>('/simplefin/claim', { token });
      setConnectionId(r.connectionId);
      bump();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={connectionId ? 'Choose accounts to import' : 'Link a bank or credit card'} onClose={onClose} wide dismissOnBackdrop={!connectionId}>
      {connectionId ? (
        <MapAccounts
          connectionId={connectionId}
          presetAccountId={presetAccountId}
          onDone={() => {
            toast('Accounts linked. New transactions are waiting for your approval.', 'success');
            onClose();
          }}
        />
      ) : (
        <>
          <p className="muted">
            Linked accounts import new transactions automatically (every {data.settings.syncIntervalHours || '—'} hours, configurable in Settings) and
            whenever you press <b>Import</b> in the account. You approve each imported transaction before it counts.
          </p>
          <div className="provider-tabs" role="tablist">
            <button role="tab" aria-selected={provider === 'simplefin'} className={provider === 'simplefin' ? 'active' : ''} onClick={() => setProvider('simplefin')}>
              <b>SimpleFIN Bridge</b>
              <span>Easiest for personal use · ~$15/yr · no developer account</span>
            </button>
            <button role="tab" aria-selected={provider === 'plaid'} className={provider === 'plaid' ? 'active' : ''} onClick={() => setProvider('plaid')}>
              <b>Plaid</b>
              <span>Widely used US aggregator · free trial tier · needs developer keys</span>
            </button>
          </div>
          <LinkHelp provider={provider} />
          {provider === 'simplefin' ? (
            <div className="connect-row">
              <textarea
                placeholder="Paste your SimpleFIN Setup Token here"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                rows={3}
                aria-label="SimpleFIN Setup Token"
              />
              <button className="btn btn-primary" disabled={busy || !token.trim()} onClick={connectSimplefin}>
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          ) : (
            <div className="connect-row">
              <button className="btn btn-primary" disabled={busy || !data.plaid.configured} onClick={connectPlaid}>
                {busy ? 'Opening…' : 'Connect with Plaid'}
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
