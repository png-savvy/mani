import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { Modal, MoneyField } from './ui';
import { ConnectBankModal } from './ConnectBank';
import { BUDGET_TYPES, TRACKING_TYPES, ACCOUNT_TYPE_LABELS, isCreditType, todayISO } from '../../../shared/util';

export default function AddAccountModal({ onClose }: { onClose: () => void }) {
  const { run } = useApp();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'choose' | 'manual' | 'linked'>('choose');
  const [name, setName] = useState('');
  const [type, setType] = useState('checking');
  const [balance, setBalance] = useState(0);
  const [date, setDate] = useState(todayISO());

  if (mode === 'linked') return <ConnectBankModal onClose={onClose} />;

  const save = async () => {
    // Users type what they owe on a credit card/loan as a positive number; store debt as negative.
    const debtType = isCreditType(type) || ['liability', 'mortgage', 'loan'].includes(type);
    const signed = debtType ? -Math.abs(balance) : balance;
    const r = await run(() => api.post<{ id: number }>('/accounts', { name, type, balance: signed, date }), 'Account added');
    if (r) {
      onClose();
      navigate(`/accounts/${r.id}`);
    }
  };

  if (mode === 'choose') {
    return (
      <Modal title="Add Account" onClose={onClose}>
        <div className="choice-cards">
          <button className="choice-card" onClick={() => setMode('linked')}>
            <span className="choice-icon">⇄</span>
            <b>Linked</b>
            <span>Connect to your bank or credit card for automatic transaction import.</span>
          </button>
          <button className="choice-card" onClick={() => setMode('manual')}>
            <span className="choice-icon">✎</span>
            <b>Unlinked</b>
            <span>Enter transactions yourself, or import a file (CSV, OFX, QFX) from your bank.</span>
          </button>
        </div>
      </Modal>
    );
  }

  const debt = isCreditType(type) || ['liability', 'mortgage', 'loan'].includes(type);
  return (
    <Modal
      title="Add Unlinked Account"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => setMode('choose')}>Back</button>
          <button className="btn btn-primary" disabled={!name.trim()} onClick={save}>Add Account</button>
        </>
      }
    >
      <div className="form">
        <label>
          Account nickname
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Chase Checking" />
        </label>
        <label>
          Account type
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <optgroup label="Budget accounts">
              {BUDGET_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
            </optgroup>
            <optgroup label="Tracking accounts (not in budget)">
              {TRACKING_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
            </optgroup>
          </select>
        </label>
        <label>
          {debt ? 'Current balance owed' : 'Current balance'}
          <MoneyField value={balance} onCommit={setBalance} ariaLabel="Balance" />
        </label>
        <label>
          Balance as of
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <p className="muted small">
          {debt
            ? isCreditType(type)
              ? 'A Credit Card Payment category is created automatically. Existing debt is not taken from Ready to Assign — assign money to the payment category to pay it down.'
              : 'Tracking accounts appear in net worth but not in your budget.'
            : 'The starting balance is added to Ready to Assign so you can give every dollar a job.'}
        </p>
      </div>
    </Modal>
  );
}
