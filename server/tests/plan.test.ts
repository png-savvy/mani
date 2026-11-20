import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated database for this test run.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mani-plan-test-'));
process.env.DATA_DIR = dir;

const { db } = await import('../db.ts');
const { getPlan, savePlan, planPreview, applyPlan, planStatus, skipPlan } = await import('../plan.ts');
const { insights } = await import('../insights.ts');
const { setSetting } = await import('../db.ts');
const { createAccount } = await import('../accounts.ts');
const { saveTransaction } = await import('../txns.ts');
const { monthView } = await import('../budget.ts');
const { currentMonth, addMonths } = await import('../../shared/util.ts');

const M1 = currentMonth();
const catId = (name: string) => (db.prepare(`SELECT id FROM categories WHERE name = ?`).get(name) as { id: number }).id;
const assigned = (name: string, m: string) =>
  (db.prepare(`SELECT assigned FROM budget_amounts WHERE category_id = ? AND month = ?`).get(catId(name), m) as { assigned: number } | undefined)?.assigned ?? 0;
const status = (e: unknown) => (e as { status?: number }).status;

test('empty plan to start', () => {
  assert.deepEqual(getPlan(), { income: 0, amounts: {}, percents: {}, effective: {}, total: 0 });
  assert.equal(planStatus(M1).total, 0);
});

test('saving: total cannot exceed monthly income', () => {
  assert.throws(() => savePlan({ income: 100000, amounts: { [catId('Groceries')]: 80000, [catId('Electric')]: 30000 } }), (e) => status(e) === 400);
  assert.equal(getPlan().total, 0, 'nothing saved after a rejected plan');

  const p = savePlan({ income: 100000, amounts: { [catId('Groceries')]: 60000, [catId('Electric')]: 15000, [catId('Water')]: 0 } });
  assert.equal(p.income, 100000);
  assert.equal(p.total, 75000);
  assert.deepEqual(p.amounts, { [catId('Groceries')]: 60000, [catId('Electric')]: 15000 });
});

test('saving: exactly equal to income is allowed; lowering income below the plan is not', () => {
  savePlan({ income: 75000, amounts: {} });
  assert.equal(getPlan().income, 75000);
  assert.throws(() => savePlan({ income: 74999, amounts: {} }), (e) => status(e) === 400);
  assert.equal(getPlan().income, 75000);
});

test('saving: rejects negative, fractional, unknown and income categories', () => {
  assert.throws(() => savePlan({ income: 100000, amounts: { [catId('Groceries')]: -1 } }), (e) => status(e) === 400);
  assert.throws(() => savePlan({ income: 100000, amounts: { [catId('Groceries')]: 10.5 } }), (e) => status(e) === 400);
  assert.throws(() => savePlan({ income: 100000, amounts: { 999999: 100 } }), (e) => status(e) === 400);
  assert.throws(() => savePlan({ income: 100000, amounts: { [catId('Inflow: Ready to Assign')]: 100 } }), (e) => status(e) === 400);
  assert.throws(() => savePlan({ income: -5, amounts: {} }), (e) => status(e) === 400);
  assert.equal(getPlan().total, 75000);
});

test('applying raises Assigned to the plan amount and never lowers it', () => {
  // Already assigned by hand: Groceries below plan, Electric above plan.
  const up = db.prepare(`INSERT INTO budget_amounts (category_id, month, assigned) VALUES (?, ?, ?)`);
  up.run(catId('Groceries'), M1, 20000);
  up.run(catId('Electric'), M1, 25000);

  const pv = planPreview(M1);
  assert.equal(pv.appliedAt, null);
  const row = (n: string) => pv.rows.find((r) => r.name === n)!;
  assert.deepEqual([row('Groceries').current, row('Groceries').next], [20000, 60000]);
  assert.deepEqual([row('Electric').current, row('Electric').next], [25000, 25000]);
  assert.equal(pv.addedTotal, 40000);

  const r = applyPlan(M1);
  assert.deepEqual(r, { changed: 1, added: 40000 });
  assert.equal(assigned('Groceries', M1), 60000);
  assert.equal(assigned('Electric', M1), 25000, 'never lowered');
  assert.equal(assigned('Water', M1), 0, 'categories outside the plan untouched');

  const v = monthView(M1);
  const g = v.groups.flatMap((x) => x.categories).find((c) => c.name === 'Groceries')!;
  assert.equal(g.assigned, 60000, 'budget view shows the new amount');
});

