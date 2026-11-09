import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { money } from '../format';
import { Confirm, Modal } from './ui';
import type { Account } from '../types';
import { ACCOUNT_TYPE_LABELS, type AccountType } from '../../../shared/util';

export default function AccountSettingsModal({ account, onClose, onLink }: { account: Account; onClose: () => void; onLink: () => void }) {
  const { run } = useApp();
  const navigate = useNavigate();
  const [name, setName] = useState(account.name);
  const [note, setNote] = useState(account.note);
  const [confirm, setConfirm] = useState<'delete' | 'close' | 'unlink' | null>(null);

  const save = async () => {
    const r = await run(() => api.put(`/accounts/${account.id}`, { name, note }), 'Saved');
    if (r !== undefined) onClose();
  };

  return (
    <Modal
      title="Edit Account"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-danger-ghost" onClick={() => setConfirm('delete')}>Delete</button>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={!name.trim()}>Save</button>
        </>
      }
    >
      <div className="form">
        <label>
          Account nickname
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Notes
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
        </label>
        <p className="muted small">
          Type: {ACCOUNT_TYPE_LABELS[account.type as AccountType] ?? account.type} · {account.onBudget ? 'Budget account' : 'Tracking account'}
        </p>
        <div className="row-gap">
          {account.linked ? (
            <button className="btn btn-small" onClick={() => setConfirm('unlink')}>Unlink from bank</button>
          ) : (
            <button
              className="btn btn-small"
              onClick={() => {
                onClose();
                onLink();
              }}
            >
              Link to bank
            </button>
          )}
          <button
            className="btn btn-small"
            onClick={() => (account.closed ? run(() => api.put(`/accounts/${account.id}`, { closed: false })).then(onClose) : setConfirm('close'))}
          >
            {account.closed ? 'Reopen account' : 'Close account'}
          </button>
        </div>
      </div>
      {confirm === 'close' && (
        <Confirm
          title="Close account?"
          message={
            account.balance !== 0 ? (
              <p>
                This account still has a balance of <b>{money(account.balance)}</b>. Usually you'd transfer the money out (or reconcile to zero) before
                closing. Close anyway?
              </p>
            ) : (
              <p>Closed accounts are hidden from the sidebar but keep their history.</p>
            )
          }
          confirmLabel="Close account"
          onConfirm={() => run(() => api.put(`/accounts/${account.id}`, { closed: true })).then(onClose)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'unlink' && (
        <Confirm
          title="Unlink account?"
          message="Automatic import will stop for this account. Existing transactions are kept."
          confirmLabel="Unlink"
          onConfirm={() => run(() => api.post(`/accounts/${account.id}/unlink`)).then(onClose)}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === 'delete' && (
        <Confirm
          title={`Delete ${account.name}?`}
          danger
          confirmLabel="Delete account"
          message={
            <p>
              This permanently deletes the account and all of its transactions, which changes your budget history. Transfers to other accounts are kept
              there as normal transactions. <b>Closing</b> the account is usually better.
            </p>
          }
          onConfirm={() =>
            run(() => api.del(`/accounts/${account.id}`), 'Account deleted').then((r) => {
              if (r !== undefined) {
                onClose();
                navigate('/accounts');
              }
            })
          }
          onClose={() => setConfirm(null)}
        />
      )}
    </Modal>
  );
}
