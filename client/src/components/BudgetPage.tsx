import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { fmtMonth, money } from '../format';
import { CategorySelect, Confirm, Modal, MoneyField, Sheet, useClickOutside } from './ui';
import { useIsMobile, useMediaQuery } from '../hooks';
import CategoryTransactions from './CategoryTransactions';
import type { BudgetCategory, BudgetGroup, BudgetMonth } from '../types';
import { TARGET_LABELS, TARGET_TYPES, addMonths, currentMonth, isValidMonth, todayISO } from '../../../shared/util';

type Filter = 'all' | 'underfunded' | 'overspent' | 'available';

type Drag = { type: 'cat'; id: number; groupId: number; kind: string } | { type: 'group'; id: number };
type DropTarget = { type: 'cat' | 'group'; id: number; pos: 'before' | 'after' | 'into' };

/** Where a dragged item may land: normal categories go in regular groups, card payment categories stay in their group. */
function canDrop(drag: Drag, target: DropTarget, groups: BudgetGroup[]): boolean {
  const targetGroup =
    target.type === 'group' ? groups.find((g) => g.id === target.id) : groups.find((g) => g.categories.some((c) => c.id === target.id));
  if (!targetGroup) return false;
  if (drag.type === 'group') return target.type === 'group' && target.pos !== 'into' && !targetGroup.system && target.id !== drag.id;
  if (target.type === 'cat' && target.id === drag.id) return false;
  if (drag.kind === 'cc_payment') return targetGroup.id === drag.groupId;
  return !targetGroup.system;
}

/** Returns a copy of the groups with the dragged item moved to the drop position. */
function applyMove(groups: BudgetGroup[], drag: Drag, target: DropTarget): BudgetGroup[] {
  const next = groups.map((g) => ({ ...g, categories: [...g.categories] }));
  if (drag.type === 'group') {
    const from = next.findIndex((g) => g.id === drag.id);
    const [moved] = next.splice(from, 1);
    let to = next.findIndex((g) => g.id === target.id);
    if (target.pos === 'after') to++;
    next.splice(to, 0, moved);
    return next;
  }
  const src = next.find((g) => g.categories.some((c) => c.id === drag.id))!;
  const [moved] = src.categories.splice(
    src.categories.findIndex((c) => c.id === drag.id),
    1,
  );
  if (target.type === 'group') {
    const dest = next.find((g) => g.id === target.id)!;
    dest.categories.unshift({ ...moved, groupId: dest.id });
  } else {
    const dest = next.find((g) => g.categories.some((c) => c.id === target.id))!;
    let to = dest.categories.findIndex((c) => c.id === target.id);
    if (target.pos === 'after') to++;
    dest.categories.splice(to, 0, { ...moved, groupId: dest.id });
  }
  return next;
}

function dropPos(e: React.DragEvent, allowInto: boolean): DropTarget['pos'] {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (allowInto && y > 0.33 && y < 0.67) return 'into';
  return y < 0.5 ? 'before' : 'after';
}

/** Balance colors: gold = money available, grey = target not yet met, orange = card overspending, red = cash overspending. */
function pillClass(c: BudgetCategory): string {
  if (c.available < 0) return c.creditOverspent > 0 && c.cashOverspent === 0 ? 'pill pill-credit' : 'pill pill-neg';
  if (c.targetStatus && c.targetStatus.underfunded > 0) return 'pill pill-under';
  if (c.available > 0) return 'pill pill-pos';
  return 'pill pill-zero';
}

const AUTO_MODES: [string, string][] = [
  ['underfunded', 'Underfunded'],
  ['assigned_last_month', 'Assigned Last Month'],
  ['spent_last_month', 'Spent Last Month'],
  ['average_assigned', 'Average Assigned'],
  ['average_spent', 'Average Spent'],
  ['reset_available', 'Reset Available Amounts'],
  ['reset_assigned', 'Reset Assigned Amounts'],
];