test('applying is once per month unless asked again, and is idempotent', () => {
  assert.ok(planStatus(M1).appliedAt, 'marked as applied');
  assert.throws(() => applyPlan(M1), (e) => status(e) === 409);
  assert.equal(assigned('Groceries', M1), 60000);

  const again = applyPlan(M1, true);
  assert.deepEqual(again, { changed: 0, added: 0 }, 'nothing doubles up');
  assert.equal(assigned('Groceries', M1), 60000);
});

test('each month is separate; past months are refused', () => {
  const next = addMonths(M1, 1);
  assert.equal(planStatus(next).appliedAt, null);
  assert.equal(planStatus(next).canApply, true);
  applyPlan(next);
  assert.equal(assigned('Groceries', next), 60000);
  assert.equal(assigned('Electric', next), 15000);

  const prev = addMonths(M1, -1);
  assert.equal(planStatus(prev).canApply, false);
  assert.throws(() => applyPlan(prev), (e) => status(e) === 400);
  assert.equal(assigned('Groceries', prev), 0);
});

test('hidden categories leave the plan', () => {
  db.prepare(`UPDATE categories SET hidden = 1 WHERE id = ?`).run(catId('Electric'));
  assert.equal(getPlan().total, 60000);
  assert.equal(planPreview(addMonths(M1, 2)).rows.some((r) => r.name === 'Electric'), false);
  assert.throws(() => savePlan({ income: 100000, amounts: { [catId('Electric')]: 100 } }), (e) => status(e) === 400);
  db.prepare(`UPDATE categories SET hidden = 0 WHERE id = ?`).run(catId('Electric'));
  assert.equal(getPlan().total, 75000, 'amount comes back when unhidden');
});

test('an empty plan cannot be applied', () => {
  savePlan({ income: 75000, amounts: { [catId('Groceries')]: 0, [catId('Electric')]: 0 } });
  assert.equal(getPlan().total, 0);
  assert.throws(() => applyPlan(addMonths(M1, 3)), (e) => status(e) === 400);
  assert.equal(planStatus(addMonths(M1, 3)).appliedAt, null);
});

test('percent of income: follows the income and counts toward the limit', () => {
  const tithe = catId('Groceries'); // any normal category works
  const p = savePlan({ income: 100000, amounts: { [catId('Electric')]: 15000 }, percents: { [tithe]: 1000 } });
  assert.deepEqual(p.percents, { [tithe]: 1000 });
  assert.equal(p.effective[tithe], 10000, '10% of $1,000');
  assert.equal(p.amounts[tithe], undefined, 'a percentage replaces the dollar amount');
  assert.equal(p.total, 25000);

  // Raising income raises the percentage category with it.
  const p2 = savePlan({ income: 123456, amounts: {} });
  assert.equal(p2.effective[tithe], 12346, '10% of $1,234.56 rounds to the nearest cent');
  assert.equal(p2.total, 15000 + 12346);

  // 12.5% is stored exactly.
  assert.equal(savePlan({ income: 100000, amounts: {}, percents: { [tithe]: 1250 } }).effective[tithe], 12500);

  // Percentages count toward the income limit.
  assert.throws(() => savePlan({ income: 100000, amounts: {}, percents: { [tithe]: 9000 } }), (e) => status(e) === 400);
  // Out of range, fractional basis points, or both kinds at once are refused.
  assert.throws(() => savePlan({ income: 100000, amounts: {}, percents: { [tithe]: 10001 } }), (e) => status(e) === 400);
  assert.throws(() => savePlan({ income: 100000, amounts: {}, percents: { [tithe]: 10.5 } }), (e) => status(e) === 400);
  assert.throws(() => savePlan({ income: 100000, amounts: { [tithe]: 500 }, percents: { [tithe]: 1000 } }), (e) => status(e) === 400);
  assert.equal(getPlan().percents[tithe], 1250, 'unchanged after refusals');

  // Preview and apply use the computed amount.
  const m = addMonths(M1, 4);
  const row = planPreview(m).rows.find((r) => r.categoryId === tithe)!;
  assert.equal(row.plan, 12500);
  assert.equal(row.percent, 1250);
  applyPlan(m);
  assert.equal(assigned('Groceries', m), 12500);

  // Switching back to dollars clears the percentage.
  const p3 = savePlan({ income: 100000, amounts: { [tithe]: 7000 } });
  assert.deepEqual(p3.percents, {});
  assert.equal(p3.effective[tithe], 7000);
});

