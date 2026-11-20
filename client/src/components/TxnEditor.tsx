import { useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { money } from '../format';
import { CategorySelect, Confirm, MoneyField, PayeeField, TRANSFER_PREFIX } from './ui';
import CategoryPicker from './CategoryPicker';
import { useIsMobile } from '../hooks';
import type { BudgetMonth, Txn } from '../types';
import { FLAGS, FREQUENCIES, FREQUENCY_LABELS, currentMonth, todayISO } from '../../../shared/util';

interface SubLine {
  categoryId: number | null;
  memo: string;
  outflow: number;
  inflow: number;
}

/**
 * Inline transaction editor used for new and existing transactions.
 * Handles payees vs transfers, category rules, splits and (for new ones) repeating schedules.
 */
export default function TxnEditor({
  txn,
  accountId,
  showAccount,
  onDone,
  layout = 'auto',
}: {
  txn: Txn | null;
  accountId: number | null;
  showAccount: boolean;
  onDone: () => void;
  /** 'stacked' forces the touch/stacked form (used inside dialogs on desktop too). */
  layout?: 'auto' | 'stacked';
}) {
  const { data, run, toast } = useApp();
  const [acct, setAcct] = useState<number | null>(txn?.accountId ?? accountId ?? data.accounts.find((a) => !a.closed)?.id ?? null);
  const [date, setDate] = useState(txn?.date ?? todayISO());
  const [payee, setPayee] = useState(
    txn ? (txn.transferAccountName ? TRANSFER_PREFIX + txn.transferAccountName : txn.payeeName ?? '') : '',
  );
  const [categoryId, setCategoryId] = useState<number | null>(txn ? txn.categoryId ?? txn.counterpartCategoryId : null);
  const [memo, setMemo] = useState(txn?.memo ?? '');
  const [outflow, setOutflow] = useState(txn && txn.amount < 0 ? -txn.amount : 0);
  const [inflow, setInflow] = useState(txn && txn.amount > 0 ? txn.amount : 0);
  const [cleared, setCleared] = useState<Txn['cleared']>(txn?.cleared ?? 'uncleared');
  const [flag, setFlag] = useState<string | null>(txn?.flag ?? null);
  const [repeat, setRepeat] = useState('never');
  const [split, setSplit] = useState<SubLine[] | null>(
    txn?.isSplit
      ? txn.subtransactions.map((s) => ({ categoryId: s.categoryId, memo: s.memo, outflow: s.amount < 0 ? -s.amount : 0, inflow: s.amount > 0 ? s.amount : 0 }))
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [isInflow, setIsInflow] = useState(txn ? txn.amount > 0 : false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isMobile = useIsMobile();
  const stacked = isMobile || layout === 'stacked';

  const account = data.accounts.find((a) => a.id === acct);
  const transferAccount = useMemo(() => {
    if (!payee.startsWith(TRANSFER_PREFIX)) return null;
    const name = payee.slice(TRANSFER_PREFIX.length).trim();
    return data.accounts.find((a) => a.name === name && a.id !== acct) ?? null;
  }, [payee, data.accounts, acct]);

  // Which category rule applies (mirrors the server).
  let categoryMode: 'normal' | 'none-transfer' | 'none-tracking' = 'normal';
  if (account && transferAccount) {
    if (account.onBudget && transferAccount.onBudget) categoryMode = 'none-transfer';
    else if (!account.onBudget && !transferAccount.onBudget) categoryMode = 'none-tracking';
  } else if (account && !account.onBudget) categoryMode = 'none-tracking';

  const amount = inflow - outflow;
  const splitTotal = split ? split.reduce((s, l) => s + l.inflow - l.outflow, 0) : 0;

  const onPayeeChange = (v: string) => {
    setPayee(v);
    if (categoryId === null && !v.startsWith(TRANSFER_PREFIX)) {
      const p = data.payees.find((x) => x.name.toLowerCase() === v.trim().toLowerCase());
      if (p?.lastCategoryId && data.categories.some((c) => c.id === p.lastCategoryId && c.kind !== 'cc_payment')) setCategoryId(p.lastCategoryId);
    }
  };

  /** Current balance of each category (Ready to Assign for the income category), for the before/after popup. */
  const fetchBalances = async () => {
    const v = await api.get<BudgetMonth>(`/budget/${currentMonth()}`);
    const m = new Map(v.groups.flatMap((g) => g.categories.map((c) => [c.id, c.available] as const)));
    const income = data.categories.find((c) => c.kind === 'income');
    if (income) m.set(income.id, v.readyToAssign.total);
    return m;
  };

  const save = async (andNew: boolean) => {
    if (!acct) return toast('Choose an account', 'error');
    if (payee.startsWith(TRANSFER_PREFIX) && !transferAccount) return toast('Unknown transfer account', 'error');
    if (split && splitTotal !== amount) return toast(`Split lines must add up to the total (${money(amount - splitTotal)} remaining)`, 'error');
    const body = {
      accountId: acct,
      date,
      amount,
      payeeName: transferAccount ? null : payee.trim() || null,
      transferAccountId: transferAccount?.id ?? null,
      categoryId: split || categoryMode !== 'normal' ? null : categoryId,
      memo,
      cleared,
      flag,
      approved: true,
      subtransactions: split ? split.map((l) => ({ categoryId: l.categoryId, memo: l.memo, amount: l.inflow - l.outflow })) : null,
    };
    setBusy(true);
    let ok;
    if (!txn && repeat !== 'never') {
      if (split) {
        setBusy(false);
        return toast('Repeating split transactions are not supported — save it once, then create the schedule without the split.', 'error');
      }
      ok = await run(() => api.post('/scheduled', { ...body, frequency: repeat }), date > todayISO() ? 'Scheduled' : 'Saved and scheduled');
    } else {
      // Changing an existing transaction's category: show what it did to the balances, with a way back.
      const oldCat = txn ? txn.categoryId : null;
      const newCat = body.categoryId;
      const recategorized = !!txn && !txn.isSplit && !split && categoryMode === 'normal' && oldCat !== newCat;
      const before = recategorized ? await fetchBalances().catch(() => null) : null;
      ok = await run(() => (txn ? api.put(`/transactions/${txn.id}`, body) : api.post('/transactions', body)));
      if (ok !== undefined && recategorized && txn) {
        const after = await fetchBalances().catch(() => null);
        const name = (id: number) => {
          const c = data.categories.find((x) => x.id === id);
          return c?.kind === 'income' ? 'Ready to Assign' : c?.name ?? 'Category';
        };
        const line = (id: number | null) =>
          id !== null && before?.has(id) && after?.has(id) ? `${name(id)}: ${money(before.get(id)!)} → ${money(after.get(id)!)}` : null;
        const to = line(newCat);
        const from = line(oldCat);
        // Undo restores the category and approval (other edits made in the same save are kept), and the category this
        // payee is remembered under — unless the payee itself was changed too.
        const samePayee = (txn.payeeName ?? '') === (body.payeeName ?? '');
        const undo = {
          categoryId: oldCat,
          approved: txn.approved,
          payeeLastCategoryId: samePayee && txn.payeeId ? data.payees.find((x) => x.id === txn.payeeId)?.lastCategoryId ?? null : undefined,
        };
        // Red when the category it went into is now overspent.
        const overspent = newCat !== null && (after?.get(newCat) ?? 0) < 0;
        toast(newCat === null ? 'Sent back to review' : to ?? 'Categorized', overspent ? 'error' : 'success', {
          lines: from ? [from] : undefined,
          duration: 2000,
          action: { label: 'Undo', onClick: () => run(() => api.post(`/transactions/${txn.id}/undo-categorize`, { undo }), 'Put back') },
        });
      }
    }
    setBusy(false);
    if (ok === undefined) return;
    if (andNew) {
      setPayee('');
      setCategoryId(null);
      setMemo('');
      setOutflow(0);
      setInflow(0);
      setSplit(null);
      setFlag(null);
    } else onDone();
  };

  const remove = async () => {
    if (!txn) return;
    const r = await run(() => api.del(`/transactions/${txn.id}`), 'Transaction deleted');
    if (r !== undefined) onDone();
  };

  const deleteConfirm = confirmDelete && (
    <Confirm
      title="Delete transaction?"
      message={txn?.transferAccountId ? 'This transfer is deleted from both accounts.' : 'This cannot be undone.'}
      danger
      confirmLabel="Delete"
      onConfirm={remove}
      onClose={() => setConfirmDelete(false)}
    />
  );

  const splitRemaining = amount - splitTotal;
  /** A split line holding this net amount (negative = outflow). */
  const withNet = (l: SubLine, net: number): SubLine => ({ ...l, outflow: net < 0 ? -net : 0, inflow: net > 0 ? net : 0 });
  const hasEmptySplitLine = !!split?.some((l) => !l.inflow && !l.outflow);

  const splitEditor = split && (
    <div className="split-box">
      {split.map((l, i) => (
        <div className="split-line" key={i}>
          <CategorySelect value={l.categoryId} onChange={(v) => setSplit(split.map((x, j) => (j === i ? { ...x, categoryId: v } : x)))} />
          <input value={l.memo} placeholder="Memo" onChange={(e) => setSplit(split.map((x, j) => (j === i ? { ...x, memo: e.target.value } : x)))} />
          <MoneyField
            value={l.outflow}
            allowNegative={false}
            placeholder="Outflow"
            ariaLabel="Split outflow"
            onCommit={(v) => setSplit(split.map((x, j) => (j === i ? { ...x, outflow: v, inflow: v ? 0 : x.inflow } : x)))}
          />
          <MoneyField
            value={l.inflow}
            allowNegative={false}
            placeholder="Inflow"
            ariaLabel="Split inflow"
            onCommit={(v) => setSplit(split.map((x, j) => (j === i ? { ...x, inflow: v, outflow: v ? 0 : x.outflow } : x)))}
          />
          <button className="mini-btn" onClick={() => setSplit(split.length > 2 ? split.filter((_, j) => j !== i) : split)} aria-label="Remove line">×</button>
          {splitRemaining !== 0 && (
            <button
              className={`split-rest ${!l.inflow && !l.outflow ? 'primary' : ''}`}
              onClick={() => setSplit(split.map((x, j) => (j === i ? withNet(x, x.inflow - x.outflow + splitRemaining) : x)))}
            >
              {!l.inflow && !l.outflow ? `Assign remaining ${money(splitRemaining)} here` : `Add remaining ${money(splitRemaining)} to this line`}
            </button>
          )}
        </div>
      ))}
      <div className="split-foot">
        <button className="btn btn-small btn-ghost" onClick={() => setSplit([...split, withNet({ categoryId: null, memo: '', outflow: 0, inflow: 0 }, hasEmptySplitLine ? 0 : splitRemaining)])}>
          {splitRemaining !== 0 && !hasEmptySplitLine ? `+ Add line with remaining ${money(splitRemaining)}` : '+ Add split line'}
        </button>
        <span className={splitRemaining === 0 ? 'split-ok' : 'neg'}>{splitRemaining === 0 ? '✓ Fully assigned' : `Remaining to assign: ${money(splitRemaining)}`}</span>
        <button className="btn btn-small btn-ghost" onClick={() => setSplit(null)}>Remove split</button>
      </div>
    </div>
  );

  const startSplit = () =>
    setSplit([
      { categoryId, memo: '', outflow, inflow },
      { categoryId: null, memo: '', outflow: 0, inflow: 0 },
    ]);

  if (stacked) {
    // Touch layout: one big amount with an outflow/inflow switch, stacked fields, full-screen category list.
    const amountAbs = isInflow ? inflow : outflow;
    const setDirection = (toInflow: boolean) => {
      if (toInflow === isInflow) return;
      const v = amountAbs;
      setIsInflow(toInflow);
      setOutflow(toInflow ? 0 : v);
      setInflow(toInflow ? v : 0);
    };
    const catName = data.categories.find((c) => c.id === categoryId)?.name;
    return (
      <div className="txn-editor txn-mobile">
        <div className="amount-box">
          <div className="seg" role="group" aria-label="Direction">
            <button className={!isInflow ? 'active out' : ''} onClick={() => setDirection(false)}>− Outflow</button>
            <button className={isInflow ? 'active in' : ''} onClick={() => setDirection(true)}>+ Inflow</button>
          </div>
          <MoneyField
            className={`amount-big ${isInflow ? 'pos' : 'neg'}`}
            value={amountAbs}
            allowNegative={false}
            autoFocus={!txn}
            ariaLabel="Amount"
            onCommit={(v) => {
              setOutflow(isInflow ? 0 : v);
              setInflow(isInflow ? v : 0);
            }}
          />
        </div>

        <label className="m-field">
          <span>Payee</span>
          <PayeeField value={payee} onChange={onPayeeChange} excludeAccountId={acct ?? undefined} listId={`m-payees-${txn?.id ?? 'new'}`} />
        </label>

        <div className="m-field">
          <span>Category</span>
          {split ? (
            <span className="muted">Split — see lines below</span>
          ) : categoryMode === 'none-transfer' ? (
            <span className="muted">Transfers between budget accounts need no category</span>
          ) : categoryMode === 'none-tracking' ? (
            <span className="muted">Tracking accounts don't use categories</span>
          ) : (
            <button className={`picker-btn ${catName ? '' : 'empty'}`} onClick={() => setPicking(true)}>
              {catName ?? 'Choose a category'} <span aria-hidden="true">›</span>
            </button>
          )}
        </div>

        {(showAccount || !txn) && (
          <label className="m-field">
            <span>Account</span>
            <select value={acct ?? ''} onChange={(e) => setAcct(Number(e.target.value))}>
              {data.accounts.filter((a) => !a.closed || a.id === acct).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="m-field">
          <span>Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="m-field">
          <span>Memo</span>
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Optional" />
        </label>
        <div className="m-row">
          <label className="m-field">
            <span>Status</span>
            <select value={cleared} onChange={(e) => setCleared(e.target.value as Txn['cleared'])}>
              <option value="uncleared">Uncleared</option>
              <option value="cleared">Cleared</option>
              {txn?.cleared === 'reconciled' && <option value="reconciled">Reconciled</option>}
            </select>
          </label>
          <label className="m-field">
            <span>Flag</span>
            <select value={flag ?? ''} onChange={(e) => setFlag(e.target.value || null)}>
              <option value="">None</option>
              {FLAGS.map((f) => (
                <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)}</option>
              ))}
            </select>
          </label>
        </div>
        {!txn && (
          <label className="m-field">
            <span>Repeat</span>
            <select value={repeat} onChange={(e) => setRepeat(e.target.value)}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
              ))}
            </select>
          </label>
        )}
        {!split && categoryMode === 'normal' && !transferAccount && (
          <button className="btn btn-ghost btn-block" onClick={startSplit}>Split into several categories</button>
        )}
        {splitEditor}
        {txn?.importedPayee && <p className="muted small">Bank description: {txn.importedPayee}</p>}
        {txn?.amazon && (
          <div className="amazon-items small">
            <b>Amazon order</b>{' '}
            <a href={`https://www.amazon.com/gp/your-account/order-details?orderID=${encodeURIComponent(txn.amazon.orderId)}`} target="_blank" rel="noreferrer">
              {txn.amazon.orderId}
            </a>
            {txn.amazon.items.length > 0 ? (
              <ul>
                {txn.amazon.items.map((it) => (
                  <li key={it}>{it}</li>
                ))}
              </ul>
            ) : (
              <p className="muted">Item details haven't arrived yet.</p>
            )}
          </div>
        )}
        {txn?.autoTransfer && txn.transferAccountId && (
          <p className="muted small">Mani found the other half of this transfer in your other account and joined them. Pick a payee instead to separate them.</p>
        )}

        <div className="m-actions">
          {txn && <button className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>Delete</button>}
          <button className="btn btn-primary" disabled={busy} onClick={() => save(false)}>
            {txn && !txn.approved ? 'Save & Approve' : 'Save'}
          </button>
        </div>
        {picking && (
          <CategoryPicker
            value={categoryId}
            onClose={() => setPicking(false)}
            onClear={() => {
              setCategoryId(null);
              setPicking(false);
            }}
            onSelect={(id) => {
              setCategoryId(id);
              setPicking(false);
              if (data.categories.find((c) => c.id === id)?.kind === 'income') setDirection(true);
            }}
          />
        )}
        {deleteConfirm}
      </div>
    );
  }

  const keySave = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target as HTMLElement).classList.contains('money-input')) {
      e.preventDefault();
      save(false);
    }
    if (e.key === 'Escape') onDone();
  };

  return (
    <div className="txn-editor" onKeyDown={keySave}>
      <div className="te-grid">
        {showAccount && (
          <label>
            Account
            <select value={acct ?? ''} onChange={(e) => setAcct(Number(e.target.value))}>
              {data.accounts.filter((a) => !a.closed || a.id === acct).map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
        )}
        <label>
          Date
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="te-payee">
          Payee
          <PayeeField value={payee} onChange={onPayeeChange} excludeAccountId={acct ?? undefined} autoFocus={!txn} listId={`payees-${txn?.id ?? 'new'}`} />
        </label>
        <label className="te-cat">
          Category
          {split ? (
            <span className="muted">Split (see below)</span>
          ) : categoryMode === 'none-transfer' ? (
            <span className="muted">Transfers between budget accounts need no category</span>
          ) : categoryMode === 'none-tracking' ? (
            <span className="muted">Tracking accounts don't use categories</span>
          ) : (
            <CategorySelect value={categoryId} onChange={setCategoryId} />
          )}
        </label>
        <label className="te-memo">
          Memo
          <input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="Memo" />
        </label>
        <label>
          Outflow
          <MoneyField
            value={outflow}
            allowNegative={false}
            onCommit={(v) => {
              setOutflow(v);
              if (v) setInflow(0);
            }}
            ariaLabel="Outflow"
          />
        </label>
        <label>
          Inflow
          <MoneyField
            value={inflow}
            allowNegative={false}
            onCommit={(v) => {
              setInflow(v);
              if (v) setOutflow(0);
            }}
            ariaLabel="Inflow"
          />
        </label>
      </div>

      {splitEditor}

      <div className="te-actions">
        <div className="te-left">
          {!split && categoryMode === 'normal' && !transferAccount && (
            <button className="btn btn-small btn-ghost" onClick={startSplit}>
              Split
            </button>
          )}
          <select value={cleared} onChange={(e) => setCleared(e.target.value as Txn['cleared'])} aria-label="Cleared status">
            <option value="uncleared">Uncleared</option>
            <option value="cleared">Cleared</option>
            {txn?.cleared === 'reconciled' && <option value="reconciled">Reconciled</option>}
          </select>
          <select value={flag ?? ''} onChange={(e) => setFlag(e.target.value || null)} aria-label="Flag">
            <option value="">No flag</option>
            {FLAGS.map((f) => (
              <option key={f} value={f}>{f[0].toUpperCase() + f.slice(1)} flag</option>
            ))}
          </select>
          {!txn && (
            <select value={repeat} onChange={(e) => setRepeat(e.target.value)} aria-label="Repeat">
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>{f === 'never' ? 'Repeat: never' : `Repeat: ${FREQUENCY_LABELS[f]}`}</option>
              ))}
            </select>
          )}
        </div>
        <div className="te-right">
          {txn?.cleared === 'reconciled' && <span className="muted small">This transaction is reconciled — changing its amount will change your reconciled balance.</span>}
          {txn && <button className="btn btn-small btn-danger-ghost" onClick={() => setConfirmDelete(true)}>Delete</button>}
          <button className="btn btn-small btn-ghost" onClick={onDone}>Cancel</button>
          {!txn && (
            <button className="btn btn-small" disabled={busy} onClick={() => save(true)}>Save and add another</button>
          )}
          <button className="btn btn-small btn-primary" disabled={busy} onClick={() => save(false)}>{txn && !txn.approved ? 'Save & Approve' : 'Save'}</button>
        </div>
      </div>
      {deleteConfirm}
    </div>
  );
}
