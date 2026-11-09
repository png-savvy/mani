import { db, getSetting } from './db.ts';
import {
  addMonths,
  currentMonth,
  isCreditType,
  monthDiff,
  monthOf,
  type Month,
  type TargetType,
} from '../shared/util.ts';

/**
 * The budget engine. Implements zero-based envelope budgeting rules:
 *
 *  - Available = (positive available carried from last month) + assigned + activity.
 *  - Negative available resets to 0 next month. The *cash* part of that overspending is
 *    deducted from Ready to Assign in the following month; the *credit* part stays as
 *    unfunded credit card debt (it shows up as a shortfall in the card's payment category).
 *  - Spending on a credit card moves the funded amount (up to what the category had available
 *    after cash spending) into that card's Credit Card Payment category. Refunds on a card move
 *    money back out of the payment category.
 *  - A transfer from a cash account to a credit card is activity in the card's payment category.
 *  - Ready to Assign (for month M) = all "Inflow: Ready to Assign" income dated in or before M
 *    - everything assigned in every month (including future months)
 *    - cash overspending from months before M.
 */

export interface CatState {
  carry: number;
  assigned: number;
  activity: number;
  available: number;
  cashOverspent: number;
  creditOverspent: number;
}

interface CategoryRow {
  id: number;
  group_id: number;
  name: string;
  sort: number;
  hidden: number;
  note: string;
  kind: 'normal' | 'income' | 'cc_payment';
  linked_account_id: number | null;
  target_type: TargetType | null;
  target_amount: number | null;
  target_date: string | null;
}

export interface Computation {
  mode: BudgetMode;
  firstMonth: Month;
  lastMonth: Month;
  categories: CategoryRow[];
  state: Map<Month, Map<number, CatState>>;
  income: Map<Month, number>;
  assignedTotal: Map<Month, number>;
  cashOverspent: Map<Month, number>;
}

function bump(map: Map<string, number>, key: string, v: number) {
  map.set(key, (map.get(key) ?? 0) + v);
}

export type BudgetMode = 'rolling' | 'monthly';

export function budgetMode(): BudgetMode {
  return getSetting('budget_mode') === 'monthly' ? 'monthly' : 'rolling';
}

/**
 * mode 'monthly': negative balances reset each month; cash overspending comes out of next month's Ready to Assign.
 * mode 'rolling': balances (positive or negative) simply carry forward until you cover them; Ready to Assign = income - assigned.
 */
