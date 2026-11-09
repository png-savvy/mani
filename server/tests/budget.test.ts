import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated database for this test run.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mani-test-'));
process.env.DATA_DIR = dir;

const { db, setSetting } = await import('../db.ts');
// Most tests below check the monthly rules; the rolling tests switch modes explicitly.
setSetting('budget_mode', 'monthly');
const { createAccount, reconcileAccount } = await import('../accounts.ts');
const { saveTransaction, deleteTransaction, importTransactions, listTransactions } = await import('../txns.ts');
const { monthView } = await import('../budget.ts');
const { currentMonth, addMonths, nextOccurrence, parseMoney, decimalToCents } = await import('../../shared/util.ts');

const M1 = currentMonth();
const M0 = addMonths(M1, -1);
const d = (m: string, day: number) => `${m}-${String(day).padStart(2, '0')}`;
const catId = (name: string) => (db.prepare(`SELECT id FROM categories WHERE name = ?`).get(name) as { id: number }).id;
const assign = (cat: string, m: string, cents: number) =>
  db
    .prepare(
      `INSERT INTO budget_amounts (category_id, month, assigned) VALUES (?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET assigned = excluded.assigned`,
    )
    .run(catId(cat), m, cents);
const cat = (view: any, name: string) => view.groups.flatMap((g: any) => g.categories).find((c: any) => c.name === name);
const balance = (acct: number) => (db.prepare(`SELECT COALESCE(SUM(amount),0) AS b FROM transactions WHERE account_id = ?`).get(acct) as any).b;

test('shared helpers', () => {
  assert.equal(parseMoney('1,234.56'), 123456);
  assert.equal(parseMoney('10+2.5*2'), 1500);
  assert.equal(parseMoney('-5'), -500);
  assert.equal(parseMoney('abc'), null);
  assert.equal(decimalToCents('-12.34'), -1234);
  assert.equal(decimalToCents('0.1'), 10);
  assert.equal(decimalToCents('19.999'), 2000);
  assert.equal(nextOccurrence('2026-01-31', 'monthly', 31), '2026-02-28');
  assert.equal(nextOccurrence('2026-02-28', 'monthly', 31), '2026-03-31');
  assert.equal(nextOccurrence('2026-01-01', 'twiceAMonth', 1), '2026-01-16');
  assert.equal(nextOccurrence('2026-01-16', 'twiceAMonth', 1), '2026-02-01');
  assert.equal(nextOccurrence('2026-12-30', 'everyOtherWeek'), '2027-01-13');
  assert.equal(nextOccurrence('2026-05-05', 'never'), null);
});

let checking: number;
let card: number;

test('starting balances: cash goes to Ready to Assign, card debt does not', () => {
  checking = createAccount({ name: 'Checking', type: 'checking', balance: 100000, date: d(M0, 1) }).id;
  card = createAccount({ name: 'Visa', type: 'credit_card', balance: -50000, date: d(M0, 1) }).id;
  const v = monthView(M0);
  assert.equal(v.readyToAssign.total, 100000);
  const pay = cat(v, 'Visa');
  assert.equal(pay.kind, 'cc_payment');
  assert.equal(pay.available, 0);
  assert.equal(v.uncategorizedCount, 0, 'card starting debt is not "uncategorized"');
});

test('assigning and cash spending', () => {
  assign('Groceries', M0, 30000);
  saveTransaction({ accountId: checking, date: d(M0, 5), amount: -10000, payeeName: 'Market', categoryId: catId('Groceries') });
  const v = monthView(M0);
  assert.equal(v.readyToAssign.total, 70000);
  assert.equal(cat(v, 'Groceries').available, 20000);
  assert.equal(cat(v, 'Groceries').activity, -10000);
});

test('credit card spending moves funded money to the payment category', () => {
  assign('Dining Out', M0, 3000);
  saveTransaction({ accountId: card, date: d(M0, 6), amount: -5000, payeeName: 'Bistro', categoryId: catId('Dining Out') });
  const v = monthView(M0);
  const dining = cat(v, 'Dining Out');
  assert.equal(dining.available, -2000);
  assert.equal(dining.creditOverspent, 2000);
  assert.equal(dining.cashOverspent, 0);
  assert.equal(cat(v, 'Visa').activity, 3000, 'only the funded $30 moves');
  assert.equal(cat(v, 'Visa').available, 3000);
  assert.equal(v.readyToAssign.total, 70000 - 3000);
});

