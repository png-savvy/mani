import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useApp } from '../store';
import { fmtDateTime, fmtMonth, money } from '../format';
import { Modal, MoneyField } from './ui';
import type { BudgetMonth, PlanPreview } from '../types';
import { currentMonth } from '../../../shared/util';

interface Plan {
  income: number;
  amounts: Record<number, number>;
  /** Percent-of-income entries, in hundredths of a percent (1000 = 10%). */
  percents: Record<number, number>;
  total: number;
}

/** Cents for a percentage of income; must match the server's rounding. */
const percentOf = (income: number, bp: number) => Math.round((income * bp) / 10000);
const fmtPercent = (bp: number) => String(Number((bp / 100).toFixed(2)));

/** Text box for a percentage (0–100, up to 2 decimals). Commits on blur/Enter, like MoneyField. */
function PercentField({ value, onCommit, ariaLabel }: { value: number; onCommit: (bp: number) => void; ariaLabel: string }) {
  const [text, setText] = useState(fmtPercent(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(fmtPercent(value));
  }, [value, focused]);
  const commit = () => {
    const raw = text.replace(/[%\s]/g, '');
    const n = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      setText(fmtPercent(value));
      return;
    }
    const bp = Math.round(n * 100);
    if (bp !== value) onCommit(bp);
    setText(fmtPercent(bp));
  };
  return (
    <span className="percent-field">
      <input
        className="money-input"
        value={text}
        inputMode="decimal"
        aria-label={ariaLabel}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
        onChange={(e) => setText(e.target.value)}
      />
      <span className="percent-sign">%</span>
    </span>
  );
}