export function compute(throughMonth: Month, mode: BudgetMode = budgetMode()): Computation {
  const rolling = mode === 'rolling';
  const categories = db.prepare(`SELECT * FROM categories`).all() as CategoryRow[];
  const accounts = db.prepare(`SELECT id, type, on_budget FROM accounts`).all() as { id: number; type: string; on_budget: number }[];
  const creditAccounts = new Set(accounts.filter((a) => a.on_budget && isCreditType(a.type)).map((a) => a.id));

  // Category activity from on-budget accounts, split into cash vs per-credit-card.
  const actRows = db
    .prepare(
      `SELECT c.category_id AS cat, substr(c.date,1,7) AS month, c.account_id AS acct, SUM(c.amount) AS total
       FROM (
         SELECT account_id, date, amount, category_id FROM transactions WHERE is_split = 0 AND category_id IS NOT NULL
         UNION ALL
         SELECT t.account_id, t.date, s.amount, s.category_id
           FROM subtransactions s JOIN transactions t ON t.id = s.transaction_id WHERE s.category_id IS NOT NULL
       ) c JOIN accounts a ON a.id = c.account_id
       WHERE a.on_budget = 1
       GROUP BY c.category_id, month, c.account_id`,
    )
    .all() as { cat: number; month: Month; acct: number; total: number }[];

  // cat -> month -> { cash, cards: acct -> net }
  const activity = new Map<number, Map<Month, { cash: number; cards: Map<number, number> }>>();
  let firstMonth = currentMonth();
  let maxDataMonth = currentMonth();
  for (const r of actRows) {
    if (r.month < firstMonth) firstMonth = r.month;
    if (r.month > maxDataMonth) maxDataMonth = r.month;
    let byMonth = activity.get(r.cat);
    if (!byMonth) activity.set(r.cat, (byMonth = new Map()));
    let entry = byMonth.get(r.month);
    if (!entry) byMonth.set(r.month, (entry = { cash: 0, cards: new Map() }));
    if (creditAccounts.has(r.acct)) entry.cards.set(r.acct, (entry.cards.get(r.acct) ?? 0) + r.total);
    else entry.cash += r.total;
  }

  // Payments: transfers from on-budget cash accounts into on-budget credit accounts (and cash advances back).
  const payRows = db
    .prepare(
      `SELECT t.transfer_account_id AS card, substr(t.date,1,7) AS month, SUM(t.amount) AS total
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN accounts b ON b.id = t.transfer_account_id
       WHERE a.on_budget = 1 AND a.type NOT IN ('credit_card','line_of_credit')
         AND b.on_budget = 1 AND b.type IN ('credit_card','line_of_credit')
       GROUP BY card, month`,
    )
    .all() as { card: number; month: Month; total: number }[];
  const payments = new Map<string, number>();
  for (const r of payRows) {
    if (r.month < firstMonth) firstMonth = r.month;
    if (r.month > maxDataMonth) maxDataMonth = r.month;
    bump(payments, `${r.card}|${r.month}`, r.total);
  }

  const assignedRows = db.prepare(`SELECT category_id AS cat, month, assigned FROM budget_amounts WHERE assigned != 0`).all() as {
    cat: number;
    month: Month;
    assigned: number;
  }[];
  const assigned = new Map<string, number>();
  const assignedTotal = new Map<Month, number>();
  for (const r of assignedRows) {
    if (r.month < firstMonth) firstMonth = r.month;
    if (r.month > maxDataMonth) maxDataMonth = r.month;
    assigned.set(`${r.cat}|${r.month}`, r.assigned);
    assignedTotal.set(r.month, (assignedTotal.get(r.month) ?? 0) + r.assigned);
  }

  const income = new Map<Month, number>();
  const incomeCats = categories.filter((c) => c.kind === 'income').map((c) => c.id);
  for (const id of incomeCats) {
    for (const [m, e] of activity.get(id) ?? []) {
      let total = e.cash;
      for (const v of e.cards.values()) total += v;
      income.set(m, (income.get(m) ?? 0) + total);
    }
  }

  // Rolling balances include everything ever entered, even future-dated items.
  const lastMonth = [throughMonth, currentMonth(), firstMonth, ...(rolling ? [maxDataMonth] : [])].sort().pop()!;
  // Rolling mode: card spending not yet covered by its category, per category and card (carried month to month).
  const owed = new Map<number, Map<number, number>>();

  const normalCats = categories.filter((c) => c.kind === 'normal' || (c.kind === 'cc_payment' && !c.linked_account_id));
  const paymentCats = categories.filter((c) => c.kind === 'cc_payment' && c.linked_account_id);

  const state = new Map<Month, Map<number, CatState>>();
  const cashOverspent = new Map<Month, number>();
  let prev: Map<number, CatState> | undefined;

  for (let m = firstMonth; m <= lastMonth; m = addMonths(m, 1)) {
    const cur = new Map<number, CatState>();
    const payMoves = new Map<number, number>();
    let cashOver = 0;

    for (const c of normalCats) {
      const prevAvail = prev?.get(c.id)?.available ?? 0;
      const carry = rolling || prevAvail > 0 ? prevAvail : 0;
      const a = assigned.get(`${c.id}|${m}`) ?? 0;
      const act = activity.get(c.id)?.get(m);
      let catOwed = owed.get(c.id);
      if (rolling && !catOwed) owed.set(c.id, (catOwed = new Map()));
      const cash = act?.cash ?? 0;
      let fund = carry + a + cash; // money left after cash spending
      let creditNet = 0;
      let unfunded = 0;
      if (act) {
        // Refunds first: money comes back to the category from the card's payment category.
        for (const [card, net] of act.cards) {
          creditNet += net;
          if (net > 0) {
            payMoves.set(card, (payMoves.get(card) ?? 0) - net);
            fund += net;
          }
        }
        for (const [card, net] of act.cards) {
          if (net < 0) {
            const spend = -net;
            const funded = Math.min(spend, Math.max(0, fund));
            fund -= funded;
            unfunded += spend - funded;
            payMoves.set(card, (payMoves.get(card) ?? 0) + funded);
            if (catOwed && spend > funded) catOwed.set(card, (catOwed.get(card) ?? 0) + spend - funded);
          }
        }
      }
      const activityTotal = cash + creditNet;
      const available = carry + a + activityTotal;
      let creditOver = 0;
      let cashOv = 0;
      if (catOwed) {
        // Uncovered card spending can never exceed how negative the category is. When money is added to the
        // category, the part that covers card spending moves to that card's payment category.
        let total = 0;
        for (const v of catOwed.values()) total += v;
        let release = total - Math.max(0, -available);
        for (const [card, v] of catOwed) {
          if (release <= 0) break;
          const r = Math.min(v, release);
          catOwed.set(card, v - r);
          payMoves.set(card, (payMoves.get(card) ?? 0) + r);
          release -= r;
          total -= r;
        }
        creditOver = total;
        cashOv = Math.max(0, -available) - creditOver;
      } else if (available < 0) {
        creditOver = Math.min(-available, unfunded);
        cashOv = -available - creditOver;
      }
      cashOver += cashOv;
      cur.set(c.id, { carry, assigned: a, activity: activityTotal, available, cashOverspent: cashOv, creditOverspent: creditOver });
    }

    for (const c of paymentCats) {
      const card = c.linked_account_id!;
      const prevAvail = prev?.get(c.id)?.available ?? 0;
      const carry = rolling || prevAvail > 0 ? prevAvail : 0;
      const a = assigned.get(`${c.id}|${m}`) ?? 0;
      const act = (payMoves.get(card) ?? 0) + (payments.get(`${card}|${m}`) ?? 0);
      // Anything categorized directly to the payment category also counts.
      const direct = activity.get(c.id)?.get(m);
      let directTotal = 0;
      if (direct) {
        directTotal += direct.cash;
        for (const v of direct.cards.values()) directTotal += v;
      }
      const activityTotal = act + directTotal;
      const available = carry + a + activityTotal;
      const cashOv = available < 0 ? -available : 0;
      cashOver += cashOv;
      cur.set(c.id, { carry, assigned: a, activity: activityTotal, available, cashOverspent: cashOv, creditOverspent: 0 });
    }

    cashOverspent.set(m, cashOver);
    state.set(m, cur);
    prev = cur;
  }

  return { mode, firstMonth, lastMonth, categories, state, income, assignedTotal, cashOverspent };
}