export default function BudgetPage() {
  const params = useParams();
  const navigate = useNavigate();
  const { data, version, run, toast } = useApp();
  const month = isValidMonth(params.month) ? params.month : currentMonth();
  const [view, setView] = useState<BudgetMonth | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [showHidden, setShowHidden] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});
  const [moveFor, setMoveFor] = useState<number | 'rta' | null>(null);
  const [rtaOpen, setRtaOpen] = useState(false);
  const [newGroup, setNewGroup] = useState<string | null>(null);
  const [newCatFor, setNewCatFor] = useState<{ groupId: number; name: string } | null>(null);
  const [editGroup, setEditGroup] = useState<BudgetGroup | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const isMobile = useIsMobile();
  // Below this width the side panel is hidden, so category details open as a sheet instead.
  const narrow = useMediaQuery('(max-width: 1100px)');

  const load = useCallback(() => {
    api
      .get<BudgetMonth>(`/budget/${month}`)
      .then(setView)
      .catch((e) => toast(e.message, 'error'));
  }, [month, toast]);

  useEffect(() => {
    load();
  }, [load, version]);

  const allCats = useMemo(() => view?.groups.flatMap((g) => g.categories) ?? [], [view]);
  const sel = allCats.find((c) => c.id === selected) ?? null;

  if (!view) return <div className="page"><div className="spinner" /></div>;

  const rta = view.readyToAssign;
  const go = (m: string) => navigate(`/budget/${m}`);
  const canPrev = month > view.firstMonth;
  const rolling = view.mode === 'rolling';
  // The month the server actually used (rolling mode always uses the current month).
  const bm = view.month;

  const setAssigned = (c: BudgetCategory, cents: number) => run(() => api.put(`/budget/${bm}/categories/${c.id}`, { assigned: cents }));

  // ---- drag and drop reordering (only in the unfiltered view, so every position is visible) ----
  const dragEnabled = filter === 'all';
  const startDrag = (e: React.DragEvent, d: Drag) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(d.id));
    const row = (e.currentTarget as HTMLElement).closest('.bt-row, .bt-group-row');
    if (row) e.dataTransfer.setDragImage(row, 24, 18);
    setDrag(d);
  };
  const endDrag = () => {
    setDrag(null);
    setDrop(null);
  };
  const overTarget = (e: React.DragEvent, target: DropTarget) => {
    if (!drag || !canDrop(drag, target, view.groups)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!drop || drop.type !== target.type || drop.id !== target.id || drop.pos !== target.pos) setDrop(target);
  };
  const dropHere = (e: React.DragEvent) => {
    e.preventDefault();
    if (drag && drop && canDrop(drag, drop, view.groups)) {
      const next = applyMove(view.groups, drag, drop);
      setView({ ...view, groups: next });
      run(() => api.post('/categories/reorder', { groups: next.map((g) => ({ id: g.id, categoryIds: g.categories.map((c) => c.id) })) }));
    }
    endDrag();
  };
  const dropClass = (type: DropTarget['type'], id: number) =>
    drop && drop.type === type && drop.id === id ? `drop-${drop.pos}` : '';

  const visible = (c: BudgetCategory) => {
    if (c.hidden && !showHidden) return false;
    switch (filter) {
      case 'underfunded':
        return !!c.targetStatus && c.targetStatus.underfunded > 0;
      case 'overspent':
        return c.available < 0;
      case 'available':
        return c.available > 0;
      default:
        return true;
    }
  };

  const groups = view.groups.filter((g) => {
    if (g.system === 'credit_card_payments' && g.categories.length === 0) return false;
    if (g.hidden && !showHidden) return false;
    return filter === 'all' || g.categories.some(visible);
  });

  const totals = allCats.reduce(
    (t, c) => ({
      assigned: t.assigned + c.assigned,
      activity: t.activity + c.activity,
      available: t.available + c.available,
      underfunded: t.underfunded + (c.targetStatus?.underfunded ?? 0),
    }),
    { assigned: 0, activity: 0, available: 0, underfunded: 0 },
  );
  const overspentCount = allCats.filter((c) => c.available < 0).length;
  const unapprovedCount = data.accounts.reduce((s, a) => s + a.unapprovedCount, 0);

  return (
    <div className="budget-page">
      <div className="budget-main">
        <header className="budget-header">
          {rolling ? (
            <div className="month-nav">
              <h1>Budget</h1>
            </div>
          ) : (
          <div className="month-nav">
            <button className="icon-btn" disabled={!canPrev} onClick={() => go(addMonths(month, -1))} aria-label="Previous month">‹</button>
            <h1>{fmtMonth(month)}</h1>
            <button className="icon-btn" onClick={() => go(addMonths(month, 1))} aria-label="Next month">›</button>
            {month !== currentMonth() && (
              <button className="btn btn-small btn-ghost" onClick={() => go(currentMonth())}>Today</button>
            )}
          </div>
          )}

          <div className="rta-wrap">
            <button
              className={`rta ${rta.total > 0 ? 'rta-pos' : rta.total < 0 ? 'rta-neg' : 'rta-zero'}`}
              onClick={() => setRtaOpen((o) => !o)}
            >
              <span className="rta-amount">{money(rta.total)}</span>
              <span className="rta-label">
                {rta.total > 0 ? 'Ready to Assign' : rta.total < 0 ? 'You assigned more than you have' : 'All Money Assigned'}
              </span>
              {rolling && rta.rolling && rta.rolling.cashOverspent > 0 && (
                <span className="rta-sub">Truly free after overspending: {money(rta.rolling.trulyFree)}</span>
              )}
            </button>
            {rta.total > 0 && (
              <button className="btn btn-small rta-assign" onClick={() => setMoveFor('rta')}>Assign ▾</button>
            )}
            {rtaOpen && <RtaBreakdown month={bm} rolling={rolling} rta={rta} onClose={() => setRtaOpen(false)} />}
          </div>

          <div className="aom" title="Age of Money: how many days old the money you spend is, on average (last 10 outflows).">
            <span className="aom-label">Age of Money</span>
            <span className="aom-value">{view.ageOfMoney === null ? '—' : `${view.ageOfMoney} days`}</span>
          </div>
        </header>

        {data.unmappedConnections > 0 && (
          <div className="callout callout-warn">
            You linked a bank but haven't chosen which accounts to import. <Link to="/settings">Choose accounts in Settings</Link>
          </div>
        )}
        {view.uncategorizedCount > 0 && (
          <div className="callout callout-warn">
            {view.uncategorizedCount} transaction{view.uncategorizedCount === 1 ? ' needs' : 's need'} a category.{' '}
            <Link to="/accounts?uncategorized=1">Review them</Link>
          </div>
        )}
        {unapprovedCount > 0 && (
          <div className="callout callout-warn">
            {unapprovedCount} imported transaction{unapprovedCount === 1 ? ' needs' : 's need'} review.{' '}
            <Link to="/accounts?unapproved=1">Review them</Link>
          </div>
        )}
        {overspentCount > 0 && filter !== 'overspent' && (
          <div className="callout callout-neg">
            {overspentCount} categor{overspentCount === 1 ? 'y is' : 'ies are'} overspent.{' '}
            <button className="linklike" onClick={() => setFilter('overspent')}>Show</button>
          </div>
        )}

        <div className="budget-toolbar">
          {newGroup === null ? (
            <button className="btn btn-small btn-ghost" onClick={() => setNewGroup('')}>+ Category Group</button>
          ) : (
            <form
              className="inline-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (!newGroup.trim()) return;
                await run(() => api.post('/category-groups', { name: newGroup }));
                setNewGroup(null);
              }}
            >
              <input autoFocus value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group name" />
              <button className="btn btn-small btn-primary">Add</button>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setNewGroup(null)}>Cancel</button>
            </form>
          )}
          <div className="chips" role="group" aria-label="Filter categories">
            {(
              [
                ['all', 'All'],
                ['underfunded', 'Underfunded'],
                ['overspent', 'Overspent'],
                ['available', 'Money Available'],
              ] as [Filter, string][]
            ).map(([f, label]) => (
              <button key={f} className={`chip ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{label}</button>
            ))}
          </div>
          <label className="check-inline">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden
          </label>
          {narrow && (
            <button className="btn btn-small btn-ghost" onClick={() => setSummaryOpen(true)}>Summary & Auto-Assign</button>
          )}
        </div>

        <div className="budget-table" role="table">
          <div className="bt-head" role="row">
            <span role="columnheader">CATEGORY</span>
            <span role="columnheader" className="num">{rolling && !isMobile ? 'ASSIGNED THIS MONTH' : 'ASSIGNED'}</span>
            <span role="columnheader" className="num col-activity">{rolling ? 'SPENT THIS MONTH' : 'ACTIVITY'}</span>
            <span role="columnheader" className="num">{rolling ? 'BALANCE' : 'AVAILABLE'}</span>
          </div>
          {groups.map((g) => {
            const cats = g.categories.filter(visible);
            const gt = g.categories.reduce(
              (t, c) => ({ assigned: t.assigned + c.assigned, activity: t.activity + c.activity, available: t.available + c.available }),
              { assigned: 0, activity: 0, available: 0 },
            );
            return (
              <div key={g.id} className={`bt-group ${g.hidden ? 'is-hidden' : ''}`}>
                <div
                  className={`bt-group-row ${dropClass('group', g.id)} ${drag?.type === 'group' && drag.id === g.id ? 'dragging' : ''}`}
                  role="row"
                  onDragOver={(e) => overTarget(e, { type: 'group', id: g.id, pos: drag?.type === 'cat' ? 'into' : dropPos(e, false) })}
                  onDragLeave={() => drop?.type === 'group' && drop.id === g.id && setDrop(null)}
                  onDrop={dropHere}
                >
                  <span className="bt-group-name">
                    {dragEnabled && !g.system && (
                      <span
                        className="drag-handle"
                        draggable
                        title="Drag to reorder"
                        aria-label={`Reorder group ${g.name}`}
                        onDragStart={(e) => startDrag(e, { type: 'group', id: g.id })}
                        onDragEnd={endDrag}
                      >
                        ⠿
                      </span>
                    )}
                    <button className="caret" onClick={() => setCollapsed((c) => ({ ...c, [g.id]: !c[g.id] }))} aria-label="Toggle group">
                      {collapsed[g.id] ? '▸' : '▾'}
                    </button>
                    {g.name}
                    {!g.system && (
                      <>
                        <button className="mini-btn" title="Add category" onClick={() => setNewCatFor({ groupId: g.id, name: '' })}>＋</button>
                        <button className="mini-btn" title="Edit group" onClick={() => setEditGroup(g)}>✎</button>
                      </>
                    )}
                  </span>
                  <span className="num">{money(gt.assigned)}</span>
                  <span className="num col-activity">{money(gt.activity)}</span>
                  <span className="num">{money(gt.available)}</span>
                </div>
                {newCatFor?.groupId === g.id && (
                  <form
                    className="bt-row inline-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (!newCatFor.name.trim()) return;
                      await run(() => api.post('/categories', { groupId: g.id, name: newCatFor.name }));
                      setNewCatFor(null);
                    }}
                  >
                    <input autoFocus value={newCatFor.name} onChange={(e) => setNewCatFor({ groupId: g.id, name: e.target.value })} placeholder="New category name" />
                    <button className="btn btn-small btn-primary">Add</button>
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => setNewCatFor(null)}>Cancel</button>
                  </form>
                )}
                {!collapsed[g.id] &&
                  cats.map((c) => (
                    <div
                      key={c.id}
                      role="row"
                      className={`bt-row ${selected === c.id ? 'selected' : ''} ${c.hidden ? 'is-hidden' : ''} ${dropClass('cat', c.id)} ${drag?.type === 'cat' && drag.id === c.id ? 'dragging' : ''}`}
                      onClick={() => setSelected(c.id === selected ? null : c.id)}
                      onDragOver={(e) => overTarget(e, { type: 'cat', id: c.id, pos: dropPos(e, false) })}
                      onDragLeave={() => drop?.type === 'cat' && drop.id === c.id && setDrop(null)}
                      onDrop={dropHere}
                    >
                      {dragEnabled && (
                        <span
                          className="drag-handle cat-handle"
                          draggable
                          title="Drag to reorder"
                          aria-label={`Reorder ${c.name}`}
                          onClick={(e) => e.stopPropagation()}
                          onDragStart={(e) => startDrag(e, { type: 'cat', id: c.id, groupId: g.id, kind: c.kind })}
                          onDragEnd={endDrag}
                        >
                          ⠿
                        </span>
                      )}
                      <span className="bt-name">
                        <span className="cat-name">{c.name}</span>
                        {c.targetStatus && (
                          <span className="target-bar" title={`${c.targetStatus.description}: ${money(c.targetStatus.needed)}`}>
                            <span
                              className={`target-fill ${c.targetStatus.complete ? 'done' : ''}`}
                              style={{ width: `${c.targetStatus.needed ? Math.min(100, (c.targetStatus.funded / c.targetStatus.needed) * 100) : 100}%` }}
                            />
                          </span>
                        )}
                        {c.targetStatus && c.targetStatus.underfunded > 0 && (
                          <span className="target-note">{money(c.targetStatus.underfunded)} more needed this month</span>
                        )}
                      </span>
                      <span className="num" onClick={(e) => e.stopPropagation()}>
                        <MoneyField value={c.assigned} relative onCommit={(v) => setAssigned(c, v)} ariaLabel={`Assigned to ${c.name}`} />
                      </span>
                      <span className="num col-activity">
                        <Link
                          className="activity-link"
                          to={c.kind === 'cc_payment' && c.linkedAccountId ? `/accounts/${c.linkedAccountId}` : `/accounts?categoryId=${c.id}&month=${bm}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {money(c.activity)}
                        </Link>
                      </span>
                      <span className="num avail-cell" onClick={(e) => e.stopPropagation()}>
                        <button className={pillClass(c)} onClick={() => setMoveFor(moveFor === c.id ? null : c.id)}>
                          {money(c.available)}
                        </button>
                        {moveFor === c.id && <MoveMoney month={bm} cat={c} onClose={() => setMoveFor(null)} />}
                      </span>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
        {moveFor === 'rta' && <MoveMoney month={bm} cat={null} rta={rta.total} onClose={() => setMoveFor(null)} />}
      </div>

      <aside className="inspector">
        {sel ? (
          <CategoryInspector key={sel.id} month={bm} rolling={rolling} cat={sel} onClose={() => setSelected(null)} />
        ) : (
          <MonthSummary month={bm} rolling={rolling} totals={totals} rta={rta.total} />
        )}
      </aside>

      {narrow && sel && (
        <Sheet title="Category" onClose={() => setSelected(null)}>
          <CategoryInspector key={sel.id} month={bm} rolling={rolling} cat={sel} onClose={() => setSelected(null)} />
        </Sheet>
      )}
      {narrow && summaryOpen && (
        <Sheet title="Summary" onClose={() => setSummaryOpen(false)}>
          <MonthSummary month={bm} rolling={rolling} totals={totals} rta={rta.total} />
        </Sheet>
      )}

      {editGroup && <GroupEditor group={editGroup} onClose={() => setEditGroup(null)} />}
    </div>
  );
}

function RtaBreakdown({ month, rolling, rta, onClose }: { month: string; rolling: boolean; rta: BudgetMonth['readyToAssign']; onClose: () => void }) {
  const ref = useClickOutside<HTMLDivElement>(onClose);
  if (rolling && rta.rolling) {
    const r = rta.rolling;
    return (
      <div className="popover rta-pop" ref={ref}>
        <table className="kv">
          <tbody>
            <tr><td>All income (Inflow: Ready to Assign)</td><td className="num">{money(r.income)}</td></tr>
            <tr><td>Everything assigned to categories</td><td className="num">−{money(r.assignedAll)}</td></tr>
            <tr className="kv-total"><td>Ready to Assign</td><td className="num">{money(r.total)}</td></tr>
            <tr><td>Categories overspent with cash/debit</td><td className="num">−{money(r.cashOverspent)}</td></tr>
            <tr className="kv-total"><td>Truly free</td><td className="num">{money(r.trulyFree)}</td></tr>
          </tbody>
        </table>
        <p className="muted small">
          Overspent categories stay negative until you cover them. Cash overspending is money that already left your bank, so it isn't really free.
          {r.creditOverspent > 0 && <> Card purchases not yet covered: {money(r.creditOverspent)} (owed on your cards).</>}
        </p>
      </div>
    );
  }
  return (
    <div className="popover rta-pop" ref={ref}>
      <table className="kv">
        <tbody>
          <tr><td>Left over from last month</td><td className="num">{money(rta.leftOver)}</td></tr>
          <tr><td>Inflow: Ready to Assign in {fmtMonth(month, 'short')}</td><td className="num">+{money(rta.incomeThisMonth)}</td></tr>
          <tr><td>Cash overspending in {fmtMonth(addMonths(month, -1), 'short')}</td><td className="num">−{money(rta.overspentPrev)}</td></tr>
          <tr><td>Assigned in {fmtMonth(month, 'short')}</td><td className="num">−{money(rta.assignedThisMonth)}</td></tr>
          <tr><td>Assigned in future months</td><td className="num">−{money(rta.assignedFuture)}</td></tr>
          <tr className="kv-total"><td>Ready to Assign</td><td className="num">{money(rta.total)}</td></tr>
        </tbody>
      </table>
    </div>
  );
}

/** "Move money" popover: from a category (or Ready to Assign) to another, or cover overspending. */
function MoveMoney({ month, cat, rta, onClose }: { month: string; cat: BudgetCategory | null; rta?: number; onClose: () => void }) {
  const { run } = useApp();
  const ref = useClickOutside<HTMLDivElement>(onClose);
  const overspent = cat && cat.available < 0;
  const [amount, setAmount] = useState(cat ? Math.abs(cat.available) : Math.max(0, rta ?? 0));
  const [other, setOther] = useState<number | null>(null);
  const RTA = -1;

  const submit = async () => {
    if (amount <= 0) return;
    const otherId = other === RTA ? null : other;
    if (other === null) return;
    const body = !cat
      ? { fromId: null, toId: otherId, amount }
      : overspent
        ? { fromId: otherId, toId: cat.id, amount }
        : { fromId: cat.id, toId: otherId, amount };
    const r = await run(() => api.post(`/budget/${month}/move`, body));
    if (r !== undefined) onClose();
  };

  return (
    <div className={`popover move-pop ${cat ? '' : 'move-pop-rta'}`} ref={ref} onClick={(e) => e.stopPropagation()}>
      <div className="pop-title">{!cat ? 'Assign from Ready to Assign' : overspent ? 'Cover overspending' : 'Move money'}</div>
      <label>
        Amount
        <MoneyField value={amount} onCommit={setAmount} autoFocus allowNegative={false} ariaLabel="Amount to move" />
      </label>
      <label>
        {!cat ? 'To' : overspent ? 'Take from' : 'To'}
        <MoveTarget value={other} onChange={setOther} excludeId={cat?.id} includeRta={!!cat} />
      </label>
      {overspent && cat!.creditOverspent > 0 && (
        <p className="muted small">
          {money(cat!.creditOverspent)} of this was spent on a credit card. Covering it moves that money to the card's payment category.
        </p>
      )}
      <div className="pop-actions">
        <button className="btn btn-small btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-small btn-primary" disabled={other === null || amount <= 0} onClick={submit}>OK</button>
      </div>
    </div>
  );
}

function MoveTarget({ value, onChange, excludeId, includeRta }: { value: number | null; onChange: (v: number | null) => void; excludeId?: number; includeRta: boolean }) {
  const { data } = useApp();
  const groups = data.groups.filter((g) => g.system !== 'internal');
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} aria-label="Category">
      <option value="">Choose…</option>
      {includeRta && <option value={-1}>Ready to Assign</option>}
      {groups.map((g) => (
        <optgroup key={g.id} label={g.name}>
          {data.categories
            .filter((c) => c.groupId === g.id && c.id !== excludeId && c.kind !== 'income')
            .map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

function MonthSummary({ month, rolling, totals, rta }: { month: string; rolling: boolean; totals: { assigned: number; activity: number; available: number; underfunded: number }; rta: number }) {
  const { run } = useApp();
  return (
    <div className="insp">
      <h2>{rolling ? 'Summary' : `${fmtMonth(month)} Summary`}</h2>
      <table className="kv">
        <tbody>
          <tr><td>Ready to Assign</td><td className="num">{money(rta)}</td></tr>
          <tr><td>Assigned this month</td><td className="num">{money(totals.assigned)}</td></tr>
          <tr><td>Activity</td><td className="num">{money(totals.activity)}</td></tr>
          <tr><td>{rolling ? 'Total in categories' : 'Available'}</td><td className="num">{money(totals.available)}</td></tr>
          <tr><td>Still needed for targets</td><td className="num">{money(totals.underfunded)}</td></tr>
        </tbody>
      </table>
      <h3>Auto-Assign</h3>
      <p className="muted small">Applies to every visible category this month.</p>
      <div className="auto-list">
        {AUTO_MODES.map(([mode, label]) => (
          <button key={mode} className="auto-btn" onClick={() => run(() => api.post(`/budget/${month}/auto-assign`, { mode }), `${label}: done`)}>
            {label}
          </button>
        ))}
      </div>
      <p className="muted small tip">
        Tip: click a category to see details, set a target, or move money. Drag the ⠿ handle to reorder categories and groups. In the Assigned column you can type math like <code>+25</code> or <code>40*3</code>.
      </p>
    </div>
  );
}

function CategoryInspector({ month, rolling, cat, onClose }: { month: string; rolling: boolean; cat: BudgetCategory; onClose: () => void }) {
  const { run, data } = useApp();
  const [name, setName] = useState(cat.name);
  const [note, setNote] = useState(cat.note);
  const [editingTarget, setEditingTarget] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isNormal = cat.kind === 'normal';

  return (
    <div className="insp">
      <div className="insp-head">
        {isNormal ? (
          <input
            className="insp-title"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== cat.name && run(() => api.put(`/categories/${cat.id}`, { name }))}
            aria-label="Category name"
          />
        ) : (
          <h2>{cat.name}</h2>
        )}
        <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
      </div>

      <div className={`insp-avail ${cat.available < 0 ? 'neg' : cat.available > 0 ? 'pos' : ''}`}>
        <span>{rolling ? 'Balance' : 'Available Balance'}</span>
        <b>{money(cat.available)}</b>
      </div>
      <table className="kv">
        <tbody>
          <tr><td>{rolling ? 'Balance before this month' : 'Cash left over from last month'}</td><td className="num">{money(cat.carry)}</td></tr>
          <tr><td>Assigned this month</td><td className="num">{money(cat.assigned)}</td></tr>
          <tr><td>{cat.kind === 'cc_payment' ? 'Spending & payments' : 'Cash & credit spending'}</td><td className="num">{money(cat.activity)}</td></tr>
        </tbody>
      </table>
      {cat.available < 0 && (
        <div className={`callout ${cat.cashOverspent > 0 ? 'callout-neg' : 'callout-warn'}`}>
          {rolling ? (
            <>
              <p>This category is {money(-cat.available)} short. It stays that way until you cover it — assign money or move money here whenever you like.</p>
              {cat.creditOverspent > 0 && (
                <p>{money(cat.creditOverspent)} of it was bought on a credit card. When you cover it, that money is set aside for your card bill automatically.</p>
              )}
            </>
          ) : (
            <>
              {cat.cashOverspent > 0 && <p>Cash overspending of {money(cat.cashOverspent)} will be taken from next month's Ready to Assign if not covered.</p>}
              {cat.creditOverspent > 0 && <p>Credit overspending of {money(cat.creditOverspent)} becomes credit card debt not covered by your payment category.</p>}
            </>
          )}
        </div>
      )}
      {cat.kind === 'cc_payment' && (
        <p className="muted small">
          Money moves here automatically when you spend on this card from a funded category. Pay the card by recording a transfer from a cash account
          to the card.
        </p>
      )}

      {cat.kind === 'normal' && <CategoryTransactions categoryId={cat.id} month={month} />}

      <h3>Target</h3>
      {cat.target && !editingTarget ? (
        <div className="target-box">
          <div>
            <b>{TARGET_LABELS[cat.target.type as keyof typeof TARGET_LABELS]}</b> {money(cat.target.amount)}
            {cat.target.date && <> by {cat.target.date}</>}
          </div>
          {cat.targetStatus && (
            <div className="muted small">
              {cat.targetStatus.complete ? 'Funded this month ✓' : `${money(cat.targetStatus.underfunded)} more needed this month`}
            </div>
          )}
          <div className="row-gap">
            <button className="btn btn-small" onClick={() => setEditingTarget(true)}>Edit</button>
            <button className="btn btn-small btn-ghost" onClick={() => run(() => api.put(`/categories/${cat.id}`, { target: null }))}>Remove</button>
            {cat.targetStatus && cat.targetStatus.underfunded > 0 && (
              <button
                className="btn btn-small btn-primary"
                onClick={() => run(() => api.post(`/budget/${month}/auto-assign`, { mode: 'underfunded', categoryIds: [cat.id] }))}
              >
                Assign {money(cat.targetStatus.underfunded)}
              </button>
            )}
          </div>
        </div>
      ) : editingTarget || !cat.target ? (
        <TargetEditor cat={cat} onDone={() => setEditingTarget(false)} startOpen={editingTarget} />
      ) : null}

      <h3>Auto-Assign</h3>
      <div className="auto-list">
        {AUTO_MODES.map(([mode, label]) => (
          <button key={mode} className="auto-btn" onClick={() => run(() => api.post(`/budget/${month}/auto-assign`, { mode, categoryIds: [cat.id] }))}>
            {label}
          </button>
        ))}
      </div>

      <h3>Notes</h3>
      <textarea
        value={note}
        rows={3}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => note !== cat.note && run(() => api.put(`/categories/${cat.id}`, { note }))}
        placeholder="Enter a note…"
      />

      <div className="insp-actions">
        <button className="btn btn-small btn-ghost" onClick={() => run(() => api.put(`/categories/${cat.id}`, { hidden: !cat.hidden }))}>
          {cat.hidden ? 'Unhide' : 'Hide'}
        </button>
        {isNormal && (
          <>
            <select
              value={cat.groupId}
              onChange={(e) => run(() => api.put(`/categories/${cat.id}`, { groupId: Number(e.target.value) }))}
              aria-label="Move to group"
            >
              {data.groups.filter((g) => !g.system).map((g) => (
                <option key={g.id} value={g.id}>Group: {g.name}</option>
              ))}
            </select>
            <button className="btn btn-small btn-danger-ghost" onClick={() => setDeleting(true)}>Delete</button>
          </>
        )}
      </div>
      {deleting && <DeleteCategory cat={cat} onClose={() => setDeleting(false)} onDeleted={onClose} />}
    </div>
  );
}

function TargetEditor({ cat, onDone, startOpen }: { cat: BudgetCategory; onDone: () => void; startOpen: boolean }) {
  const { run } = useApp();
  const [open, setOpen] = useState(startOpen);
  const [type, setType] = useState(cat.target?.type ?? 'monthly_set_aside');
  const [amount, setAmount] = useState(cat.target?.amount ?? 0);
  const [date, setDate] = useState(cat.target?.date ?? todayISO());
  if (!open) {
    return (
      <button className="btn btn-small" onClick={() => setOpen(true)}>
        Create Target
      </button>
    );
  }
  return (
    <div className="target-box form">
      <label>
        I need
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {TARGET_TYPES.map((t) => (
            <option key={t} value={t}>{TARGET_LABELS[t]}</option>
          ))}
        </select>
      </label>
      <label>
        Amount
        <MoneyField value={amount} onCommit={setAmount} allowNegative={false} ariaLabel="Target amount" />
      </label>
      {type === 'by_date' && (
        <label>
          By
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      )}
      <div className="row-gap">
        <button
          className="btn btn-small btn-primary"
          disabled={amount <= 0}
          onClick={async () => {
            const r = await run(() => api.put(`/categories/${cat.id}`, { target: { type, amount, date: type === 'by_date' ? date : null } }));
            if (r !== undefined) {
              setOpen(false);
              onDone();
            }
          }}
        >
          Save Target
        </button>
        <button
          className="btn btn-small btn-ghost"
          onClick={() => {
            setOpen(false);
            onDone();
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function DeleteCategory({ cat, onClose, onDeleted }: { cat: BudgetCategory; onClose: () => void; onDeleted: () => void }) {
  const { run } = useApp();
  const [to, setTo] = useState<number | null>(null);
  return (
    <Modal
      title={`Delete "${cat.name}"`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-danger"
            onClick={async () => {
              const r = await run(() => api.del(`/categories/${cat.id}${to ? `?reassignTo=${to}` : ''}`), 'Category deleted');
              if (r !== undefined) {
                onClose();
                onDeleted();
              }
            }}
          >
            Delete
          </button>
        </>
      }
    >
      <p>Move this category's transactions and assigned money (in every month) to:</p>
      <CategorySelect value={to} onChange={setTo} noneLabel="Nothing — leave transactions uncategorized" />
      <p className="muted small">If you don't reassign, money assigned to this category returns to Ready to Assign.</p>
    </Modal>
  );
}

function GroupEditor({ group, onClose }: { group: BudgetGroup; onClose: () => void }) {
  const { run } = useApp();
  const [name, setName] = useState(group.name);
  const [confirm, setConfirm] = useState(false);
  const [to, setTo] = useState<number | null>(null);
  return (
    <Modal
      title="Edit Category Group"
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-danger-ghost" onClick={() => setConfirm(true)}>Delete group</button>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={() => run(() => api.put(`/category-groups/${group.id}`, { hidden: !group.hidden })).then(onClose)}>
            {group.hidden ? 'Unhide' : 'Hide'}
          </button>
          <button className="btn btn-primary" onClick={() => run(() => api.put(`/category-groups/${group.id}`, { name })).then(onClose)}>Save</button>
        </>
      }
    >
      <label className="form">
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      {confirm && (
        <Confirm
          title={`Delete "${group.name}"?`}
          danger
          confirmLabel="Delete group"
          message={
            <div className="form">
              <p>All {group.categories.length} categories in this group will be deleted. Move their transactions and assigned money to:</p>
              <CategorySelect value={to} onChange={setTo} noneLabel="Nothing — leave transactions uncategorized" />
            </div>
          }
          onConfirm={() => run(() => api.del(`/category-groups/${group.id}${to ? `?reassignTo=${to}` : ''}`)).then(onClose)}
          onClose={() => setConfirm(false)}
        />
      )}
    </Modal>
  );
}
