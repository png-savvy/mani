import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { Confirm } from './ui';

interface Status {
  connected: boolean;
  lastImport: string | null;
  lastError: string | null;
  charges: number;
  matched: number;
  orders: number;
}

/** Settings → Amazon: the token the Mani Amazon extension uses, and how it's doing. */
export default function AmazonSettings() {
  const { run } = useApp();
  const [status, setStatus] = useState<Status | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(() => {
    api.get<Status>('/amazon').then(setStatus).catch(() => {});
  }, []);
  useEffect(load, [load]);

  const create = async () => {
    const r = await run(() => api.post<{ token: string }>('/amazon/token'));
    if (r) setToken(r.token);
    load();
  };

  return (
    <section className="card">
      <h2>Amazon</h2>
      <p className="muted small">
        The Mani Amazon extension for Chrome reads your Amazon orders (while you're signed in to Amazon) and sends them here, so Amazon
        purchases from your bank show what you actually bought.
      </p>

      {status && (
        <p className="small">
          {status.lastImport ? (
            <>
              Last update from the extension: {new Date(status.lastImport).toLocaleString()} · {status.matched} of {status.charges} Amazon charges
              matched to bank transactions
            </>
          ) : status.connected ? (
            'Waiting for the extension to send its first update.'
          ) : (
            'Not set up yet.'
          )}
        </p>
      )}
      {status?.lastError && <p className="callout callout-warn">The extension reported: {status.lastError}</p>}

      {token && (
        <div className="callout">
          <b>Your extension token</b> — paste it into the extension's settings. It's shown only this once.
          <code className="token-box">{token}</code>
          <button className="btn btn-small" onClick={() => navigator.clipboard?.writeText(token)}>Copy</button>
        </div>
      )}

      <div className="row-gap">
        <button className="btn" onClick={create}>{status?.connected ? 'Create a new token' : 'Create extension token'}</button>
        {status?.connected && (
          <button className="btn btn-ghost" onClick={() => setRevoking(true)}>Disconnect extension</button>
        )}
      </div>

      {revoking && (
        <Confirm
          title="Disconnect the Amazon extension?"
          danger
          confirmLabel="Disconnect"
          message="The extension's token stops working. Amazon details already in your transactions are kept."
          onConfirm={() => run(() => api.del('/amazon/token'), 'Extension disconnected').then(() => {
            setToken(null);
            load();
          })}
          onClose={() => setRevoking(false)}
        />
      )}
    </section>
  );
}
