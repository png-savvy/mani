import { useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { money } from '../format';
import { Modal, MoneyField } from './ui';
import type { Account } from '../types';

export default function ReconcileModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const { run } = useApp();
  const [step, setStep] = useState<'ask' | 'enter'>('ask');
  const [balance, setBalance] = useState(account.bankBalance ?? account.clearedBalance);
  const diff = balance - account.clearedBalance;

  const finish = async (b: number) => {
    const r = await run(() => api.post<{ adjustment: number }>(`/accounts/${account.id}/reconcile`, { balance: b }), 'Account reconciled');
    if (r) onClose();
  };

  return (
    <Modal title={`Reconcile ${account.name}`} onClose={onClose}>
      {step === 'ask' ? (
        <div className="reconcile">
          <p>Is your current account balance</p>
          <div className="big-number">{money(account.clearedBalance)}?</div>
          <p className="muted small">
            Compare with the <b>cleared</b> (posted) balance on your bank's website or app — not including pending transactions.
            {account.bankBalance !== null && <> Your bank last reported {money(account.bankBalance)}.</>}
          </p>
          <div className="row-gap center">
            <button className="btn btn-primary" onClick={() => finish(account.clearedBalance)}>Yes</button>
            <button className="btn" onClick={() => setStep('enter')}>No</button>
          </div>
        </div>
      ) : (
        <div className="reconcile form">
          <label>
            What is your current cleared balance?
            <MoneyField value={balance} onCommit={setBalance} autoFocus ariaLabel="Bank balance" />
          </label>
          {diff === 0 ? (
            <p>Balances match. 🎉</p>
          ) : (
            <p>
              Difference: <b className={diff < 0 ? 'neg' : ''}>{money(diff)}</b>. Look for missing or uncleared transactions first (mark them cleared with the
              <b> C</b> column). If you can't find it, finish with an adjustment transaction for the difference.
            </p>
          )}
          <div className="row-gap">
            <button className="btn btn-ghost" onClick={onClose}>Find the difference first</button>
            <button className="btn btn-primary" onClick={() => finish(balance)}>
              {diff === 0 ? 'Finish reconciling' : `Create adjustment & finish`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
