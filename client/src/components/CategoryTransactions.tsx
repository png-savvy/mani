import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { fmtDate, fmtMonth, money } from '../format';
import { Sheet } from './ui';
import TxnEditor from './TxnEditor';
import type { Txn } from '../types';

/** Transactions that used a category (this month, or ever), shown in the category panel. Tap one to edit it. */
export default function CategoryTransactions({ categoryId, month }: { categoryId: number; month: string }) {
  const { data, version, toast } = useApp();
  const [range, setRange] = useState<'month' | 'all'>('month');
  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [editing, setEditing] = useState<Txn | null>(null);

  useEffect(() => {
    setTxns(null);
    const qs = new URLSearchParams({ categoryId: String(categoryId) });
    if (range === 'month') qs.set('month', month);
    api
      .get<Txn[]>(`/transactions?${qs}`)
      .then(setTxns)
      .catch((e) => toast(e.message, 'error'));
  }, [categoryId, month, range, version, toast]);

  const rows = useMemo(() => {
    const onBudget = new Set(data.accounts.filter((a) => a.onBudget).map((a) => a.id));
    return (txns ?? [])
      // A transfer to a tracking account shows up on both sides; only the budget side carries the category.
      .filter((t) => onBudget.has(t.accountId))
      .map((t) => ({
        t,
        // For split transactions, only this category's part counts.
        amount: t.isSplit ? t.subtransactions.filter((s) => s.categoryId === categoryId).reduce((s, x) => s + x.amount, 0) : t.amount,
      }));
  }, [txns, data.accounts, categoryId]);

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const registerLink = `/accounts?categoryId=${categoryId}${range === 'month' ? `&month=${month}` : ''}`;

  return (
    <div className="cat-txns">
      <div className="cat-txns-head">
        <h3>Transactions</h3>
        <div className="seg seg-small" role="group" aria-label="Date range">
          <button className={range === 'month' ? 'active' : ''} onClick={() => setRange('month')}>
            {fmtMonth(month, 'short')}
          </button>
          <button className={range === 'all' ? 'active' : ''} onClick={() => setRange('all')}>
            All time
          </button>
        </div>
      </div>
      {txns === null ? (
        <div className="spinner small-spinner" />
      ) : rows.length === 0 ? (
        <p className="muted small">No transactions {range === 'month' ? 'this month' : 'yet'}.</p>
      ) : (
        <>
          <ul className="cat-txn-list">
            {rows.slice(0, 50).map(({ t, amount }) => (
              <li key={t.id}>
                <button className={`cat-txn ${t.approved ? '' : 'unapproved'}`} onClick={() => setEditing(t)}>
                  <span className="cat-txn-main">
                    <span className="ellipsis">{t.transferAccountName ? `Transfer : ${t.transferAccountName}` : t.payeeName ?? '—'}</span>
                    <span className={`num ${amount > 0 ? 'pos' : ''}`}>{money(amount)}</span>
                  </span>
                  <span className="cat-txn-sub">
                    <span>
                      {fmtDate(t.date)} · {t.accountName}
                      {t.isSplit && ' · split'}
                    </span>
                    {!t.approved && <span className="tag">To approve</span>}
                  </span>
                  {t.memo && <span className="cat-txn-memo ellipsis">{t.memo}</span>}
                </button>
              </li>
            ))}
          </ul>
          <div className="cat-txns-foot">
            <span className="muted small">
              {rows.length} transaction{rows.length === 1 ? '' : 's'} · total <b>{money(total)}</b>
            </span>
            <Link to={registerLink} className="small">
              {rows.length > 50 ? `See all ${rows.length}` : 'Open in register'} →
            </Link>
          </div>
        </>
      )}
      {editing && (
        <Sheet title="Edit transaction" onClose={() => setEditing(null)}>
          <TxnEditor txn={editing} accountId={editing.accountId} showAccount layout="stacked" onDone={() => setEditing(null)} />
        </Sheet>
      )}
    </div>
  );
}
