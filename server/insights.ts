import { db } from './db.ts';
import { monthView } from './budget.ts';
import { addDays, addMonths, currentMonth, daysInMonth, todayISO, type Month } from '../shared/util.ts';

/**
 * Plain-number insights for the Reports page: how this month is going, monthly averages, plan vs actual,
 * which categories are trending up or down, and where the money goes.
 *
 * "Spending" is the activity in your regular categories (refunds lower it); transfers, card payments and
 * income don't count. "Income" is money categorized to Ready to Assign, not counting starting balances
 * or reconciliation adjustments.
 */

const LOOKBACK = 6; // full months used for averages and the monthly table

const SPENDING_SQL = `
  SELECT x.category_id AS categoryId, substr(x.date,1,7) AS month, -SUM(x.amount) AS spent
  FROM (
    SELECT account_id, date, amount, category_id FROM transactions WHERE is_split = 0 AND category_id IS NOT NULL
    UNION ALL
    SELECT t.account_id, t.date, s.amount, s.category_id FROM subtransactions s JOIN transactions t ON t.id = s.transaction_id WHERE s.category_id IS NOT NULL
  ) x
  JOIN accounts a ON a.id = x.account_id
  JOIN categories c ON c.id = x.category_id
  WHERE a.on_budget = 1 AND c.kind = 'normal' AND x.date >= ? AND x.date <= ?
  GROUP BY x.category_id, month`;

const INCOME_SQL = `
  SELECT substr(x.date,1,7) AS month, SUM(x.amount) AS income
  FROM (
    SELECT t.account_id, t.date, t.amount, t.category_id, t.payee_id FROM transactions t WHERE t.is_split = 0
    UNION ALL
    SELECT t.account_id, t.date, s.amount, s.category_id, t.payee_id FROM subtransactions s JOIN transactions t ON t.id = s.transaction_id
  ) x
  JOIN accounts a ON a.id = x.account_id
  JOIN categories c ON c.id = x.category_id
  LEFT JOIN payees p ON p.id = x.payee_id
  WHERE a.on_budget = 1 AND c.kind = 'income' AND x.date >= ? AND x.date <= ?
    AND COALESCE(p.name, '') NOT IN ('Starting Balance', 'Reconciliation Balance Adjustment')
  GROUP BY month`;