/** Rolling mode: one Ready to Assign for everything, plus how much of the category balances is overspent. */
export function rollingTotals(comp: Computation) {
  let income = 0;
  let assignedAll = 0;
  for (const v of comp.income.values()) income += v;
  for (const v of comp.assignedTotal.values()) assignedAll += v;
  let cashOverspent = 0;
  let creditOverspent = 0;
  for (const s of comp.state.get(comp.lastMonth)?.values() ?? []) {
    cashOverspent += s.cashOverspent;
    creditOverspent += s.creditOverspent;
  }
  const total = income - assignedAll;
  return { total, income, assignedAll, cashOverspent, creditOverspent, trulyFree: total - cashOverspent };
}

export function readyToAssign(comp: Computation, month: Month) {
  let incomeBefore = 0;
  let assignedBefore = 0;
  let overBeforePrev = 0;
  let assignedFuture = 0;
  for (const [m, v] of comp.income) if (m < month) incomeBefore += v;
  for (const [m, v] of comp.assignedTotal) {
    if (m < month) assignedBefore += v;
    else if (m > month) assignedFuture += v;
  }
  const prevMonth = addMonths(month, -1);
  for (const [m, v] of comp.cashOverspent) if (m < prevMonth) overBeforePrev += v;
  const incomeThisMonth = comp.income.get(month) ?? 0;
  const overspentPrev = comp.cashOverspent.get(prevMonth) ?? 0;
  const assignedThisMonth = comp.assignedTotal.get(month) ?? 0;
  const leftOver = incomeBefore - assignedBefore - overBeforePrev;
  const total = leftOver + incomeThisMonth - overspentPrev - assignedThisMonth - assignedFuture;
  return { total, leftOver, incomeThisMonth, overspentPrev, assignedThisMonth, assignedFuture };
}

