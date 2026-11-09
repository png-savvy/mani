import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { fmtDate, money } from '../format';
import { CategorySelect, Confirm, Modal, MoneyField, PayeeField, TRANSFER_PREFIX } from './ui';
import type { Scheduled } from '../types';
import { FREQUENCIES, FREQUENCY_LABELS, addDays, todayISO, type Frequency } from '../../../shared/util';

export default function ScheduledPage() {
  const { version, run } = useApp();
  const [list, setList] = useState<Scheduled[]>([]);
  const [editing, setEditing] = useState<Scheduled | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Scheduled | null>(null);

  useEffect(() => {
    api.get<Scheduled[]>('/scheduled').then(setList);
  }, [version]);

  return (
    <div className="page">
      <header className="page-head">
        <h1>Scheduled Transactions</h1>
        <button className="btn btn-small btn-primary" onClick={() => setEditing('new')}>+ New scheduled transaction</button>
      </header>
      <section className="card">
        <p className="muted small">Scheduled transactions are entered automatically on their date (the server checks every few minutes).</p>
        {list.length === 0 ? (
          <p>Nothing scheduled. Tip: when adding a transaction, choose a “Repeat” frequency.</p>
        ) : (
          <table className="simple-table">
            <thead>
              <tr>
                <th>Next date</th>
                <th>Frequency</th>
                <th>Account</th>
                <th>Payee</th>
                <th>Category</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr key={s.id}>
                  <td>{fmtDate(s.nextDate)}</td>
                  <td>{FREQUENCY_LABELS[s.frequency as Frequency]}</td>
                  <td>{s.accountName}</td>
                  <td>{s.transferAccountName ? `Transfer : ${s.transferAccountName}` : s.payeeName}</td>
                  <td className="muted">{s.categoryName ?? ''}</td>
                  <td className={`num ${s.amount < 0 ? 'neg' : 'pos'}`}>{money(s.amount)}</td>
                  <td className="num nowrap">
                    <button className="btn btn-tiny btn-ghost" onClick={() => run(() => api.post(`/scheduled/${s.id}/enter-now`), 'Entered')}>Enter now</button>
                    <button className="btn btn-tiny btn-ghost" onClick={() => run(() => api.post(`/scheduled/${s.id}/skip`), 'Skipped')}>Skip next</button>
                    <button className="btn btn-tiny btn-ghost" onClick={() => setEditing(s)}>Edit</button>
                    <button className="btn btn-tiny btn-danger-ghost" onClick={() => setDeleting(s)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {editing && <ScheduledEditor s={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <Confirm
          title="Delete scheduled transaction?"
          danger
          confirmLabel="Delete"
          message="Future occurrences will no longer be entered. Transactions already entered are kept."
          onConfirm={() => run(() => api.del(`/scheduled/${deleting.id}`))}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

function ScheduledEditor({ s, onClose }: { s: Scheduled | null; onClose: () => void }) {
  const { data, run, toast } = useApp();
  const [accountId, setAccountId] = useState<number | null>(s?.accountId ?? data.accounts.find((a) => !a.closed)?.id ?? null);
  const [date, setDate] = useState(s?.nextDate ?? addDays(todayISO(), 1));
  const [frequency, setFrequency] = useState(s?.frequency ?? 'monthly');
  const [payee, setPayee] = useState(s ? (s.transferAccountName ? TRANSFER_PREFIX + s.transferAccountName : s.payeeName ?? '') : '');
  const [categoryId, setCategoryId] = useState<number | null>(s?.categoryId ?? null);
  const [memo, setMemo] = useState(s?.memo ?? '');
  const [outflow, setOutflow] = useState(s && s.amount < 0 ? -s.amount : 0);
  const [inflow, setInflow] = useState(s && s.amount > 0 ? s.amount : 0);

  const transfer = payee.startsWith(TRANSFER_PREFIX)
    ? data.accounts.find((a) => a.name === payee.slice(TRANSFER_PREFIX.length).trim() && a.id !== accountId) ?? null
    : null;

  const save = async () => {
    if (!accountId) return toast('Choose an account', 'error');
    if (payee.startsWith(TRANSFER_PREFIX) && !transfer) return toast('Unknown transfer account', 'error');
    const body = {
      accountId,
      date,
      frequency,
      amount: inflow - outflow,
      payeeName: transfer ? null : payee,
      transferAccountId: transfer?.id ?? null,
      categoryId,
      memo,
    };
    const r = await run(() => (s ? api.put(`/scheduled/${s.id}`, body) : api.post('/scheduled', body)), 'Saved');
    if (r !== undefined) onClose();
  };

  return (
    <Modal
      title={s ? 'Edit scheduled transaction' : 'New scheduled transaction'}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save}>Save</button>
        </>
      }
    >
      <div className="form grid-2">
        <label>
          Account
          <select value={accountId ?? ''} onChange={(e) => setAccountId(Number(e.target.value))}>
            {data.accounts.filter((a) => !a.closed).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </label>
        <label>
          Next date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Repeat
          <select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>)}
          </select>
        </label>
        <label>
          Payee
          <PayeeField value={payee} onChange={setPayee} excludeAccountId={accountId ?? undefined} listId="sched-payees" />
        </label>
        <label>
          Category
          <CategorySelect value={categoryId} onChange={setCategoryId} />
        </label>
        <label>
          Memo
          <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
        <label>
          Outflow
          <MoneyField value={outflow} allowNegative={false} onCommit={(v) => { setOutflow(v); if (v) setInflow(0); }} ariaLabel="Outflow" />
        </label>
        <label>
          Inflow
          <MoneyField value={inflow} allowNegative={false} onCommit={(v) => { setInflow(v); if (v) setOutflow(0); }} ariaLabel="Inflow" />
        </label>
      </div>
    </Modal>
  );
}
