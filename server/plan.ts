import { db, getSetting, setSetting } from './db.ts';
import { HttpError } from './txns.ts';
import { compute, emptyState } from './budget.ts';
import { currentMonth, type Month } from '../shared/util.ts';

/**
 * Monthly plan: a fixed amount per category that you assign in one click at the start of each month.
 * The total is limited by a monthly income figure you enter yourself (not Ready to Assign).
 *
 * A category's plan is either a dollar amount or a percentage of that monthly income (e.g. 10% for tithe),
 * stored in hundredths of a percent so 12.5% is exactly 1250.
 *
 * Applying the plan to a month raises each category's Assigned to its plan amount. It never lowers
 * anything you already assigned, so applying twice (or after assigning by hand) can't double up.
 */

const MAX = 1e13;
const MAX_PERCENT = 10000; // 100.00%

interface PlanCategoryRow {
  id: number;
  plan_amount: number;
  plan_percent: number | null;
}

/**
 * Categories that can be in the plan: visible, not the income category, in a visible group, and not a
 * credit card payment category when those are hidden in Settings.
 */
function planCategories(): PlanCategoryRow[] {
  const hideCc = getSetting('show_cc_payments') === '0';
  return db
    .prepare(
      `SELECT c.id, c.plan_amount, c.plan_percent FROM categories c JOIN category_groups g ON g.id = c.group_id
       WHERE c.kind != 'income' AND c.hidden = 0 AND g.hidden = 0 ${hideCc ? `AND c.kind != 'cc_payment'` : ''}`,
    )
    .all() as PlanCategoryRow[];
}

/** Cents for a percentage (hundredths of a percent) of the income, rounded to the nearest cent. */
export function percentOf(income: number, percent: number): number {
  return Math.round((income * percent) / 10000);
}

function effective(c: { plan_amount: number; plan_percent: number | null }, income: number): number {
  return c.plan_percent !== null ? percentOf(income, c.plan_percent) : c.plan_amount;
}