test('cash overspending reduces next month Ready to Assign; credit overspending does not', () => {
  saveTransaction({ accountId: checking, date: d(M0, 7), amount: -4000, payeeName: 'Cinema', categoryId: catId('Entertainment') });
  const v0 = monthView(M0);
  assert.equal(cat(v0, 'Entertainment').cashOverspent, 4000);
  assert.equal(v0.readyToAssign.total, 67000, 'not deducted in the same month');
  const v1 = monthView(M1);
  assert.equal(v1.readyToAssign.overspentPrev, 4000);
  assert.equal(v1.readyToAssign.total, 63000);
  assert.equal(cat(v1, 'Entertainment').available, 0, 'negative resets');
  assert.equal(cat(v1, 'Dining Out').available, 0, 'credit overspending resets too');
  assert.equal(cat(v1, 'Groceries').available, 20000, 'positive rolls over');
  assert.equal(cat(v1, 'Visa').available, 3000);
});

test('card payment (transfer) is activity in the payment category; transfer is not categorized', () => {
  const id = saveTransaction({ accountId: checking, date: d(M1, 2), amount: -3000, transferAccountId: card, categoryId: catId('Groceries') });
  const row = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as any;
  assert.equal(row.category_id, null, 'on-budget to on-budget transfer never has a category');
  const other = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(row.transfer_txn_id) as any;
  assert.equal(other.amount, 3000);
  assert.equal(other.account_id, card);
  const v1 = monthView(M1);
  assert.equal(cat(v1, 'Visa').available, 0);
  assert.equal(cat(v1, 'Visa').activity, -3000);
  assert.equal(v1.readyToAssign.total, 63000, 'paying the card does not change Ready to Assign');
  assert.equal(balance(card), -50000 - 5000 + 3000);
});

test('refund on a credit card returns money from the payment category', () => {
  saveTransaction({ accountId: card, date: d(M1, 3), amount: 1000, payeeName: 'Market', categoryId: catId('Groceries') });
  const v1 = monthView(M1);
  assert.equal(cat(v1, 'Groceries').available, 21000);
  assert.equal(cat(v1, 'Visa').activity, -3000 - 1000);
  assert.equal(cat(v1, 'Visa').available, -1000);
});

test('income in month counts toward Ready to Assign; future assignment is subtracted', () => {
  saveTransaction({ accountId: checking, date: d(M1, 1), amount: 200000, payeeName: 'Employer', categoryId: catId('Inflow: Ready to Assign') });
  assign('Vacation', addMonths(M1, 1), 5000);
  const v1 = monthView(M1);
  assert.equal(v1.readyToAssign.incomeThisMonth, 200000);
  assert.equal(v1.readyToAssign.assignedFuture, 5000);
  // 63000 + 200000 - 5000 - (payment category cash overspend of 1000 only hits next month)
  assert.equal(v1.readyToAssign.total, 63000 + 200000 - 5000);
});

test('split transactions count per category', () => {
  saveTransaction({
    accountId: checking,
    date: d(M1, 4),
    amount: -6000,
    payeeName: 'Superstore',
    subtransactions: [
      { amount: -4000, categoryId: catId('Groceries') },
      { amount: -2000, categoryId: catId('Shopping') },
    ],
  });
  const v1 = monthView(M1);
  assert.equal(cat(v1, 'Groceries').activity, 1000 - 4000);
  assert.equal(cat(v1, 'Shopping').activity, -2000);
  assert.throws(() =>
    saveTransaction({
      accountId: checking,
      date: d(M1, 4),
      amount: -6000,
      subtransactions: [
        { amount: -1000, categoryId: catId('Groceries') },
        { amount: -2000, categoryId: catId('Shopping') },
      ],
    }),
  );
});

test('tracking account transfer carries the category on the budget side', () => {
  const invest = createAccount({ name: 'Brokerage', type: 'asset', balance: 0, date: d(M1, 1) }).id;
  saveTransaction({ accountId: invest, date: d(M1, 5), amount: 10000, transferAccountId: checking, categoryId: catId('Emergency Fund') });
  const v1 = monthView(M1);
  assert.equal(cat(v1, 'Emergency Fund').activity, -10000);
  const rows = listTransactions({ accountId: invest });
  assert.equal(rows[0].counterpartCategoryName, 'Emergency Fund');
});

test('editing a transfer updates the other side; deleting removes both', () => {
  const id = saveTransaction({ accountId: checking, date: d(M1, 8), amount: -2500, transferAccountId: card });
  const other = (db.prepare(`SELECT transfer_txn_id AS t FROM transactions WHERE id = ?`).get(id) as any).t;
  saveTransaction({ accountId: checking, date: d(M1, 9), amount: -2700, transferAccountId: card }, id);
  const o = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(other) as any;
  assert.equal(o.amount, 2700);
  assert.equal(o.date, d(M1, 9));
  deleteTransaction(id);
  assert.equal(db.prepare(`SELECT id FROM transactions WHERE id IN (?, ?)`).all(id, other).length, 0);
});