export interface TargetStatus {
  needed: number; // amount needed this month in total for the target
  funded: number; // amount counted toward it
  underfunded: number;
  complete: boolean;
  description: string;
}

export function targetStatus(cat: CategoryRow, s: CatState, month: Month): TargetStatus | null {
  if (!cat.target_type || cat.target_amount == null) return null;
  const amt = cat.target_amount;
  switch (cat.target_type) {
    case 'monthly_set_aside': {
      const underfunded = Math.max(0, amt - s.assigned);
      return { needed: amt, funded: Math.min(amt, Math.max(0, s.assigned)), underfunded, complete: underfunded === 0, description: 'Set aside this month' };
    }
    case 'monthly_refill': {
      const have = s.carry + s.assigned;
      const underfunded = Math.max(0, amt - have);
      return { needed: amt, funded: Math.min(amt, Math.max(0, have)), underfunded, complete: underfunded === 0, description: 'Refill up to this month' };
    }
    case 'balance': {
      const underfunded = Math.max(0, amt - s.available);
      return { needed: amt, funded: Math.min(amt, Math.max(0, s.available)), underfunded, complete: underfunded === 0, description: 'Have a balance of' };
    }
    case 'by_date': {
      const targetMonth = cat.target_date ? monthOf(cat.target_date) : month;
      const remaining = Math.max(0, amt - s.carry);
      const monthsLeft = Math.max(1, monthDiff(month, targetMonth) + 1);
      if (month > targetMonth) {
        const underfunded = Math.max(0, amt - s.available);
        return { needed: amt, funded: Math.min(amt, Math.max(0, s.available)), underfunded, complete: underfunded === 0, description: 'Have a balance of' };
      }
      const neededThisMonth = Math.ceil(remaining / monthsLeft);
      const underfunded = Math.max(0, neededThisMonth - s.assigned);
      return {
        needed: neededThisMonth,
        funded: Math.min(neededThisMonth, Math.max(0, s.assigned)),
        underfunded,
        complete: underfunded === 0,
        description: `Needed this month to reach goal by ${cat.target_date}`,
      };
    }
    default:
      return null;
  }
}

export function emptyState(): CatState {
  return { carry: 0, assigned: 0, activity: 0, available: 0, cashOverspent: 0, creditOverspent: 0 };
}