export function planIncome(): number {
  const n = Number(getSetting('plan_income'));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function appliedAt(month: Month): string | null {
  const r = db.prepare(`SELECT applied_at FROM plan_applied WHERE month = ?`).get(month) as { applied_at: string } | undefined;
  return r?.applied_at ?? null;
}

/**
 * The saved plan. `amounts` holds dollar entries, `percents` holds percentage entries (hundredths of a percent),
 * and `effective` is what each category actually gets this month in cents.
 */
export function getPlan() {
  const income = planIncome();
  const amounts: Record<number, number> = {};
  const percents: Record<number, number> = {};
  const eff: Record<number, number> = {};
  let total = 0;
  for (const c of planCategories()) {
    if (c.plan_percent !== null) percents[c.id] = c.plan_percent;
    else if (c.plan_amount > 0) amounts[c.id] = c.plan_amount;
    const e = effective(c, income);
    if (e > 0) eff[c.id] = e;
    total += e;
  }
  return { income, amounts, percents, effective: eff, total };
}

/**
 * Saves the whole plan. Each category in `amounts` gets a dollar amount and each one in `percents` a percentage;
 * a category can't be in both. Categories left out of both keep what they had.
 */
export function savePlan(input: { income: unknown; amounts: unknown; percents?: unknown }) {
  const income = Number(input.income);
  if (!Number.isInteger(income) || income < 0 || income > MAX) throw new HttpError(400, 'Enter a valid monthly income');
  const isMap = (v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isMap(input.amounts) || (input.percents !== undefined && !isMap(input.percents))) throw new HttpError(400, 'Invalid plan');

  const current = new Map(planCategories().map((c) => [c.id, { plan_amount: c.plan_amount, plan_percent: c.plan_percent }]));
  const next = new Map([...current].map(([id, v]) => [id, { ...v }]));
  const seen = new Set<number>();
  const check = (key: string) => {
    const id = Number(key);
    if (!current.has(id)) throw new HttpError(400, 'One of the categories no longer exists or is hidden. Reload and try again.');
    if (seen.has(id)) throw new HttpError(400, 'A category can have a dollar amount or a percentage, not both');
    seen.add(id);
    return id;
  };
  for (const [key, raw] of Object.entries(input.amounts as Record<string, unknown>)) {
    const id = check(key);
    const amt = Number(raw);
    if (!Number.isInteger(amt) || amt < 0 || amt > MAX) throw new HttpError(400, 'Plan amounts must be zero or more');
    next.set(id, { plan_amount: amt, plan_percent: null });
  }
  for (const [key, raw] of Object.entries((input.percents ?? {}) as Record<string, unknown>)) {
    const id = check(key);
    const pct = Number(raw);
    if (!Number.isInteger(pct) || pct < 0 || pct > MAX_PERCENT) throw new HttpError(400, 'Percentages must be between 0% and 100%');
    next.set(id, { plan_amount: 0, plan_percent: pct });
  }
  const total = [...next.values()].reduce((s, v) => s + effective(v, income), 0);
  if (total > income) throw new HttpError(400, 'Your plan adds up to more than your monthly income');

  db.transaction(() => {
    setSetting('plan_income', String(income));
    const upd = db.prepare(`UPDATE categories SET plan_amount = ?, plan_percent = ? WHERE id = ?`);
    for (const [id, v] of next) {
      const was = current.get(id)!;
      if (v.plan_amount !== was.plan_amount || v.plan_percent !== was.plan_percent) upd.run(v.plan_amount, v.plan_percent, id);
    }
  })();
  return getPlan();
}

export interface PlanPreviewRow {
  categoryId: number;
  name: string;
  groupName: string;
  plan: number;
  /** Set when the plan amount is a percentage of income (hundredths of a percent). */
  percent: number | null;
  current: number;
  next: number;
}

/** What applying the plan to `month` would change. */
export function planPreview(month: Month) {
  const comp = compute(month);
  const cur = comp.state.get(month) ?? new Map();
  const names = new Map(
    (
      db
        .prepare(`SELECT c.id, c.name, g.name AS groupName FROM categories c JOIN category_groups g ON g.id = c.group_id ORDER BY g.sort, g.id, c.sort, c.id`)
        .all() as { id: number; name: string; groupName: string }[]
    ).map((r, i) => [r.id, { ...r, order: i }]),
  );
  const income = planIncome();
  const rows: (PlanPreviewRow & { order: number })[] = [];
  for (const c of planCategories()) {
    const plan = effective(c, income);
    if (plan <= 0) continue;
    const current = (cur.get(c.id) ?? emptyState()).assigned;
    const n = names.get(c.id)!;
    rows.push({ categoryId: c.id, name: n.name, groupName: n.groupName, plan, percent: c.plan_percent, current, next: Math.max(current, plan), order: n.order });
  }
  rows.sort((a, b) => a.order - b.order);
  const out: PlanPreviewRow[] = rows.map(({ order: _o, ...r }) => r);
  return {
    month,
    rows: out,
    planTotal: out.reduce((s, r) => s + r.plan, 0),
    addedTotal: out.reduce((s, r) => s + (r.next - r.current), 0),
    appliedAt: appliedAt(month),
  };
}

/** Assigns the plan for `month`. Refuses if it was already applied unless `again` is set. */
export function applyPlan(month: Month, again = false) {
  if (month < currentMonth()) throw new HttpError(400, 'The monthly plan can only be assigned to this month or a future month');
  return db.transaction(() => {
    if (appliedAt(month) && !again) throw new HttpError(409, 'The monthly plan was already assigned for this month');
    const preview = planPreview(month);
    if (preview.rows.length === 0) throw new HttpError(400, 'Your monthly plan is empty. Add amounts first.');
    const up = db.prepare(
      `INSERT INTO budget_amounts (category_id, month, assigned) VALUES (?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET assigned = excluded.assigned`,
    );
    let changed = 0;
    for (const r of preview.rows) {
      if (r.next !== r.current) {
        up.run(r.categoryId, month, r.next);
        changed++;
      }
    }
    db.prepare(
      `INSERT INTO plan_applied (month, applied_at) VALUES (?, datetime('now')) ON CONFLICT(month) DO UPDATE SET applied_at = excluded.applied_at`,
    ).run(month);
    return { changed, added: preview.addedTotal };
  })();
}

/** Marks `month` as handled without assigning anything, so the Budget page stops offering the plan. */
export function skipPlan(month: Month) {
  if (month < currentMonth()) throw new HttpError(400, 'Only this month or a future month can be skipped');
  db.prepare(`INSERT INTO plan_applied (month, applied_at) VALUES (?, datetime('now')) ON CONFLICT(month) DO NOTHING`).run(month);
}

/** Short status for the Budget page banner. */
export function planStatus(month: Month) {
  const p = getPlan();
  return {
    income: p.income,
    total: p.total,
    categories: Object.keys(p.effective).length,
    appliedAt: appliedAt(month),
    canApply: month >= currentMonth(),
  };
}
