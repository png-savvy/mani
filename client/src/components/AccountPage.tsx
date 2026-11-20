import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { fmtDate, fmtMonth, money, timeAgo } from '../format';
import { CategorySelect, Confirm, Sheet } from './ui';
import CategoryPicker from './CategoryPicker';
import { useIsMobile } from '../hooks';
import TxnEditor from './TxnEditor';
import AmazonItems, { displayMemo } from './AmazonItems';
import ReconcileModal from './ReconcileModal';
import FileImportModal from './FileImportModal';
import AccountSettingsModal from './AccountSettingsModal';
import { ConnectBankModal } from './ConnectBank';
import type { Account, BudgetMonth, Scheduled, Txn } from '../types';
import { FREQUENCY_LABELS, currentMonth, type Frequency } from '../../../shared/util';

const PAGE = 300;

/** What the server reports after categorizing: balances before/after, and what's needed to undo it. */
interface Categorized {
  to: { id: number; name: string; before: number; after: number } | null;
  from: { id: number; name: string; before: number; after: number } | null;
  undo: unknown;
}

/** The register for one account, all accounts, a category — or, with `review`, everything from every account still to review. */
export default function AccountPage({ review = false }: { review?: boolean }) {
  const params = useParams();
  const [search] = useSearchParams();
  const accountId = params.accountId && !review ? Number(params.accountId) : null;
  const categoryId = search.get('categoryId') ? Number(search.get('categoryId')) : null;
  const month = search.get('month');
  // One review list for all accounts: everything not yet approved or still missing a category (at /review).
  const legacyReviewLink = !review && (search.get('review') === '1' || search.get('uncategorized') === '1' || search.get('unapproved') === '1');
  const reviewOnly = review;
  const { data, version, run, toast } = useApp();
  const account = review ? null : (data.accounts.find((a) => a.id === accountId) ?? null);
  const totalToReview = data.accounts.reduce((s, a) => s + a.reviewCount, 0);

  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [modal, setModal] = useState<'reconcile' | 'file' | 'settings' | 'link' | 'delete' | null>(null);
  const [bulkCat, setBulkCat] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [pickFor, setPickFor] = useState<Txn | null>(null);
  // In the review list, each category's current balance is shown next to it.
  const [catBalances, setCatBalances] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    if (!review) return;
    api
      .get<BudgetMonth>(`/budget/${currentMonth()}`)
      .then((v) => setCatBalances(new Map(v.groups.flatMap((g) => g.categories.map((c) => [c.id, c.available] as const)))))
      .catch(() => {});
  }, [review, version]);
  const isMobile = useIsMobile();

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (accountId) qs.set('accountId', String(accountId));
    if (categoryId) qs.set('categoryId', String(categoryId));
    if (month) qs.set('month', month);
    api.get<Txn[]>(`/transactions?${qs}`).then(setTxns).catch((e) => toast(e.message, 'error'));
    api.get<Scheduled[]>('/scheduled').then(setScheduled).catch(() => {});
  }, [accountId, categoryId, month, toast]);

  useEffect(() => {
    load();
  }, [load, version]);

  useEffect(() => {
    setSelected(new Set());
    setEditing(null);
    setLimit(PAGE);
  }, [accountId, categoryId, month]);

  const accountsById = useMemo(() => new Map(data.accounts.map((a) => [a.id, a])), [data.accounts]);

  /** On-budget spending with no category yet: it can't be approved until it has one. */
  const needsCategory = useCallback(
    (t: Txn) => {
      const acct = accountsById.get(t.accountId);
      const other = t.transferAccountId ? accountsById.get(t.transferAccountId) : null;
      if (!acct?.onBudget || t.isSplit || t.categoryId !== null || (other && other.onBudget)) return false;
      return !(t.payeeName === 'Starting Balance' && (acct.type === 'credit_card' || acct.type === 'line_of_credit'));
    },
    [accountsById],
  );

  const needsReview = useCallback(
    (t: Txn) => {
      if (!t.approved) return true;
      return needsCategory(t);
    },
    [needsCategory],
  );

  const filtered = useMemo(() => {
    if (!txns) return [];
    const q = query.trim().toLowerCase();
    return txns.filter((t) => {
      if (reviewOnly && !needsReview(t)) return false;
      if (!q) return true;
      return [t.payeeName, t.memo, t.categoryName, t.transferAccountName, t.importedPayee, t.accountName, (Math.abs(t.amount) / 100).toFixed(2)]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q));
    });
  }, [txns, query, reviewOnly, needsReview]);

  // Approving is only offered once a transaction has a category (or doesn't need one).
  const unapproved = (txns ?? []).filter((t) => !t.approved && !needsCategory(t));
  const upcoming = scheduled.filter((s) => !accountId || s.accountId === accountId || s.transferAccountId === accountId);
  const categoryName = categoryId ? data.categories.find((c) => c.id === categoryId)?.name : null;

  const title = account
    ? account.name
    : categoryName
      ? `${categoryName}${month ? ` · ${fmtMonth(month)}` : ''}`
      : reviewOnly
        ? 'Review'
        : 'All Accounts';

  const visibleAccounts = data.accounts.filter((a) => !a.closed);
  const cleared = account ? account.clearedBalance : visibleAccounts.reduce((s, a) => s + a.clearedBalance, 0);
  const uncleared = account ? account.unclearedBalance : visibleAccounts.reduce((s, a) => s + a.unclearedBalance, 0);

  const bulk = (action: string, extra: Record<string, unknown> = {}) =>
    run(() => api.post('/transactions/bulk', { ids: [...selected], action, ...extra })).then(() => setSelected(new Set()));

  /** Categorizes from a list (also approves), or with null takes the category off. Shows what it did, with a way back. */
  const categorize = async (t: Txn, categoryId: number | null) => {
    setPickFor(null);
    const r = await run(() => api.post<Categorized>(`/transactions/${t.id}/categorize`, { categoryId }));
    if (!r) return;
    // Approving a transaction that already had this category doesn't move the balance: show where it stands instead.
    const line = (c: NonNullable<Categorized['to']>) =>
      c.before === c.after ? `Approved · ${c.name}: ${money(c.after)}` : `${c.name}: ${money(c.before)} → ${money(c.after)}`;
    const lines = [r.to && categoryId !== null ? null : r.to, r.from].filter(Boolean).map((c) => line(c!));
    // Red when the category it went into is now overspent.
    toast(categoryId === null ? 'Sent back to review' : r.to ? line(r.to) : 'Categorized', categoryId !== null && r.to && r.to.after < 0 ? 'error' : 'success', {
      lines: lines.length ? lines : undefined,
      duration: 2000,
      action: { label: 'Undo', onClick: () => run(() => api.post(`/transactions/${t.id}/undo-categorize`, { undo: r.undo }), 'Put back') },
    });
  };

  /** Approves one transaction, showing its category's balance and a way back when it has one. */
  const approve = (t: Txn) => {
    const other = t.transferAccountId ? accountsById.get(t.transferAccountId) : null;
    if (t.categoryId !== null && !t.isSplit && accountsById.get(t.accountId)?.onBudget && !other?.onBudget) return categorize(t, t.categoryId);
    return run(() => api.post('/transactions/bulk', { ids: [t.id], action: 'approve' }), 'Approved');
  };

  const toggleCleared = (t: Txn) => {
    if (t.cleared === 'reconciled') return toast('Reconciled transactions are locked. Edit the transaction to change it.', 'info');
    run(() => api.post('/transactions/bulk', { ids: [t.id], action: t.cleared === 'cleared' ? 'unclear' : 'clear' }));
  };

  const importNow = async () => {
    if (!account) return;
    setImporting(true);
    const r = await run(() => api.post<{ imported: number; matched: number; warnings?: string[] }>(`/accounts/${account.id}/import`));
    setImporting(false);
    if (r) {
      toast(
        r.imported + r.matched === 0 ? 'No new transactions' : `Imported ${r.imported} new, matched ${r.matched} existing transaction(s)`,
        'success',
      );
      if (r.warnings?.length) toast(r.warnings.join('; '), 'error');
    }
  };

  const shown = filtered.slice(0, limit);
  const allSelected = shown.length > 0 && shown.every((t) => selected.has(t.id));
  const showAccountCol = !accountId;

  if (legacyReviewLink && !accountId) return <Navigate to="/review" replace />;

  return (
    <div className="page account-page">
      <header className="acct-header">
        <div className="acct-title">
          <h1>{title}</h1>
          {account && (
            <div className="acct-sub">
              {account.linked ? (
                <span className={`link-status ${account.connectionStatus === 'ok' ? 'ok' : 'bad'}`}>
                  ● Linked{account.institution ? ` to ${account.institution}` : ''} · checked {timeAgo(account.lastCheckedAt)} · last new
                  transactions {timeAgo(account.lastImportAt)}
                  {account.connectionStatus !== 'ok' && account.connectionError && <> — {account.connectionError} (<Link to="/settings">fix</Link>)</>}
                </span>
              ) : (
                <span className="muted">Unlinked</span>
              )}
              {account.closed && <span className="tag">Closed</span>}
              {!account.onBudget && <span className="tag">Tracking</span>}
            </div>
          )}
          {(categoryId || (reviewOnly && !account)) && (
            <div className="acct-sub">
              <Link to="/accounts">Show all transactions</Link>
            </div>
          )}
        </div>
        {!categoryId && !reviewOnly && (
          <div className="balances">
            <div>
              <span className={cleared < 0 ? 'neg' : ''}>{money(cleared)}</span>
              <small>Cleared Balance</small>
            </div>
            <span className="op">+</span>
            <div>
              <span className={uncleared < 0 ? 'neg' : ''}>{money(uncleared)}</span>
              <small>Uncleared Balance</small>
            </div>
            <span className="op">=</span>
            <div>
              <span className={cleared + uncleared < 0 ? 'neg' : ''}>{money(cleared + uncleared)}</span>
              <small>Working Balance</small>
            </div>
            {account?.linked && account.bankBalance !== null && (
              <div className="bank-bal" title="Balance reported by your bank at the last import">
                <span>{money(account.bankBalance)}</span>
                <small>Bank Balance</small>
              </div>
            )}
          </div>
        )}
      </header>

      {data.unmappedConnections > 0 && (
        <div className="callout callout-warn">
          You linked a bank but haven't chosen which accounts to import. <Link to="/settings">Choose accounts in Settings</Link>
        </div>
      )}

      <div className="toolbar">
        <button className="btn btn-small btn-primary" onClick={() => setEditing('new')} disabled={!visibleAccounts.length}>+ Add Transaction</button>
        {account?.linked && (
          <button className="btn btn-small" onClick={importNow} disabled={importing}>{importing ? 'Importing…' : '⟳ Import'}</button>
        )}
        {account && !account.linked && (
          <button className="btn btn-small" onClick={() => setModal('link')}>Link Account</button>
        )}
        {account && <button className="btn btn-small" onClick={() => setModal('file')}>File Import</button>}
        {account && <button className="btn btn-small" onClick={() => setModal('reconcile')}>Reconcile</button>}
        {account && <button className="btn btn-small btn-ghost" onClick={() => setModal('settings')} aria-label="Account settings">⚙ Edit Account</button>}
        <span className="spacer" />
        {!reviewOnly && totalToReview > 0 && (
          <Link className="chip" to="/review" title="Everything to review, from all your accounts">
            {totalToReview} to review
          </Link>
        )}
        {unapproved.length > 0 && (
          <>
            <button className="btn btn-small btn-success" onClick={() => run(() => api.post('/transactions/bulk', { ids: unapproved.map((t) => t.id), action: 'approve' }), 'Approved')}>
              Approve all
            </button>
          </>
        )}
        <input className="search" placeholder="Search transactions" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search" />
      </div>

      {!isMobile && selected.size > 0 && (
        <div className="bulk-bar">
          <b>{selected.size} selected</b>
          <button className="btn btn-small" onClick={() => bulk('approve')}>Approve</button>
          <button className="btn btn-small" onClick={() => bulk('clear')}>Mark cleared</button>
          <button className="btn btn-small" onClick={() => bulk('unclear')}>Mark uncleared</button>
          <span className="bulk-cat">
            <CategorySelect value={bulkCat} onChange={setBulkCat} noneLabel="Categorize as…" />
            <button className="btn btn-small" disabled={!bulkCat} onClick={() => bulk('categorize', { categoryId: bulkCat })}>Apply</button>
          </span>
          <button className="btn btn-small" onClick={() => bulk('categorize', { categoryId: null })} title="Take the category off, sending these back to the review list">
            Uncategorize
          </button>
          <button className="btn btn-small btn-danger-ghost" onClick={() => setModal('delete')}>Delete</button>
          <button className="btn btn-small btn-ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      {isMobile ? (
        <div className="m-list">
          {!categoryId && !reviewOnly &&
            upcoming.map((s) => (
              <div key={'s' + s.id} className="m-card scheduled">
                <div className="m-card-main">
                  <span className="m-payee">↻ {s.transferAccountName ? `Transfer : ${s.transferAccountName}` : s.payeeName}</span>
                  <span className={`m-amount ${s.amount < 0 ? '' : 'pos'}`}>{money(s.amount)}</span>
                </div>
                <div className="m-card-sub">
                  <span>
                    {fmtDate(s.nextDate)} · {FREQUENCY_LABELS[s.frequency as Frequency]}
                  </span>
                  <span>
                    <button className="linklike" onClick={() => run(() => api.post(`/scheduled/${s.id}/enter-now`), 'Entered')}>Enter now</button>
                    <button className="linklike" onClick={() => run(() => api.post(`/scheduled/${s.id}/skip`), 'Skipped')}>Skip</button>
                  </span>
                </div>
              </div>
            ))}
          {txns === null && <div className="spinner" />}
          {txns !== null && filtered.length === 0 && (
            <div className="empty">
              <p>{txns.length === 0 ? 'No transactions yet.' : 'No transactions match.'}</p>
              {txns.length === 0 && account && !account.linked && (
                <button className="btn" onClick={() => setModal('link')}>Link this account to your bank</button>
              )}
            </div>
          )}
          {shown.map((t) => (
            <MobileTxnCard
              key={t.id}
              t={t}
              showAccount={showAccountCol}
              accounts={data.accounts}
              onEdit={() => setEditing(t.id)}
              onPickCategory={() => setPickFor(t)}
              balance={t.categoryId !== null ? catBalances.get(t.categoryId) : undefined}
              onApprove={() => approve(t)}
              onSeparate={() => run(() => api.post('/transactions/bulk', { ids: [t.id], action: 'separate-transfer' }), 'Separated into two transactions')}
              onToggleCleared={() => toggleCleared(t)}
            />
          ))}
          {filtered.length > limit && (
            <button className="btn btn-block" onClick={() => setLimit((l) => l + PAGE)}>Show more ({filtered.length - limit} older)</button>
          )}
          {editing !== null && (
            <Sheet title={editing === 'new' ? 'New transaction' : 'Edit transaction'} onClose={() => setEditing(null)}>
              <TxnEditor
                txn={editing === 'new' ? null : txns?.find((t) => t.id === editing) ?? null}
                accountId={editing === 'new' ? accountId : txns?.find((t) => t.id === editing)?.accountId ?? accountId}
                showAccount={editing === 'new' ? !accountId : showAccountCol}
                onDone={() => setEditing(null)}
              />
            </Sheet>
          )}
        </div>
      ) : (
      <div className="register">
        <div className={`reg-row reg-head ${showAccountCol ? 'with-acct' : ''}`}>
          <span>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(shown.map((t) => t.id)))}
              aria-label="Select all"
            />
          </span>
          <span />
          {showAccountCol && <span>ACCOUNT</span>}
          <span>DATE</span>
          <span>PAYEE</span>
          <span>CATEGORY</span>
          <span>MEMO</span>
          <span className="num">OUTFLOW</span>
          <span className="num">INFLOW</span>
          <span className="center">C</span>
        </div>

        {editing === 'new' && (
          <TxnEditor txn={null} accountId={accountId} showAccount={showAccountCol} onDone={() => setEditing(null)} />
        )}

        {!categoryId && !reviewOnly &&
          upcoming.map((s) => (
            <div key={'s' + s.id} className={`reg-row scheduled ${showAccountCol ? 'with-acct' : ''}`}>
              <span />
              <span title={`Repeats: ${FREQUENCY_LABELS[s.frequency as Frequency]}`}>↻</span>
              {showAccountCol && <span className="ellipsis">{s.accountName}</span>}
              <span>{fmtDate(s.nextDate)}</span>
              <span className="ellipsis">{s.transferAccountName ? `Transfer : ${s.transferAccountName}` : s.payeeName}</span>
              <span className="ellipsis muted">{s.categoryName ?? ''}</span>
              <span className="ellipsis muted">
                {FREQUENCY_LABELS[s.frequency as Frequency]}
                <button className="linklike" onClick={() => run(() => api.post(`/scheduled/${s.id}/enter-now`), 'Entered')}>Enter now</button>
                <button className="linklike" onClick={() => run(() => api.post(`/scheduled/${s.id}/skip`), 'Skipped')}>Skip</button>
              </span>
              <span className="num">{s.amount < 0 ? money(-s.amount) : ''}</span>
              <span className="num">{s.amount > 0 ? money(s.amount) : ''}</span>
              <span />
            </div>
          ))}

        {txns === null && <div className="spinner" />}
        {txns !== null && filtered.length === 0 && editing !== 'new' && (
          <div className="empty">
            {txns.length === 0 ? (
              <>
                <p>No transactions yet.</p>
                {account && !account.linked && (
                  <p>
                    <button className="linklike" onClick={() => setModal('link')}>Link this account to your bank</button> for automatic import, or{' '}
                    <button className="linklike" onClick={() => setModal('file')}>import a file</button>.
                  </p>
                )}
              </>
            ) : (
              <p>No transactions match.</p>
            )}
          </div>
        )}

        {shown.map((t) =>
          editing === t.id ? (
            <TxnEditor key={t.id} txn={t} accountId={t.accountId} showAccount={showAccountCol} onDone={() => setEditing(null)} />
          ) : (
            <TxnRow
              key={t.id}
              t={t}
              showAccount={showAccountCol}
              selected={selected.has(t.id)}
              onSelect={() =>
                setSelected((s) => {
                  const n = new Set(s);
                  if (n.has(t.id)) n.delete(t.id);
                  else n.add(t.id);
                  return n;
                })
              }
              onEdit={() => setEditing(t.id)}
              onPickCategory={() => setPickFor(t)}
              quickCategory={reviewOnly}
              balance={t.categoryId !== null ? catBalances.get(t.categoryId) : undefined}
              onToggleCleared={() => toggleCleared(t)}
              onApprove={() => approve(t)}
              onUnmatch={() => run(() => api.post('/transactions/bulk', { ids: [t.id], action: 'reject-match' }), 'Unmatched')}
              onSeparate={() => run(() => api.post('/transactions/bulk', { ids: [t.id], action: 'separate-transfer' }), 'Separated into two transactions')}
            />
          ),
        )}
        {filtered.length > limit && (
          <div className="empty">
            <button className="btn btn-small" onClick={() => setLimit((l) => l + PAGE)}>Show more ({filtered.length - limit} older)</button>
          </div>
        )}
      </div>
      )}

      {pickFor && (
        <CategoryPicker
          value={pickFor.categoryId}
          title={`${pickFor.payeeName ?? 'Transaction'} · ${money(pickFor.amount)}`}
          onClose={() => setPickFor(null)}
          onSelect={(id) => categorize(pickFor, id)}
          onClear={() => categorize(pickFor, null)}
        />
      )}
      {modal === 'reconcile' && account && <ReconcileModal account={account} onClose={() => setModal(null)} />}
      {modal === 'file' && account && <FileImportModal account={account} onClose={() => setModal(null)} />}
      {modal === 'settings' && account && <AccountSettingsModal account={account} onClose={() => setModal(null)} onLink={() => setModal('link')} />}
      {modal === 'link' && account && <ConnectBankModal presetAccountId={account.id} onClose={() => setModal(null)} />}
      {modal === 'delete' && (
        <Confirm
          title={`Delete ${selected.size} transaction(s)?`}
          message="Transfers are deleted from both accounts. This can't be undone."
          danger
          confirmLabel="Delete"
          onConfirm={() => bulk('delete')}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

function TxnRow({
  t,
  showAccount,
  selected,
  onSelect,
  onEdit,
  onToggleCleared,
  onApprove,
  onUnmatch,
  onSeparate,
  onPickCategory,
  quickCategory,
  balance,
}: {
  t: Txn;
  showAccount: boolean;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onToggleCleared: () => void;
  onApprove: () => void;
  onUnmatch: () => void;
  onSeparate: () => void;
  onPickCategory: () => void;
  /** In the review list, clicking the category picks one right there (and approves). */
  quickCategory: boolean;
  /** The category's current balance (review list only). */
  balance?: number;
}) {
  const { data } = useApp();
  const info = categoryInfo(t, data.accounts);
  const category: React.ReactNode = info.needs ? <span className="needs-cat">Needs a category</span> : info.muted ? <span className="muted">{info.text}</span> : info.text;

  return (
    <>
      <div
        className={`reg-row ${showAccount ? 'with-acct' : ''} ${selected ? 'selected' : ''} ${!t.approved ? 'unapproved' : ''} ${t.amazon?.items.length ? 'has-amazon' : ''}`}
        onDoubleClick={onEdit}
      >
        <span onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={selected} onChange={onSelect} aria-label="Select transaction" />
        </span>
        <span>{t.flag && <span className={`flag flag-${t.flag}`} title={`${t.flag} flag`} />}</span>
        {showAccount && <span className="ellipsis">{t.accountName}</span>}
        <span onClick={onEdit}>{fmtDate(t.date)}</span>
        <span className="ellipsis" onClick={onEdit} title={t.importedPayee ? `Bank description: ${t.importedPayee}` : undefined}>
          {t.transferAccountName ? `Transfer : ${t.transferAccountName}` : t.payeeName ?? <span className="muted">—</span>}
        </span>
        <span
          className={`ellipsis ${info.canPick && (quickCategory || info.needs) ? 'pickable' : ''}`}
          onClick={info.canPick && (quickCategory || info.needs) ? onPickCategory : onEdit}
          title={info.canPick && (quickCategory || info.needs) ? 'Choose a category' : undefined}
        >
          {category}
          {balance !== undefined && <BalancePill balance={balance} />}
        </span>
        <span className="ellipsis muted" onClick={onEdit}>
          {displayMemo(t)}
          {!t.approved && (
            <span className="approve-inline" onClick={(e) => e.stopPropagation()}>
              {t.matched && <span className="tag tag-match" title={`Matched with imported "${t.importedPayee}"`}>Matched</span>}
              {t.autoTransfer && t.transferAccountId ? (
                <span className="tag tag-match" title={`Bank description: ${t.importedPayee ?? ''}`}>Transfer found</span>
              ) : (
                !t.matched && t.importId && <span className="tag">Imported</span>
              )}
              {!info.needs && <button className="btn btn-tiny btn-success" onClick={onApprove}>Approve</button>}
              {t.matched && <button className="btn btn-tiny btn-ghost" onClick={onUnmatch}>Unmatch</button>}
              {t.autoTransfer && t.transferAccountId && <button className="btn btn-tiny btn-ghost" onClick={onSeparate}>Not a transfer</button>}
            </span>
          )}
        </span>
        <span className="num" onClick={onEdit}>{t.amount < 0 ? money(-t.amount) : ''}</span>
        <span className="num" onClick={onEdit}>{t.amount > 0 ? money(t.amount) : ''}</span>
        <span className="center">
          <button
            className={`cleared-btn ${t.cleared}`}
            onClick={onToggleCleared}
            title={t.cleared === 'reconciled' ? 'Reconciled' : t.cleared === 'cleared' ? 'Cleared' : 'Uncleared'}
            aria-label={`Cleared status: ${t.cleared}`}
          >
            {t.cleared === 'reconciled' ? '🔒' : 'C'}
          </button>
        </span>
      </div>
      {t.amazon && t.amazon.items.length > 0 && (
        <div className={`reg-amazon ${!t.approved ? 'unapproved' : ''}`} onClick={onEdit}>
          <AmazonItems t={t} />
        </div>
      )}
      {t.isSplit &&
        t.subtransactions.map((s, i) => (
          <div key={i} className={`reg-row sub ${showAccount ? 'with-acct' : ''}`} onClick={onEdit}>
            <span />
            <span />
            {showAccount && <span />}
            <span />
            <span className="muted">↳</span>
            <span className="ellipsis">{s.categoryName ?? <span className="needs-cat">Needs a category</span>}</span>
            <span className="ellipsis muted">{s.memo}</span>
            <span className="num">{s.amount < 0 ? money(-s.amount) : ''}</span>
            <span className="num">{s.amount > 0 ? money(s.amount) : ''}</span>
            <span />
          </div>
        ))}
    </>
  );
}

/** A category's current balance, shown beside its name in the review list. */
function BalancePill({ balance }: { balance: number }) {
  return (
    <span className={`pill cat-balance ${balance < 0 ? 'pill-neg' : balance > 0 ? 'pill-pos' : 'pill-zero'}`} title="This category's balance now">
      {money(balance)}
    </span>
  );
}

/** How a transaction's category column should read, and whether it still needs one. */
function categoryInfo(t: Txn, accounts: Account[]): { text: string; muted?: boolean; needs?: boolean; canPick?: boolean } {
  const acct = accounts.find((a) => a.id === t.accountId);
  const other = t.transferAccountId ? accounts.find((a) => a.id === t.transferAccountId) : null;
  if (t.isSplit) return { text: `Split (${t.subtransactions.length})`, muted: true };
  if (t.categoryName) return { text: t.categoryName, canPick: !t.transferAccountId || !other?.onBudget };
  if (t.counterpartCategoryName) return { text: t.counterpartCategoryName };
  if (other && acct?.onBudget && other.onBudget) return { text: 'Transfer', muted: true };
  if (!acct?.onBudget) return { text: '—', muted: true };
  if (t.payeeName === 'Starting Balance') return { text: 'Starting balance', muted: true };
  return { text: 'Needs a category', needs: true, canPick: true };
}

function MobileTxnCard({
  t,
  showAccount,
  accounts,
  onEdit,
  onPickCategory,
  balance,
  onApprove,
  onSeparate,
  onToggleCleared,
}: {
  t: Txn;
  showAccount: boolean;
  accounts: Account[];
  onEdit: () => void;
  onPickCategory: () => void;
  balance?: number;
  onApprove: () => void;
  onSeparate: () => void;
  onToggleCleared: () => void;
}) {
  const info = categoryInfo(t, accounts);
  return (
    <div className={`m-card ${!t.approved ? 'unapproved' : ''}`} onClick={onEdit} role="button" tabIndex={0}>
      <div className="m-card-main">
        <span className="m-payee">
          {t.flag && <span className={`flag flag-${t.flag}`} />} {t.transferAccountName ? `Transfer : ${t.transferAccountName}` : t.payeeName ?? '—'}
        </span>
        <span className={`m-amount ${t.amount > 0 ? 'pos' : ''}`}>{money(t.amount)}</span>
      </div>
      <div className="m-card-sub">
        <span className="ellipsis">
          {info.canPick ? (
            <button
              className={info.needs ? 'needs-cat' : 'm-cat'}
              onClick={(e) => {
                e.stopPropagation();
                onPickCategory();
              }}
            >
              {info.text} ▾
              {balance !== undefined && <BalancePill balance={balance} />}
            </button>
          ) : (
            <span className={info.muted ? 'muted' : ''}>{info.text}</span>
          )}
        </span>
        <span className="m-meta">
          {showAccount && <>{t.accountName} · </>}
          {fmtDate(t.date)}
          <button
            className={`cleared-btn ${t.cleared}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCleared();
            }}
            aria-label={`Cleared status: ${t.cleared}`}
          >
            {t.cleared === 'reconciled' ? '🔒' : 'C'}
          </button>
        </span>
      </div>
      <AmazonItems t={t} className="m-memo" />
      {displayMemo(t) && <div className="m-memo">{displayMemo(t)}</div>}
      {!t.approved && (
        <div className="m-approve" onClick={(e) => e.stopPropagation()}>
          <span className="small muted">
            {t.autoTransfer && t.transferAccountId ? 'Transfer between your accounts' : t.matched ? 'Matched with bank import' : 'Imported'} —{' '}
            {info.needs ? 'choose a category to approve' : 'review and approve'}
          </span>
          {t.autoTransfer && t.transferAccountId && <button className="btn btn-small btn-ghost" onClick={onSeparate}>Not a transfer</button>}
          {info.needs ? (
            <button className="btn btn-small" onClick={onPickCategory}>Choose category</button>
          ) : (
            <button className="btn btn-small btn-success" onClick={onApprove}>Approve</button>
          )}
        </div>
      )}
    </div>
  );
}