test('imports dedupe, auto-match manual entries, and remember payee categories', () => {
  const manual = saveTransaction({ accountId: checking, date: d(M1, 10), amount: -1234, payeeName: 'Coffee Shop', categoryId: catId('Dining Out') });
  const r1 = importTransactions(checking, [
    { importId: 'x1', date: d(M1, 12), amount: -1234, payeeName: 'COFFEE SHOP #42' },
    { importId: 'x2', date: d(M1, 12), amount: -999, payeeName: 'Market' },
  ]);
  assert.deepEqual(r1, { imported: 1, matched: 1, skipped: 0 });
  const m = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(manual) as any;
  assert.equal(m.import_id, 'x1');
  assert.equal(m.cleared, 'cleared');
  const x2 = db.prepare(`SELECT * FROM transactions WHERE import_id = 'x2'`).get() as any;
  assert.equal(x2.category_id, catId('Groceries'), 'category remembered from payee');
  assert.equal(x2.approved, 0);
  const r2 = importTransactions(checking, [{ importId: 'x2', date: d(M1, 12), amount: -999, payeeName: 'Market' }]);
  assert.equal(r2.skipped, 1);
});

test('reconcile creates an adjustment when balances differ and locks cleared transactions', () => {
  const cleared = (db.prepare(`SELECT SUM(amount) AS s FROM transactions WHERE account_id = ? AND cleared != 'uncleared'`).get(checking) as any).s;
  const r = reconcileAccount(checking, cleared + 500);
  assert.equal(r.adjustment, 500);
  const left = db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE account_id = ? AND cleared = 'cleared'`).get(checking) as any;
  assert.equal(left.n, 0);
});

test('targets compute underfunded amounts', async () => {
  const { targetStatus } = await import('../budget.ts');
  const base = { id: 1, group_id: 1, name: 'x', sort: 0, hidden: 0, note: '', kind: 'normal' as const, linked_account_id: null, target_date: null };
  const s = { carry: 1000, assigned: 2000, activity: -500, available: 2500, cashOverspent: 0, creditOverspent: 0 };
  assert.equal(targetStatus({ ...base, target_type: 'monthly_set_aside', target_amount: 5000 }, s, M1)!.underfunded, 3000);
  assert.equal(targetStatus({ ...base, target_type: 'monthly_refill', target_amount: 5000 }, s, M1)!.underfunded, 2000);
  assert.equal(targetStatus({ ...base, target_type: 'balance', target_amount: 5000 }, s, M1)!.underfunded, 2500);
  const due = addMonths(M1, 3) + '-15'; // 4 months including this one
  assert.equal(
    targetStatus({ ...base, target_type: 'by_date', target_amount: 9000, target_date: due }, s, M1)!.underfunded,
    Math.ceil((9000 - 1000) / 4) - 2000,
  );
});

test.after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('linked account opening balance follows the bank until history is complete', async () => {
  const { updateOpeningBalances } = await import('../banks.ts');
  const { createStartingBalance } = await import('../txns.ts');
  const { encrypt } = await import('../security.ts');
  const conn = Number(db.prepare(`INSERT INTO connections (provider, institution, secret_enc) VALUES ('plaid', 'Test', ?)`).run(encrypt('x')).lastInsertRowid);
  const acct = createAccount({ name: 'Linked', type: 'checking', balance: 0, connectionId: conn, externalId: 'ext1', importStart: d(M1, 1), skipStartingBalance: true });
  const opening = createStartingBalance(acct, 0, d(M0, 28));
  db.prepare(`UPDATE accounts SET opening_txn_id = ?, opening_auto = 1, bank_balance = 100000 WHERE id = ?`).run(opening, acct.id);

  // First sync: bank has not delivered transactions yet.
  updateOpeningBalances(conn, () => false);
  assert.equal(balance(acct.id), 100000);
  // History arrives later; a manual (not imported) entry must not be absorbed into the opening balance.
  importTransactions(acct.id, [
    { importId: 'h1', date: d(M1, 2), amount: -20000, payeeName: 'Rent Co' },
    { importId: 'h2', date: d(M1, 3), amount: 5000, payeeName: 'Refund' },
  ]);
  saveTransaction({ accountId: acct.id, date: d(M1, 4), amount: -700, payeeName: 'Not at bank yet' });
  updateOpeningBalances(conn, () => true);
  const open = db.prepare(`SELECT amount, category_id FROM transactions WHERE id = ?`).get(opening) as any;
  assert.equal(open.amount, 115000);
  assert.equal(open.category_id, catId('Inflow: Ready to Assign'));
  assert.equal(balance(acct.id), 100000 - 700, 'matches bank except the not-yet-posted manual entry');
  // Once complete, later syncs leave it alone.
  db.prepare(`UPDATE accounts SET bank_balance = 90000 WHERE id = ?`).run(acct.id);
  updateOpeningBalances(conn, () => true);
  assert.equal((db.prepare(`SELECT amount FROM transactions WHERE id = ?`).get(opening) as any).amount, 115000);
});

test('rolling mode: balances carry forward (negative too) and Ready to Assign is income minus assigned', async () => {
  const { compute, rollingTotals } = await import('../budget.ts');
  // Fresh categories so earlier tests don't interfere.
  const gid = Number(db.prepare(`INSERT INTO category_groups (name, sort) VALUES ('Rolling', 99)`).run().lastInsertRowid);
  const cat = (n: string) => Number(db.prepare(`INSERT INTO categories (group_id, name) VALUES (?, ?)`).run(gid, n).lastInsertRowid);
  const food = cat('R Food');
  const fun = cat('R Fun');
  const cash = createAccount({ name: 'R Cash', type: 'checking', balance: 0, date: d(M0, 1) }).id;
  const card = createAccount({ name: 'R Card', type: 'credit_card', balance: 0, date: d(M0, 1) }).id;
  const payCat = (db.prepare(`SELECT id FROM categories WHERE linked_account_id = ?`).get(card) as any).id;

  const before = rollingTotals(compute(M1, 'rolling'));
  saveTransaction({ accountId: cash, date: d(M0, 2), amount: -3000, payeeName: 'Shop', categoryId: food }); // cash overspend 30
  saveTransaction({ accountId: card, date: d(M0, 3), amount: -5000, payeeName: 'Show', categoryId: fun }); // card overspend 50

  let c = compute(M1, 'rolling');
  let last = c.state.get(c.lastMonth)!;
  assert.equal(last.get(food)!.available, -3000, 'negative carries into next month');
  assert.equal(last.get(food)!.cashOverspent, 3000);
  assert.equal(last.get(fun)!.available, -5000);
  assert.equal(last.get(fun)!.creditOverspent, 5000);
  assert.equal(last.get(payCat)!.available, 0, 'nothing set aside for the card yet');
  let r = rollingTotals(c);
  assert.equal(r.total, before.total, 'overspending does not touch Ready to Assign');
  assert.equal(r.trulyFree, before.trulyFree - 3000, 'but cash overspending reduces what is truly free');

  // Cover the card overspending a month later: the money lands in the card payment category.
  db.prepare(`INSERT INTO budget_amounts (category_id, month, assigned) VALUES (?, ?, 5000)`).run(fun, M1);
  c = compute(M1, 'rolling');
  last = c.state.get(c.lastMonth)!;
  assert.equal(last.get(fun)!.available, 0);
  assert.equal(last.get(payCat)!.available, 5000, 'covering card spending funds the card payment');
  r = rollingTotals(c);
  assert.equal(r.total, before.total - 5000);

  // Partially cover the cash overspending.
  db.prepare(`INSERT INTO budget_amounts (category_id, month, assigned) VALUES (?, ?, 1000)`).run(food, M1);
  c = compute(M1, 'rolling');
  assert.equal(c.state.get(c.lastMonth)!.get(food)!.available, -2000);

  // Monthly mode on the same data still resets.
  const mm = compute(M1, 'monthly');
  assert.equal(mm.state.get(M1)!.get(food)!.available, 1000);
});

test('two-step login: RFC 6238 codes, no reuse, recovery codes work once', async () => {
  const totp = await import('../totp.ts');
  // RFC 6238 test vector: secret "12345678901234567890", T=59s -> counter 1 -> 94287082 (last 6 digits).
  assert.equal(totp.totpCode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1), '287082');

  assert.equal(totp.twoFactorEnabled(), false);
  const { secret, uri } = totp.beginSetup();
  assert.match(uri, /^otpauth:\/\/totp\//);
  const now = Math.floor(Date.now() / 30000);
  if (![now - 1, now, now + 1].some((c) => totp.totpCode(secret, c) === '000000')) {
    assert.equal(totp.confirmSetup('000000'), null, 'wrong code rejected');
  }
  const codes = totp.confirmSetup(totp.totpCode(secret, now));
  assert.ok(codes && codes.length === 10);
  assert.equal(totp.twoFactorEnabled(), true);

  // The code used to turn it on can't be replayed; the next one works once.
  assert.equal(totp.verifySecondFactor(totp.totpCode(secret, now)).ok, false);
  assert.equal(totp.verifySecondFactor(totp.totpCode(secret, now + 1)).ok, true);
  assert.equal(totp.verifySecondFactor(totp.totpCode(secret, now + 1)).ok, false);

  // Recovery codes: case/format-insensitive, single use.
  assert.deepEqual(totp.verifySecondFactor(codes![0].toUpperCase()), { ok: true, usedRecovery: true });
  assert.equal(totp.verifySecondFactor(codes![0]).ok, false);
  assert.equal(totp.recoveryCodesLeft(), 9);

  totp.disableTwoFactor();
  assert.equal(totp.twoFactorEnabled(), false);
});