export function monthView(requestedMonth: Month) {
  const mode = budgetMode();
  // Rolling mode has no month navigation: "this month" columns are the calendar month, balances include everything.
  const month = mode === 'rolling' ? currentMonth() : requestedMonth;
  const comp = compute(month, mode);
  const st = comp.state.get(month) ?? new Map<number, CatState>();
  const latest = comp.state.get(comp.lastMonth) ?? st;
  const stateFor = (id: number): CatState => {
    const s = st.get(id) ?? emptyState();
    if (mode !== 'rolling') return s;
    const l = latest.get(id) ?? s;
    // Balance-related fields come from the latest state (future-dated items included); carry makes the numbers add up.
    return { ...s, available: l.available, cashOverspent: l.cashOverspent, creditOverspent: l.creditOverspent, carry: l.available - s.assigned - s.activity };
  };
  const groups = db.prepare(`SELECT * FROM category_groups ORDER BY sort, id`).all() as {
    id: number;
    name: string;
    sort: number;
    hidden: number;
    system: string | null;
  }[];
  const cats = [...comp.categories].sort((a, b) => a.sort - b.sort || a.id - b.id);

  const outGroups = groups
    .filter((g) => g.system !== 'internal')
    .map((g) => {
      const categories = cats
        .filter((c) => c.group_id === g.id)
        .map((c) => {
          const s = stateFor(c.id);
          return {
            id: c.id,
            groupId: c.group_id,
            name: c.name,
            hidden: !!c.hidden,
            note: c.note,
            kind: c.kind,
            linkedAccountId: c.linked_account_id,
            target: c.target_type ? { type: c.target_type, amount: c.target_amount, date: c.target_date } : null,
            targetStatus: targetStatus(c, s, month),
            ...s,
          };
        });
      return { id: g.id, name: g.name, hidden: !!g.hidden, system: g.system, sort: g.sort, categories };
    });

  const uncategorized = db
    .prepare(
      `SELECT COUNT(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
       LEFT JOIN accounts b ON b.id = t.transfer_account_id
       WHERE a.on_budget = 1 AND t.is_split = 0 AND t.category_id IS NULL
         AND (t.transfer_account_id IS NULL OR b.on_budget = 0)
         AND NOT (a.type IN ('credit_card','line_of_credit') AND t.payee_id = (SELECT id FROM payees WHERE name = 'Starting Balance'))`,
    )
    .get() as { n: number };

  const rta = readyToAssign(comp, month);
  if (mode === 'rolling') {
    const r = rollingTotals(comp);
    rta.total = r.total;
    Object.assign(rta, { rolling: r });
  }
  return {
    mode,
    month,
    firstMonth: comp.firstMonth,
    readyToAssign: rta,
    groups: outGroups,
    uncategorizedCount: uncategorized.n,
    ageOfMoney: ageOfMoney(),
  };
}

/**
 * Age of Money: average age (in days) of the dollars spent in the last 10 cash outflows, using
 * first-in-first-out matching of outflows against inflows on on-budget cash accounts. Transfers
 * between cash accounts are ignored; credit card payments count as outflows.
 */
export function ageOfMoney(): number | null {
  const rows = db
    .prepare(
      `SELECT t.date, t.amount FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN accounts b ON b.id = t.transfer_account_id
       WHERE a.on_budget = 1 AND a.type NOT IN ('credit_card','line_of_credit')
         AND t.date <= date('now','localtime')
         AND NOT (b.id IS NOT NULL AND b.on_budget = 1 AND b.type NOT IN ('credit_card','line_of_credit'))
       ORDER BY t.date, CASE WHEN t.amount > 0 THEN 0 ELSE 1 END, t.id`,
    )
    .all() as { date: string; amount: number }[];
  const buckets: { date: string; left: number }[] = [];
  let head = 0;
  const ages: number[] = [];
  for (const r of rows) {
    if (r.amount > 0) {
      buckets.push({ date: r.date, left: r.amount });
      continue;
    }
    let need = -r.amount;
    if (need === 0) continue;
    let weighted = 0;
    let matched = 0;
    while (need > 0 && head < buckets.length) {
      const b = buckets[head];
      const take = Math.min(need, b.left);
      weighted += take * ((Date.parse(r.date) - Date.parse(b.date)) / 86400000);
      matched += take;
      b.left -= take;
      need -= take;
      if (b.left === 0) head++;
    }
    if (matched > 0) ages.push(weighted / matched);
  }
  if (ages.length < 1) return null;
  const last = ages.slice(-10);
  return Math.round(last.reduce((s, v) => s + v, 0) / last.length);
}
