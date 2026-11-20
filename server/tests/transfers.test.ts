import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mani-transfer-test-'));
process.env.DATA_DIR = dir;

const { db } = await import('../db.ts');
const { createAccount } = await import('../accounts.ts');
const { importTransactions, saveTransaction, deleteTransaction, separateTransfer } = await import('../txns.ts');
const { newTransactionsMessage } = await import('../push.ts');
const { addDays, todayISO } = await import('../../shared/util.ts');

const d = (n: number) => addDays(todayISO(), -n);
const checking = createAccount({ name: 'Checking', type: 'checking', balance: 0 });
const savings = createAccount({ name: 'Savings', type: 'savings', balance: 0 });
const card = createAccount({ name: 'Visa', type: 'credit_card', balance: 0 });
const brokerage = createAccount({ name: 'Brokerage', type: 'asset', balance: 0 });

type Row = { id: number; account_id: number; amount: number; transfer_account_id: number | null; transfer_txn_id: number | null; category_id: number | null; payee_id: number | null; approved: number };
const byImport = (id: string) => db.prepare(`SELECT * FROM transactions WHERE import_id = ?`).get(id) as Row;
const imp = (acct: number, id: string, date: string, amount: number, payeeName: string) =>
  importTransactions(acct, [{ importId: id, date, amount, payeeName }]);

test('joins the two halves of a transfer between your accounts', () => {
  imp(checking.id, 'c1', d(3), -50000, 'ONLINE TRANSFER TO SAV ...4821');
  assert.equal(byImport('c1').transfer_account_id, null); // other half not here yet
  imp(savings.id, 's1', d(2), 50000, 'Transfer from Checking');
  const a = byImport('c1');
  const b = byImport('s1');
  assert.equal(a.transfer_account_id, savings.id);
  assert.equal(b.transfer_account_id, checking.id);
  assert.equal(a.transfer_txn_id, b.id);
  assert.equal(b.transfer_txn_id, a.id);
  assert.equal(a.category_id, null);
  assert.equal(a.payee_id, null);
  assert.equal(a.approved, 0); // still shown for review
});

test('a credit card payment becomes a transfer to the card', () => {
  imp(card.id, 'v1', d(5), 120000, 'PAYMENT THANK YOU');
  imp(checking.id, 'c2', d(6), -120000, 'CHASE CREDIT CRD AUTOPAY');
  assert.equal(byImport('c2').transfer_account_id, card.id);
});

test('unrelated equal amounts with no transfer wording are left alone', () => {
  imp(checking.id, 'c3', d(4), -4000, 'Target');
  imp(card.id, 'v3', d(3), 4000, 'Amazon refund');
  assert.equal(byImport('c3').transfer_account_id, null);
  assert.equal(byImport('v3').transfer_account_id, null);
});

test('ambiguous matches (two possible partners) are left alone', () => {
  imp(savings.id, 's4', d(2), 10000, 'Transfer');
  imp(card.id, 'v4', d(1), 10000, 'Payment');
  imp(checking.id, 'c4', d(2), -10000, 'Transfer to savings');
  assert.equal(byImport('c4').transfer_account_id, null);
});

test('halves too far apart in date are not joined', () => {
  imp(checking.id, 'c5', d(20), -7700, 'Transfer to savings');
  imp(savings.id, 's5', d(10), 7700, 'Transfer from checking');
  assert.equal(byImport('c5').transfer_account_id, null);
});

test('transfer to a tracking account keeps the budget side needing a category', () => {
  imp(checking.id, 'c6', d(1), -25000, 'Transfer to brokerage');
  imp(brokerage.id, 'b6', d(1), 25000, 'Deposit from checking');
  assert.equal(byImport('c6').transfer_account_id, brokerage.id);
});

test('"Not a transfer" separates them back into two bank transactions, for good', () => {
  const a = byImport('c1');
  separateTransfer(a.id);
  const x = byImport('c1');
  const y = byImport('s1');
  assert.equal(x.transfer_account_id, null);
  assert.equal(y.transfer_account_id, null);
  assert.ok(x.payee_id && y.payee_id);
  // Another import run must not re-join them.
  imp(savings.id, 's-other', d(30), 1, 'x');
  assert.equal(byImport('c1').transfer_account_id, null);
});

test('editing a detected transfer into a purchase keeps the bank\'s other half', () => {
  const a = byImport('c2');
  saveTransaction({ accountId: checking.id, date: d(6), amount: -120000, payeeName: 'Rent', categoryId: null, approved: true }, a.id);
  const v = byImport('v1');
  assert.ok(v, 'card side still exists');
  assert.equal(v.transfer_account_id, null);
  assert.equal(v.approved, 0);
});

test('deleting one half of a detected transfer keeps the bank\'s other half', () => {
  deleteTransaction(byImport('c6').id);
  assert.ok(byImport('b6'));
  assert.equal(byImport('b6').transfer_account_id, null);
});

test('entering a transfer by hand uses the other bank\'s existing half instead of duplicating it', () => {
  imp(savings.id, 's7', d(1), 3300, 'Deposit');
  imp(checking.id, 'c7', d(1), -3300, 'Withdrawal'); // no transfer wording, so not auto-joined
  assert.equal(byImport('c7').transfer_account_id, null);
  const before = (db.prepare(`SELECT COUNT(*) n FROM transactions WHERE account_id = ?`).get(savings.id) as { n: number }).n;
  saveTransaction({ accountId: checking.id, date: d(1), amount: -3300, transferAccountId: savings.id, approved: true }, byImport('c7').id);
  const after = (db.prepare(`SELECT COUNT(*) n FROM transactions WHERE account_id = ?`).get(savings.id) as { n: number }).n;
  assert.equal(after, before);
  assert.equal(byImport('s7').transfer_txn_id, byImport('c7').id);
});

test('notification text lists new transactions and what needs a category', () => {
  const r1 = imp(checking.id, 'n1', d(0), -540, 'STARBUCKS #1234');
  const one = newTransactionsMessage(r1.newIds)!;
  assert.equal(one.title, 'New transaction');
  assert.match(one.body, /Starbucks #1234 -\$5\.40 · needs a category/);
  assert.equal(one.url, '/review');
  const r2 = importTransactions(checking.id, [
    { importId: 'n2', date: d(0), amount: -1000, payeeName: 'Shell' },
    { importId: 'n3', date: d(0), amount: -2000, payeeName: 'Kroger' },
  ]);
  const many = newTransactionsMessage(r2.newIds)!;
  assert.equal(many.title, '2 new transactions · 2 to categorize');
  assert.equal(newTransactionsMessage([]), null);
});