/** Edit the monthly income and the fixed amount each category gets every month. */
export default function PlanPage() {
  const { data, run, toast, version } = useApp();
  const [saved, setSaved] = useState<Plan | null>(null);
  const [income, setIncome] = useState(0);
  const [amounts, setAmounts] = useState<Record<number, number>>({});
  const [percents, setPercents] = useState<Record<number, number>>({});
  const [status, setStatus] = useState<BudgetMonth['plan'] | null>(null);
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);
  const month = currentMonth();
  // Latest values, so Save always sends what's on screen even if a field commits on the same tap.
  const latest = useRef({ income, amounts, percents });
  latest.current = { income, amounts, percents };

  useEffect(() => {
    api
      .get<Plan>('/plan')
      .then((p) => {
        setSaved(p);
        setIncome(p.income);
        setAmounts(p.amounts);
        setPercents(p.percents);
      })
      .catch((e) => toast(e.message, 'error'));
  }, [toast]);

  useEffect(() => {
    api
      .get<BudgetMonth>(`/budget/${month}`)
      .then((v) => setStatus(v.plan))
      .catch(() => setStatus(null));
  }, [month, version]);

  const groups = useMemo(
    () =>
      data.groups
        .filter((g) => g.system !== 'internal' && !g.hidden && (data.settings.showCcPayments || g.system !== 'credit_card_payments'))
        .map((g) => ({ ...g, categories: data.categories.filter((c) => c.groupId === g.id && !c.hidden && c.kind !== 'income') }))
        .filter((g) => g.categories.length > 0),
    [data.groups, data.categories, data.settings.showCcPayments],
  );
  const visibleIds = useMemo(() => new Set(groups.flatMap((g) => g.categories.map((c) => c.id))), [groups]);

  if (!saved) return <div className="page"><div className="spinner" /></div>;

  const isPct = (id: number) => percents[id] !== undefined;
  const amt = (id: number) => (isPct(id) ? percentOf(income, percents[id]) : (amounts[id] ?? 0));
  const total = [...visibleIds].reduce((s, id) => s + amt(id), 0);
  const left = income - total;
  const over = left < 0;
  const dirty =
    income !== saved.income ||
    [...visibleIds].some((id) => isPct(id) !== (saved.percents[id] !== undefined) || (isPct(id) ? percents[id] !== saved.percents[id] : (amounts[id] ?? 0) !== (saved.amounts[id] ?? 0)));

  /** Switch a category between a dollar amount and a percentage, keeping roughly the same money. */
  const setMode = (id: number, pct: boolean) => {
    if (pct === isPct(id)) return;
    if (pct) {
      const a = amounts[id] ?? 0;
      setPercents((p) => ({ ...p, [id]: income > 0 ? Math.min(10000, Math.round((a / income) * 10000)) : 0 }));
      setAmounts(({ [id]: _drop, ...rest }) => rest);
    } else {
      setAmounts((a) => ({ ...a, [id]: percentOf(income, percents[id]) }));
      setPercents(({ [id]: _drop, ...rest }) => rest);
    }
  };

  const save = async () => {
    const { income: inc, amounts: am, percents: pc } = latest.current;
    const ids = [...visibleIds];
    const body = {
      income: inc,
      amounts: Object.fromEntries(ids.filter((id) => pc[id] === undefined).map((id) => [id, am[id] ?? 0])),
      percents: Object.fromEntries(ids.filter((id) => pc[id] !== undefined).map((id) => [id, pc[id]])),
    };
    setSaving(true);
    const r = await run(() => api.put<Plan>('/plan', body), 'Monthly plan saved');
    setSaving(false);
    if (r) {
      setSaved(r);
      setIncome(r.income);
      setAmounts(r.amounts);
      setPercents(r.percents);
    }
  };

  const copyAssigned = async () => {
    try {
      const v = await api.get<BudgetMonth>(`/budget/${month}`);
      const next: Record<number, number> = {};
      // Percentage categories (like tithe) keep their percentage.
      for (const c of v.groups.flatMap((g) => g.categories))
        if (visibleIds.has(c.id) && c.assigned > 0 && percents[c.id] === undefined) next[c.id] = c.assigned;
      setAmounts(next);
      toast(`Filled in from ${fmtMonth(month)}'s assigned amounts. Check them, then Save.`, 'info');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  return (
    <div className="page plan-page">
      <header className="page-head">
        <h1>Monthly Plan</h1>
        <Link to="/budget" className="btn btn-small btn-ghost">← Budget</Link>
      </header>

      <p className="muted plan-intro">
        Set how much each category gets every month. At the start of each month, the Budget page shows a button that assigns all of it in one
        click. Your plan can add up to your monthly income, which you enter below. Ready to Assign isn't used.
      </p>

      {status && status.total > 0 && (
        <div className="callout plan-status">
          {status.appliedAt ? (
            <>
              Assigned for {fmtMonth(month)} on {fmtDateTime(status.appliedAt)}.{' '}
              <button className="linklike" onClick={() => setApplying(true)} disabled={dirty}>Assign again</button>
              {dirty && <span className="muted"> (save your changes first)</span>}
            </>
          ) : (
            <>
              Not assigned yet for {fmtMonth(month)}.{' '}
              <button className="linklike" onClick={() => setApplying(true)} disabled={dirty}>Assign now</button>
              {dirty && <span className="muted"> (save your changes first)</span>}
            </>
          )}
        </div>
      )}

      <section className="card plan-income">
        <span className="plan-income-label">Monthly income</span>
        <MoneyField value={income} onCommit={setIncome} allowNegative={false} ariaLabel="Monthly income" className="plan-income-input" />
        <span className="muted small">The most your plan can add up to each month.</span>
      </section>

      <section className="card plan-list">
        <div className="card-head">
          <h2>Amount per category</h2>
          <button className="btn btn-small btn-ghost" onClick={copyAssigned}>Copy this month's assigned amounts</button>
        </div>
        {groups.map((g) => {
          const gt = g.categories.reduce((s, c) => s + amt(c.id), 0);
          return (
            <div key={g.id} className="plan-group">
              <div className="plan-row plan-group-row">
                <span>{g.name}</span>
                <span className="num">{money(gt)}</span>
              </div>
              {g.categories.map((c) => (
                <div key={c.id} className="plan-row">
                  <span className="plan-cat">
                    {c.name}
                    {isPct(c.id) && <span className="muted small plan-pct-amt">= {money(amt(c.id))} of income</span>}
                  </span>
                  <span className="plan-mode" role="group" aria-label={`How ${c.name} is planned`}>
                    <button className={!isPct(c.id) ? 'active' : ''} aria-pressed={!isPct(c.id)} onClick={() => setMode(c.id, false)}>$</button>
                    <button className={isPct(c.id) ? 'active' : ''} aria-pressed={isPct(c.id)} onClick={() => setMode(c.id, true)}>%</button>
                  </span>
                  {isPct(c.id) ? (
                    <PercentField value={percents[c.id]} ariaLabel={`Percent of income for ${c.name}`} onCommit={(v) => setPercents((p) => ({ ...p, [c.id]: v }))} />
                  ) : (
                    <MoneyField
                      value={amounts[c.id] ?? 0}
                      allowNegative={false}
                      ariaLabel={`Monthly plan for ${c.name}`}
                      onCommit={(v) => setAmounts((a) => ({ ...a, [c.id]: v }))}
                    />
                  )}
                </div>
              ))}
            </div>
          );
        })}
        <p className="muted small">Hidden categories aren't in the plan.</p>
      </section>

      <div className={`plan-footer ${over ? 'is-over' : ''}`}>
        <div className="plan-totals">
          <span>
            Planned <b>{money(total)}</b> of <b>{money(income)}</b>
          </span>
          <span className={over ? 'plan-over' : 'plan-left'}>
            {over ? `${money(-left)} over your income` : `${money(left)} left to plan`}
          </span>
        </div>
        <button className="btn btn-primary" disabled={!dirty || over || saving} onClick={save}>
          {saving ? 'Saving…' : dirty ? 'Save plan' : 'Saved'}
        </button>
      </div>

      {applying && <ApplyPlanModal month={month} again={!!status?.appliedAt} onClose={() => setApplying(false)} />}
    </div>
  );
}

/** Shows exactly what will change, then assigns the plan for `month`. */
export function ApplyPlanModal({ month, again, onClose }: { month: string; again: boolean; onClose: () => void }) {
  const { run, toast } = useApp();
  const [preview, setPreview] = useState<PlanPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    api
      .get<PlanPreview>(`/plan/preview/${month}`)
      .then(setPreview)
      .catch((e) => {
        toast(e.message, 'error');
        closeRef.current();
      });
  }, [month, toast]);

  const apply = async () => {
    setBusy(true);
    const r = await run(() => api.post<{ changed: number; added: number }>(`/plan/apply/${month}`, { again }));
    setBusy(false);
    if (r) {
      toast(`Assigned ${money(r.added)} to ${r.changed} categor${r.changed === 1 ? 'y' : 'ies'}`, 'success');
      onClose();
    }
  };

  const unchanged = preview ? preview.rows.filter((r) => r.next === r.current).length : 0;

  return (
    <Modal
      title={`Assign monthly plan · ${fmtMonth(month)}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!preview || busy} onClick={apply}>
            {busy ? 'Assigning…' : preview && preview.addedTotal > 0 ? `Assign ${money(preview.addedTotal)}` : 'Mark as done'}
          </button>
        </>
      }
    >
      {!preview ? (
        <div className="spinner" />
      ) : (
        <>
          <p className="small">
            Each category's Assigned for {fmtMonth(month)} goes up to its plan amount. Anything you've already assigned is kept, and nothing is
            lowered.
          </p>
          <table className="simple-table plan-preview">
            <thead>
              <tr>
                <th>Category</th>
                <th className="num">Assigned now</th>
                <th className="num">After</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((r) => (
                <tr key={r.categoryId} className={r.next === r.current ? 'muted' : ''}>
                  <td>
                    {r.name}
                    {r.percent !== null && <span className="muted"> ({fmtPercent(r.percent)}% of income)</span>}
                  </td>
                  <td className="num">{money(r.current)}</td>
                  <td className="num">{r.next === r.current ? 'no change' : <b>{money(r.next)}</b>}</td>
                </tr>
              ))}
              <tr className="total">
                <td>Total added</td>
                <td />
                <td className="num"><b>{money(preview.addedTotal)}</b></td>
              </tr>
            </tbody>
          </table>
          {unchanged > 0 && (
            <p className="muted small">
              {unchanged} categor{unchanged === 1 ? 'y is' : 'ies are'} already at or above the plan amount, so {unchanged === 1 ? 'it stays' : 'they stay'} as
              {unchanged === 1 ? ' it is' : ' they are'}.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