export function insights() {
  const cur: Month = currentMonth();
  const today = todayISO();
  const [y, m] = cur.split('-').map(Number);
  const day = Number(today.slice(8, 10));
  const dim = daysInMonth(y, m);

  // Only count months that have data, so a budget started recently isn't averaged against empty months.
  const first = (db.prepare(`SELECT MIN(t.date) AS d FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.on_budget = 1`).get() as { d: string | null }).d;
  const firstMonth: Month = first ? first.slice(0, 7) : cur;
  const from = `${addMonths(cur, -LOOKBACK)}-01`;
  const cats = new Map(
    (
      db
        .prepare(`SELECT c.id, c.name, g.name AS groupName FROM categories c JOIN category_groups g ON g.id = c.group_id`)
        .all() as { id: number; name: string; groupName: string }[]
    ).map((c) => [c.id, c]),
  );
  const spendRows = db.prepare(SPENDING_SQL).all(from, today) as { categoryId: number; month: string; spent: number }[];
  const incomeRows = db.prepare(INCOME_SQL).all(from, today) as { month: string; income: number }[];

  const spentBy = new Map<string, number>(); // `${month}` -> total
  const catMonth = new Map<string, number>(); // `${catId}|${month}` -> spent
  for (const r of spendRows) {
    spentBy.set(r.month, (spentBy.get(r.month) ?? 0) + r.spent);
    catMonth.set(`${r.categoryId}|${r.month}`, r.spent);
  }
  const incomeBy = new Map(incomeRows.map((r) => [r.month, r.income]));
  const sp = (mm: string) => spentBy.get(mm) ?? 0;
  const inc = (mm: string) => incomeBy.get(mm) ?? 0;
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

  // Full months to average over: ones with any income or spending. The month the budget started is usually
  // partial, so it only counts when there's nothing later to use.
  const hasData = (mm: Month) => sp(mm) !== 0 || inc(mm) !== 0;
  const fullMonths: Month[] = [];
  for (let i = LOOKBACK; i >= 1; i--) {
    const mm = addMonths(cur, -i);
    if (mm > firstMonth && hasData(mm)) fullMonths.push(mm);
  }
  if (fullMonths.length === 0 && firstMonth < cur && hasData(firstMonth)) fullMonths.push(firstMonth);

  // ---- this month so far
  const spentNow = sp(cur);
  const avgSpent = avg(fullMonths.map(sp));
  const thisMonth = {
    spent: spentNow,
    income: inc(cur),
    projected: day > 0 ? Math.round((spentNow / day) * dim) : spentNow,
    avgSpent,
  };

  // ---- averages over the full months
  const avgIncome = avg(fullMonths.map(inc));
  const averages = {
    months: fullMonths.length,
    income: avgIncome,
    spent: avgSpent,
    net: avgIncome !== null && avgSpent !== null ? avgIncome - avgSpent : null,
    savingsRate: avgIncome && avgSpent !== null ? Math.round(((avgIncome - avgSpent) / avgIncome) * 1000) / 10 : null,
  };

  // ---- month by month, newest first
  const monthly = [cur, ...[...fullMonths].reverse()].map((mm) => ({ month: mm, income: inc(mm), spent: sp(mm), net: inc(mm) - sp(mm), partial: mm === cur }));

  // ---- budget vs spending this month. Uses the same numbers as the Budget page: what a category has to
  // spend this month is what it carried over plus what was assigned; refunds are already netted out of spending.
  const view = monthView(cur);
  const budgetVsSpent = view.groups
    .filter((g) => !g.hidden && g.system === null)
    .flatMap((g) => g.categories)
    .filter((c) => !c.hidden && c.kind === 'normal')
    .map((c) => {
      const funded = c.carry + c.assigned;
      const spent = -c.activity;
      return {
        categoryId: c.id,
        name: c.name,
        carry: c.carry,
        assigned: c.assigned,
        funded,
        spent,
        left: c.available,
        // null = spending with nothing budgeted.
        used: funded > 0 ? Math.round((Math.max(0, spent) / funded) * 1000) / 10 : spent > 0 ? null : 0,
      };
    })
    .filter((r) => r.funded > 0 || r.spent > 0)
    .sort((a, b) => (b.used ?? Infinity) - (a.used ?? Infinity) || b.spent - a.spent);

  // ---- trends: last full month vs the average of the up-to-3 months before it
  const last = addMonths(cur, -1);
  const prior = [2, 3, 4].map((i) => addMonths(cur, -i)).filter((mm) => fullMonths.includes(mm));
  const trends: { name: string; groupName: string; last: number; avg: number; change: number }[] = [];
  if (fullMonths.includes(last) && prior.length > 0) {
    for (const c of cats.values()) {
      const l = catMonth.get(`${c.id}|${last}`) ?? 0;
      const a = avg(prior.map((mm) => catMonth.get(`${c.id}|${mm}`) ?? 0)) ?? 0;
      if (l === 0 && a === 0) continue;
      if (Math.abs(l - a) < 2000) continue; // ignore changes under $20
      trends.push({ name: c.name, groupName: c.groupName, last: l, avg: a, change: l - a });
    }
  }
  const up = trends.filter((t) => t.change > 0).sort((a, b) => b.change - a.change).slice(0, 5);
  const down = trends.filter((t) => t.change < 0).sort((a, b) => a.change - b.change).slice(0, 5);

  // ---- where the money goes: top categories over the full months
  const catTotals = new Map<number, number>();
  for (const r of spendRows) if (fullMonths.includes(r.month)) catTotals.set(r.categoryId, (catTotals.get(r.categoryId) ?? 0) + r.spent);
  const allSpent = [...catTotals.values()].filter((v) => v > 0).reduce((a, b) => a + b, 0);
  const topCategories = [...catTotals]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([id, total]) => ({
      name: cats.get(id)?.name ?? '?',
      groupName: cats.get(id)?.groupName ?? '',
      perMonth: Math.round(total / Math.max(1, fullMonths.length)),
      share: allSpent > 0 ? Math.round((total / allSpent) * 1000) / 10 : 0,
    }));

  // ---- top payees in the last 30 days (spending only: no transfers or income)
  const since = addDays(today, -29);
  const topPayees = db
    .prepare(
      `SELECT COALESCE(p.name, 'No payee') AS name, -SUM(t.amount) AS spent, COUNT(*) AS count
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       LEFT JOIN categories c ON c.id = t.category_id LEFT JOIN payees p ON p.id = t.payee_id
       WHERE a.on_budget = 1 AND t.transfer_account_id IS NULL AND t.date >= ? AND t.date <= ?
         AND (t.is_split = 1 OR c.kind = 'normal')
         AND COALESCE(p.name, '') NOT IN ('Starting Balance', 'Reconciliation Balance Adjustment')
       GROUP BY COALESCE(p.name, 'No payee')
       HAVING spent > 0
       ORDER BY spent DESC LIMIT 8`,
    )
    .all(since, today) as { name: string; spent: number; count: number }[];

  // ---- net worth now, and how much it changed this month and over six months. Changes leave out starting
  // balances, so adding an account doesn't look like you suddenly earned its balance.
  const netWorthNow = (db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM transactions WHERE date <= ?`).get(today) as { v: number }).v;
  const changeSince = (fromDate: string) =>
    (
      db
        .prepare(
          `SELECT COALESCE(SUM(t.amount), 0) AS v FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
           WHERE t.date >= ? AND t.date <= ? AND COALESCE(p.name, '') != 'Starting Balance'`,
        )
        .get(fromDate, today) as { v: number }
    ).v;
  const netWorth = {
    now: netWorthNow,
    changeThisMonth: changeSince(`${cur}-01`),
    changeSixMonths: changeSince(`${addMonths(cur, -6)}-01`),
  };

  return { month: cur, day, daysInMonth: dim, firstMonth, thisMonth, averages, monthly, budgetVsSpent, trends: { month: last, up, down }, topCategories, topPayees, netWorth };
}