test('skip marks a month done without assigning anything', () => {
  const m = addMonths(M1, 5);
  skipPlan(m);
  assert.ok(planStatus(m).appliedAt);
  assert.equal(assigned('Groceries', m), 0);
  assert.throws(() => applyPlan(m), (e) => status(e) === 409);
  assert.throws(() => skipPlan(addMonths(M1, -1)), (e) => status(e) === 400);
});

test('hiding card payment categories removes them from the plan', () => {
  const card = createAccount({ name: 'Visa', type: 'credit_card', balance: 0, date: `${M1}-01` }).id;
  const ccCat = (db.prepare(`SELECT id FROM categories WHERE kind = 'cc_payment' AND linked_account_id = ?`).get(card) as { id: number }).id;
  savePlan({ income: 100000, amounts: { [ccCat]: 1000 } });
  assert.equal(getPlan().effective[ccCat], 1000);
  setSetting('show_cc_payments', '0');
  assert.equal(getPlan().effective[ccCat], undefined);
  assert.throws(() => savePlan({ income: 100000, amounts: { [ccCat]: 1000 } }), (e) => status(e) === 400);
  setSetting('show_cc_payments', '1');
  assert.equal(getPlan().effective[ccCat], 1000);
  savePlan({ income: 100000, amounts: { [ccCat]: 0 } });
});

test('insights add up', () => {
  const chk = createAccount({ name: 'Checking', type: 'checking', balance: 0, date: `${addMonths(M1, -3)}-01` }).id;
  const rta = (db.prepare(`SELECT id FROM categories WHERE kind = 'income'`).get() as { id: number }).id;
  const day = (m: string) => `${m}-01`;
  const txn = (date: string, amount: number, categoryId: number, payee: string) =>
    saveTransaction({ accountId: chk, date, amount, categoryId, payeeName: payee, memo: '', cleared: 'cleared' } as any);
  for (const i of [3, 2, 1]) txn(day(addMonths(M1, -i)), 300000, rta, 'Employer');
  txn(day(addMonths(M1, -3)), -10000, catId('Groceries'), 'Store'); // first (partial) month: not averaged
  txn(day(addMonths(M1, -2)), -20000, catId('Groceries'), 'Store');
  txn(day(addMonths(M1, -1)), -50000, catId('Groceries'), 'Store');
  txn(day(addMonths(M1, -1)), 5000, catId('Groceries'), 'Store'); // refund lowers spending

  const r = insights();
  assert.equal(r.averages.months, 2, 'the partial first month is left out');
  assert.equal(r.averages.income, 300000);
  assert.equal(r.averages.spent, Math.round((20000 + 45000) / 2));
  assert.equal(r.averages.savingsRate, Math.round(((300000 - 32500) / 300000) * 1000) / 10);
  const last = r.monthly.find((x) => x.month === addMonths(M1, -1))!;
  assert.deepEqual([last.income, last.spent, last.net], [300000, 45000, 255000]);
  const up = r.trends.up.find((x) => x.name === 'Groceries')!;
  assert.deepEqual([up.avg, up.last, up.change], [20000, 45000, 25000]);
  assert.equal(r.topCategories[0].name, 'Groceries');

  // Budget vs spending uses carry-over + assigned, and refunds reduce spending.
  txn(`${M1}-01`, -8000, catId('Groceries'), 'Store');
  txn(`${M1}-01`, 3000, catId('Groceries'), 'Store');
  const g = insights().budgetVsSpent.find((x) => x.name === 'Groceries')!;
  const bv = monthView(M1).groups.flatMap((x) => x.categories).find((c) => c.name === 'Groceries')!;
  assert.equal(g.spent, 5000);
  assert.equal(g.assigned, bv.assigned);
  assert.equal(g.carry, bv.carry);
  assert.equal(g.funded, bv.carry + bv.assigned);
  assert.ok(g.carry !== 0, 'earlier months carry into this one');
  assert.equal(g.left, g.funded - g.spent);
  assert.equal(g.used, Math.round((5000 / g.funded) * 1000) / 10);
});
