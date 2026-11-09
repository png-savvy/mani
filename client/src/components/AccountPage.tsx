import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { fmtDate, fmtMonth, money, timeAgo } from '../format';
import { CategorySelect, Confirm, Sheet } from './ui';
import CategoryPicker from './CategoryPicker';
import { useIsMobile } from '../hooks';
import TxnEditor from './TxnEditor';
import ReconcileModal from './ReconcileModal';
import FileImportModal from './FileImportModal';
import AccountSettingsModal from './AccountSettingsModal';
import { ConnectBankModal } from './ConnectBank';
import type { Account, Scheduled, Txn } from '../types';
import { FREQUENCY_LABELS, type Frequency } from '../../../shared/util';

const PAGE = 300;

export default function AccountPage() {
  const params = useParams();
  const [search] = useSearchParams();
  const accountId = params.accountId ? Number(params.accountId) : null;
  const categoryId = search.get('categoryId') ? Number(search.get('categoryId')) : null;
  const month = search.get('month');
  const uncategorizedOnly = search.get('uncategorized') === '1';
  const { data, version, run, toast } = useApp();
  const account = data.accounts.find((a) => a.id === accountId) ?? null;

  const [txns, setTxns] = useState<Txn[] | null>(null);
  const [scheduled, setScheduled] = useState<Scheduled[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<number | 'new' | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [modal, setModal] = useState<'reconcile' | 'file' | 'settings' | 'link' | 'delete' | null>(null);
  const [bulkCat, setBulkCat] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [showUnapprovedOnly, setShowUnapprovedOnly] = useState(search.get('unapproved') === '1');
  const [pickFor, setPickFor] = useState<Txn | null>(null);
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

  const filtered = useMemo(() => {
    if (!txns) return [];
    const q = query.trim().toLowerCase();
    return txns.filter((t) => {
      if (showUnapprovedOnly && t.approved) return false;
      if (uncategorizedOnly) {
        const acct = accountsById.get(t.accountId);
        const other = t.transferAccountId ? accountsById.get(t.transferAccountId) : null;
        if (!acct?.onBudget || t.isSplit || t.categoryId !== null || (other && other.onBudget)) return false;
        if (t.payeeName === 'Starting Balance' && (acct.type === 'credit_card' || acct.type === 'line_of_credit')) return false;
      }
      if (!q) return true;
      return [t.payeeName, t.memo, t.categoryName, t.transferAccountName, t.importedPayee, t.accountName, (Math.abs(t.amount) / 100).toFixed(2)]
        .filter(Boolean)
        .some((s) => String(s).toLowerCase().includes(q));
    });
  }, [txns, query, showUnapprovedOnly, uncategorizedOnly, accountsById]);

  const unapproved = (txns ?? []).filter((t) => !t.approved);
  const upcoming = scheduled.filter((s) => !accountId || s.accountId === accountId || s.transferAccountId === accountId);
  const categoryName = categoryId ? data.categories.find((c) => c.id === categoryId)?.name : null;

  const title = account
    ? account.name
    : categoryName
      ? `${categoryName}${month ? ` · ${fmtMonth(month)}` : ''}`
      : uncategorizedOnly
        ? 'Uncategorized transactions'
        : 'All Accounts';

  const visibleAccounts = data.accounts.filter((a) => !a.closed);
  const cleared = account ? account.clearedBalance : visibleAccounts.reduce((s, a) => s + a.clearedBalance, 0);
  const uncleared = account ? account.unclearedBalance : visibleAccounts.reduce((s, a) => s + a.unclearedBalance, 0);

  const bulk = (action: string, extra: Record<string, unknown> = {}) =>
    run(() => api.post('/transactions/bulk', { ids: [...selected], action, ...extra })).then(() => setSelected(new Set()));

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

  return (
    <div className="page account-page">
      <header className="acct-header">
        <div className="acct-title">
          <h1>{title}</h1>
          {account && (
            <div className="acct-sub">
              {account.linked ? (
                <span className={`link-status ${account.connectionStatus === 'ok' ? 'ok' : 'bad'}`}>
                  ● Linked{account.institution ? ` to ${account.institution}` : ''} · last import {timeAgo(account.lastImportAt)}
                  {account.connectionStatus !== 'ok' && account.connectionError && <> — {account.connectionError} (<Link to="/settings">fix</Link>)</>}
                </span>
              ) : (
                <span className="muted">Unlinked</span>
              )}
              {account.closed && <span className="tag">Closed</span>}
              {!account.onBudget && <span className="tag">Tracking</span>}
            </div>
          )}
          {(categoryId || uncategorizedOnly) && (
            <div className="acct-sub">
              <Link to="/accounts">Show all transactions</Link>
            </div>
          )}
        </div>
        {!categoryId && !uncategorizedOnly && (
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
        {unapproved.length > 0 && (
          <>
            <button className={`chip ${showUnapprovedOnly ? 'active' : ''}`} onClick={() => setShowUnapprovedOnly((v) => !v)}>
              {unapproved.length} to approve
            </button>
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
          <button className="btn btn-small btn-danger-ghost" onClick={() => setModal('delete')}>Delete</button>
          <button className="btn btn-small btn-ghost" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      {isMobile ? (
        <div className="m-list">
          {!categoryId && !uncategorizedOnly &&
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
              onApprove={() => run(() => api.post('/transactions/bulk', { ids: [t.id], action: 'approve' }))}
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
          {pickFor && (
            <CategoryPicker
              value={pickFor.categoryId}
              title={`${pickFor.payeeName ?? 'Transaction'} · ${money(pickFor.amount)}`}
              onClose={() => setPickFor(null)}
              onSelect={async (id) => {
                const t = pickFor;
                setPickFor(null);
                // Categorizing from the list also approves it.
                await run(async () => {
                  await api.post('/transactions/bulk', { ids: [t.id], action: 'categorize', categoryId: id });
                  await api.post('/transactions/bulk', { ids: [t.id], action: 'approve' });
                });
              }}
            />
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

        {!categoryId && !uncategorizedOnly &&
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
              onToggleCleared={() => toggleCleared(t)}
              onApprove={() => run(() => api.post('/transactions/bulk', { ids: [t.id], action: 'approve' }))}
              onUnmatch={() => run(() => api.post('/transactions/bulk', { ids: [t.id], action: 'reject-match' }), 'Unmatched')}
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
}: {
  t: Txn;
  showAccount: boolean;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onToggleCleared: () => void;
  onApprove: () => void;
  onUnmatch: () => void;
}) {
  const { data } = useApp();
  const info = categoryInfo(t, data.accounts);
  const category: React.ReactNode = info.needs ? <span className="needs-cat">Needs a category</span> : info.muted ? <span className="muted">{info.text}</span> : info.text;

  return (
    <>
      <div
        className={`reg-row ${showAccount ? 'with-acct' : ''} ${selected ? 'selected' : ''} ${!t.approved ? 'unapproved' : ''}`}
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
        <span className="ellipsis" onClick={onEdit}>{category}</span>
        <span className="ellipsis muted" onClick={onEdit}>
          {t.memo}
          {!t.approved && (
            <span className="approve-inline" onClick={(e) => e.stopPropagation()}>
              {t.matched && <span className="tag tag-match" title={`Matched with imported "${t.importedPayee}"`}>Matched</span>}
              {!t.matched && t.importId && <span className="tag">Imported</span>}
              <button className="btn btn-tiny btn-success" onClick={onApprove}>Approve</button>
              {t.matched && <button className="btn btn-tiny btn-ghost" onClick={onUnmatch}>Unmatch</button>}
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
  onApprove,
  onToggleCleared,
}: {
  t: Txn;
  showAccount: boolean;
  accounts: Account[];
  onEdit: () => void;
  onPickCategory: () => void;
  onApprove: () => void;
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
      {t.memo && <div className="m-memo">{t.memo}</div>}
      {!t.approved && (
        <div className="m-approve" onClick={(e) => e.stopPropagation()}>
          <span className="small muted">{t.matched ? 'Matched with bank import' : 'Imported'} — review and approve</span>
          <button className="btn btn-small btn-success" onClick={onApprove}>Approve</button>
        </div>
      )}
    </div>
  );
}
