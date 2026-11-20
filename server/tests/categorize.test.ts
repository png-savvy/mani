import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mani-categorize-test-'));
process.env.DATA_DIR = dir;

const { db } = await import('../db.ts');
const { createAccount } = await import('../accounts.ts');
const { importTransactions } = await import('../txns.ts');
const { categorizeTransaction, needsCategory, undoCategorize } = await import('../categorize.ts');
const { currentMonth, todayISO } = await import('../../shared/util.ts');

const checking = createAccount({ name: 'Checking', type: 'checking', balance: 100000 });
const tracking = createAccount({ name: 'House', type: 'asset', balance: 0 });
const group = Number(db.prepare(`INSERT INTO category_groups (name, sort) VALUES ('Test', 50)`).run().lastInsertRowid);
const cat = (name: string) => Number(db.prepare(`INSERT INTO categories (group_id, name, sort) VALUES (?, ?, 0)`).run(group, name).lastInsertRowid);
const groceries = cat('Groceries T');
const misc = cat('Misc T');
db.prepare(`INSERT INTO budget_amounts (category_id, month, assigned) VALUES (?, ?, 20000), (?, ?, 5000)`).run(groceries, currentMonth(), misc, currentMonth());

importTransactions(checking.id, [{ importId: 'k1', date: todayISO(), amount: -1460, payeeName: 'Kroger' }]);
const txn = () => db.prepare(`SELECT id, category_id, approved, payee_id FROM transactions WHERE import_id = 'k1'`).get() as { id: number; category_id: number | null; approved: number; payee_id: number };
const remembered = () => (db.prepare(`SELECT last_category_id FROM payees WHERE id = ?`).get(txn().payee_id) as { last_category_id: number | null }).last_category_id;

test('categorizing reports the balance before and after, and approves', () => {
  const r = categorizeTransaction(txn().id, groceries);
  assert.deepEqual(r.to, { id: groceries, name: 'Groceries T', before: 20000, after: 18540 });
  assert.equal(r.from, null);
  assert.equal(txn().category_id, groceries);
  assert.equal(txn().approved, 1);
  assert.equal(remembered(), groceries);
  assert.deepEqual(r.undo, { categoryId: null, approved: false, payeeLastCategoryId: null });
});

test('moving to another category reports both, and undo puts everything back', () => {
  const r = categorizeTransaction(txn().id, misc);
  assert.deepEqual(r.to, { id: misc, name: 'Misc T', before: 5000, after: 3540 });
  assert.deepEqual(r.from, { id: groceries, name: 'Groceries T', before: 18540, after: 20000 });
  assert.equal(remembered(), misc);
  undoCategorize(txn().id, r.undo);
  assert.equal(txn().category_id, groceries);
  assert.equal(txn().approved, 1);
  assert.equal(remembered(), groceries);
});

test('undoing the first categorization returns it to unreviewed and forgets the payee category', () => {
  undoCategorize(txn().id, { categoryId: null, approved: false, payeeLastCategoryId: null });
  assert.equal(txn().category_id, null);
  assert.equal(txn().approved, 0);
  assert.equal(remembered(), null);
});

test('taking the category off sends it back to review, and undo restores it', () => {
  categorizeTransaction(txn().id, groceries);
  const r = categorizeTransaction(txn().id, null);
  assert.equal(r.to, null);
  assert.deepEqual(r.from, { id: groceries, name: 'Groceries T', before: 18540, after: 20000 });
  assert.equal(txn().category_id, null);
  assert.equal(txn().approved, 1); // approval is left alone; "needs a category" is what puts it in the review list
  assert.equal(remembered(), groceries); // the payee's remembered category is untouched
  undoCategorize(txn().id, r.undo);
  assert.equal(txn().category_id, groceries);
});

test('refuses what cannot take a category', () => {
  importTransactions(tracking.id, [{ importId: 'h1', date: todayISO(), amount: -500, payeeName: 'Repair' }]);
  const h = db.prepare(`SELECT id FROM transactions WHERE import_id = 'h1'`).get() as { id: number };
  assert.throws(() => categorizeTransaction(h.id, groceries), /tracking/);
  const cc = db.prepare(`SELECT id FROM categories WHERE kind = 'cc_payment' LIMIT 1`).get() as { id: number } | undefined;
  if (cc) assert.throws(() => categorizeTransaction(txn().id, cc.id), /Invalid category/);
  assert.throws(() => categorizeTransaction(999999, groceries), /not found/);
  assert.throws(() => undoCategorize(txn().id, { categoryId: 999999, approved: false }), /no longer exists/);
});

test('only on-budget spending without a category is held back from approving', () => {
  importTransactions(checking.id, [{ importId: 'n1', date: todayISO(), amount: -500, payeeName: 'Corner Shop' }]);
  importTransactions(tracking.id, [{ importId: 'n2', date: todayISO(), amount: -500, payeeName: 'Repair' }]);
  const id = (importId: string) => (db.prepare(`SELECT id FROM transactions WHERE import_id = ?`).get(importId) as { id: number }).id;
  assert.equal(needsCategory(id('n1')), true);
  assert.equal(needsCategory(id('n2')), false); // tracking accounts have no categories
  categorizeTransaction(id('n1'), misc);
  assert.equal(needsCategory(id('n1')), false);
});

test('approving in the category it already has leaves the balance alone, and undo un-approves it', () => {
  importTransactions(checking.id, [{ importId: 'a1', date: todayISO(), amount: -700, payeeName: 'Kroger' }]);
  const t = () => db.prepare(`SELECT id, category_id, approved FROM transactions WHERE import_id = 'a1'`).get() as { id: number; category_id: number | null; approved: number };
  assert.equal(t().category_id, groceries); // pre-filled from the payee
  assert.equal(t().approved, 0);
  const r = categorizeTransaction(t().id, groceries);
  assert.equal(r.to!.before, r.to!.after);
  assert.equal(r.from, null);
  assert.equal(t().approved, 1);
  undoCategorize(t().id, r.undo);
  assert.equal(t().approved, 0);
  assert.equal(t().category_id, groceries);
});
