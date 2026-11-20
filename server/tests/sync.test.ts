import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolated database for this test run; Plaid is replaced by a scripted fake.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mani-sync-test-'));
process.env.DATA_DIR = dir;
process.env.PLAID_CLIENT_ID = 'test';
process.env.PLAID_SECRET = 'test';

const { db } = await import('../db.ts');
const { encrypt } = await import('../security.ts');
const { createAccount } = await import('../accounts.ts');
const { syncConnection, connectionsToRetrySoon } = await import('../banks.ts');
const { accountBalances, saveTransaction } = await import('../txns.ts');
const { addDays, todayISO } = await import('../../shared/util.ts');

const today = todayISO();
const connId = Number(
  db.prepare(`INSERT INTO connections (provider, institution, item_id, secret_enc, cursor) VALUES ('plaid', 'Test Bank', 'item1', ?, 'c0')`).run(encrypt('access-token'))
    .lastInsertRowid,
);
db.prepare(`INSERT INTO external_accounts (connection_id, external_id, name) VALUES (?, 'ext1', 'Card')`).run(connId);
const acct = createAccount({ name: 'Card', type: 'checking', balance: 0, connectionId: connId, externalId: 'ext1', importStart: addDays(today, -60) });

type Page = { added?: any[]; modified?: any[]; removed?: any[]; has_more?: boolean; next_cursor: string; transactions_update_status?: string };
let script: (Page | { status: number; body: any } | Error)[] = [];
const cursorsSeen: (string | undefined)[] = [];
globalThis.fetch = (async (url: string, init: any) => {
  if (String(url).endsWith('/accounts/get')) return new Response(JSON.stringify({ accounts: [] }));
  cursorsSeen.push(JSON.parse(init.body).cursor);
  const next = script.shift();
  if (!next) throw new Error('unexpected Plaid call');
  if (next instanceof Error) throw next;
  if ('status' in next) return new Response(JSON.stringify(next.body), { status: next.status });
  return new Response(JSON.stringify({ added: [], modified: [], removed: [], has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE', ...next }));
}) as any;

const txn = (id: string, amount: number, extra: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: 'ext1',
  date: addDays(today, -2),
  amount,
  name: 'Shop ' + id,
  pending: false,
  ...extra,
});
const imported = () => (db.prepare(`SELECT import_id FROM transactions WHERE import_id IS NOT NULL ORDER BY import_id`).all() as { import_id: string }[]).map((r) => r.import_id);
const cursor = () => (db.prepare(`SELECT cursor FROM connections WHERE id = ?`).get(connId) as { cursor: string | null }).cursor;

test('imports every posted transaction across pages and skips pending ones', async () => {
  script = [
    { added: [txn('a', 10), txn('p', 5, { pending: true })], has_more: true, next_cursor: 'c1' },
    { added: [txn('b', 20)], next_cursor: 'c2' },
  ];
  const r = await syncConnection(connId);
  assert.equal(r.imported, 2);
  assert.deepEqual(imported(), ['plaid:a', 'plaid:b']);
  assert.equal(cursor(), 'c2');
});

test('a "modified" transaction we never had is imported, not dropped', async () => {
  script = [{ modified: [txn('m', 7), txn('a', 11)], next_cursor: 'c3' }];
  await syncConnection(connId);
  assert.deepEqual(imported(), ['plaid:a', 'plaid:b', 'plaid:m']);
  const a = db.prepare(`SELECT amount FROM transactions WHERE import_id = 'plaid:a'`).get() as { amount: number };
  assert.equal(a.amount, -1100);
});

test('re-reading the same data never duplicates', async () => {
  script = [{ added: [txn('a', 11), txn('b', 20), txn('m', 7)], next_cursor: 'c4' }];
  const r = await syncConnection(connId);
  assert.equal(r.imported, 0);
  assert.equal(imported().length, 3);
});

test('rides out a Plaid outage mid-sync without losing the page', async () => {
  script = [{ status: 500, body: { error_code: 'INTERNAL_SERVER_ERROR' } }, new Error('socket hang up'), { added: [txn('c', 3)], next_cursor: 'c5' }];
  const r = await syncConnection(connId);
  assert.equal(r.imported, 1);
  assert.equal(cursor(), 'c5');
});

test('a failed sync keeps the old cursor and is queued for an early retry', async () => {
  script = [{ status: 400, body: { error_code: 'INSTITUTION_DOWN', error_message: 'bank is down' } }];
  await assert.rejects(syncConnection(connId));
  assert.equal(cursor(), 'c5');
  assert.deepEqual(connectionsToRetrySoon(), [connId]);
  script = [{ added: [txn('d', 4)], next_cursor: 'c6' }];
  await syncConnection(connId);
  assert.deepEqual(connectionsToRetrySoon(), []);
  assert.ok(imported().includes('plaid:d'));
});

test('needing a new sign-in is flagged, not retried in a loop', async () => {
  script = [{ status: 400, body: { error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' } }];
  await assert.rejects(syncConnection(connId));
  assert.deepEqual(connectionsToRetrySoon(), []);
  assert.equal((db.prepare(`SELECT status FROM connections WHERE id = ?`).get(connId) as { status: string }).status, 'reauth');
});

test('a cursor Plaid rejects restarts from the beginning', async () => {
  cursorsSeen.length = 0;
  script = [
    { status: 400, body: { error_code: 'INVALID_FIELD', error_message: 'cursor not associated with access_token' } },
    { added: [txn('a', 11), txn('e', 9)], next_cursor: 'c7' },
  ];
  const r = await syncConnection(connId);
  assert.deepEqual(cursorsSeen, ['c6', undefined]);
  assert.equal(r.imported, 1);
  assert.equal(cursor(), 'c7');
});

test('unfinished bank history is checked again soon', async () => {
  script = [{ next_cursor: 'c8', transactions_update_status: 'INITIAL_UPDATE_COMPLETE' }];
  await syncConnection(connId);
  assert.deepEqual(connectionsToRetrySoon(), [connId]);
  script = [{ next_cursor: 'c9' }];
  await syncConnection(connId);
  assert.deepEqual(connectionsToRetrySoon(), []);
});

test('review count is unapproved plus uncategorized, counted once each', () => {
  const review = () => accountBalances().find((b) => b.id === acct.id)!.review;
  const n = imported().length; // all imported are unapproved (and uncategorized): each counts once
  assert.equal(review(), n);
  // An approved manual transaction with no category also needs review.
  saveTransaction({ accountId: acct.id, date: today, amount: -500, payeeName: 'Cash', categoryId: null, memo: '', cleared: 'cleared', approved: true } as any);
  assert.equal(review(), n + 1);
  db.prepare(`UPDATE transactions SET approved = 1 WHERE import_id IS NOT NULL`).run();
  assert.equal(review(), n + 1); // still uncategorized
  const cat = (db.prepare(`SELECT id FROM categories WHERE kind NOT IN ('cc_payment','income') LIMIT 1`).get() as { id: number }).id;
  db.prepare(`UPDATE transactions SET category_id = ? WHERE account_id = ?`).run(cat, acct.id);
  assert.equal(review(), 0);
});
