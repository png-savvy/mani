import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { openPlaidLink, pendingLink } from '../plaid';
import { Modal } from './ui';
import { MapAccounts } from './ConnectBank';
import { useNavigate } from 'react-router-dom';

/** Plaid sends the user back here after logging in at an OAuth bank (Chase, BofA, ...). */
export default function PlaidOAuthReturn() {
  const { toast, bump } = useApp();
  const navigate = useNavigate();
  const [connectionId, setConnectionId] = useState<number | null>(null);
  const [message, setMessage] = useState('Finishing your bank connection…');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const pending = pendingLink();
    if (!pending) {
      setMessage('This bank connection session expired. Please start again from Add Account.');
      return;
    }
    (async () => {
      try {
        const result = await openPlaidLink(pending.linkToken, { receivedRedirectUri: window.location.href });
        if (!result) return navigate('/budget');
        if (pending.connectionId) {
          await api.post(`/plaid/reauthed/${pending.connectionId}`);
          toast('Connection fixed', 'success');
          bump();
          navigate('/settings');
        } else {
          const r = await api.post<{ connectionId: number }>('/plaid/exchange', result);
          setConnectionId(r.connectionId);
        }
      } catch (e) {
        setMessage((e as Error).message);
      }
    })();
  }, [navigate, toast, bump]);

  if (connectionId) {
    return (
      <Modal title="Choose accounts to import" onClose={() => navigate('/budget')} wide>
        <MapAccounts connectionId={connectionId} onDone={() => { bump(); navigate('/accounts'); }} />
      </Modal>
    );
  }
  return <div className="page"><div className="card">{message}</div></div>;
}
