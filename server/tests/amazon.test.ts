import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mani-amazon-test-'));
process.env.DATA_DIR = dir;

const { db, setSetting } = await import('../db.ts');
const { createAccount } = await import('../accounts.ts');
const { importTransactions, saveTransaction, listTransactions } = await import('../txns.ts');
const { importAmazon, matchAmazon, amazonMemo, amazonKnown, shortTitle, newAmazonToken } = await import('../amazon.ts');
// @ts-ignore — plain JS module shared with the Chrome extension
const parse = await import('../../amazon-extension/parse.js');
const { addDays, todayISO } = await import('../../shared/util.ts');

const d = (n: number) => addDays(todayISO(), -n);
const card = createAccount({ name: 'Visa', type: 'credit_card', balance: 0 });
const checking = createAccount({ name: 'Checking', type: 'checking', balance: 0 });
const memo = (importId: string) => (db.prepare(`SELECT memo FROM transactions WHERE import_id = ?`).get(importId) as { memo: string }).memo;

test('reads charges and refunds from the Amazon payments page, row by row', () => {
  // As Amazon lays it out: date · merchant · card · order · amount · [status]
  const tokens = [
    'Your Payments', 'Transactions',
    'Nov 13, 2026', '·', 'Amazon.com', 'Prime Visa', '••••', '1234', 'Order #114-1000001-1000001', '-$21.98', 'Pending',
    'Nov 11, 2026', '·', 'Amazon.com', 'Prime Visa', '••••', '1234', 'Order #114-1000002-1000002', '-$14.60',
    'Nov 10, 2026', '·', 'Amazon.com', 'Visa', '••••', '1234', 'Refund: Order #114-1000003-1000003', '+$24.89',
    'Nov 9, 2026', '·', 'Amazon.com', 'Gift Card', '-$10.00',
    'Nov 8, 2026', '·', 'Amazon Digital', 'Prime Visa', '••••', '1234', 'Order #D01-1234567-7654321', '−$1,005.20',
  ];
  assert.deepEqual(parse.parseTransactionTokens(tokens), [
    { orderId: '114-1000002-1000002', date: '2026-11-11', amount: -1460, last4: '1234' },
    { orderId: '114-1000003-1000003', date: '2026-11-10', amount: 2489, last4: '1234' },
    { orderId: 'D01-1234567-7654321', date: '2026-11-08', amount: -100520, last4: '1234' },
  ]);
});

test('reads orders, dates and totals from the Your Orders list', () => {
  const tokens = [
    'Your Orders', '12 orders placed in', '2026',
    'Order placed', 'November 3, 2026', 'Total', '$24.89', 'Ship to', 'Someone', 'Order #', '112-1111111-1111111', 'View order details',
    'Delivered Nov 5', 'Some item title', 'Buy it again',
    'Order placed', 'October 30, 2026', 'Total', '$1,098.50', 'Order # 112-2222222-2222222',
    'ORDER PLACED November 1, 2026', 'TOTAL $5.00', 'ORDER # 113-3333333-3333333',
  ];
  assert.deepEqual(parse.parseOrderListTokens(tokens), [
    { orderId: '112-1111111-1111111', orderDate: '2026-11-03', total: 2489 },
    { orderId: '112-2222222-2222222', orderDate: '2026-10-30', total: 109850 },
    { orderId: '113-3333333-3333333', orderDate: '2026-11-01', total: 500 },
  ]);
});

test('order dates parse', () => {
  assert.equal(parse.parseOrderDate(['Order Details', 'Ordered on November 8, 2026', 'Order# 112-…']), '2026-11-08');
  assert.equal(parse.parseOrderDate(['Order placed', 'November 8, 2026']), '2026-11-08');
});

test('short item names', () => {
  assert.equal(shortTitle('Anker USB C Charger 20W, 511 Charger (Nano Pro), PIQ 3.0 Compact Fast Charger'), 'Anker USB C Charger 20W');
  assert.equal(shortTitle('Purina ONE Natural Dry Dog Food - Lamb and Rice Formula 31.1 lb. Bag'), 'Purina ONE Natural Dry Dog Food');
  assert.equal(amazonMemo(['A', 'B', 'C', 'D', 'E'], -100), 'Amazon: A · B · C +2 more');
  assert.equal(amazonMemo(['A'], 100), 'Amazon refund: A');
});

test('matches Amazon charges to bank transactions and fills in the memo', () => {
  importTransactions(card.id, [
    { importId: 'a1', date: d(3), amount: -2345, payeeName: 'AMAZON MKTPL*AB12C3' },
    { importId: 'a2', date: d(3), amount: -2345, payeeName: 'Kroger' }, // same amount, not Amazon
    { importId: 'a3', date: d(2), amount: -1500, payeeName: 'Amazon.com*XY' },
    { importId: 'a4', date: d(1), amount: -999, payeeName: 'AMZN Mktp US' },
  ]);
  const r = importAmazon({
    charges: [
      { orderId: '112-1234567-1234567', date: d(5), amount: -2345, last4: '1234' },
      { orderId: '113-1234567-1234567', date: d(4), amount: -1500 },
      { orderId: '113-1234567-1234567', date: d(2), amount: -999 },
      { orderId: '115-1234567-1234567', date: d(30), amount: -4200 }, // no bank transaction
    ],
  });
  assert.equal(r.matched, 3);
  assert.deepEqual(new Set(r.needOrders), new Set(['112-1234567-1234567', '113-1234567-1234567', '115-1234567-1234567']));
  assert.equal(memo('a1'), 'Amazon');
  assert.equal(memo('a2'), '');
  assert.equal(memo('a3'), 'Amazon (charge 1 of 2)');

  const r2 = importAmazon({
    orders: [
      { orderId: '112-1234567-1234567', orderDate: d(5), items: ['Anker USB C Charger 20W, 511 Charger', 'Dog Food - Lamb'] },
      { orderId: '113-1234567-1234567', items: ['Paper Towels, 12 rolls'] },
    ],
  });
  assert.deepEqual(r2.needOrders, ['115-1234567-1234567']);
  assert.equal(memo('a1'), 'Amazon: Anker USB C Charger 20W · Dog Food');
  assert.equal(memo('a3'), 'Amazon (charge 1 of 2): Paper Towels');
  assert.equal(memo('a4'), 'Amazon (charge 2 of 2): Paper Towels');

  const t = listTransactions({ accountId: card.id }).find((x) => x.importId === 'a1')!;
  assert.equal(t.amazon?.orderId, '112-1234567-1234567');
  assert.equal(t.amazon?.items.length, 2);
});

test('a memo you typed is never overwritten', () => {
  importTransactions(card.id, [{ importId: 'a5', date: d(1), amount: -777, payeeName: 'Amazon' }]);
  const id = (db.prepare(`SELECT id FROM transactions WHERE import_id = 'a5'`).get() as { id: number }).id;
  db.prepare(`UPDATE transactions SET memo = 'birthday present' WHERE id = ?`).run(id);
  importAmazon({ charges: [{ orderId: '116-1234567-1234567', date: d(1), amount: -777 }], orders: [{ orderId: '116-1234567-1234567', items: ['Lego'] }] });
  assert.equal(memo('a5'), 'birthday present');
});

test('ambiguous: two Amazon charges of the same amount on the same day are left alone unless the card tells them apart', () => {
  db.prepare(`INSERT INTO connections (id, provider, institution, secret_enc) VALUES (99, 'plaid', 'X', 'x')`).run();
  db.prepare(`INSERT INTO external_accounts (connection_id, external_id, name, mask) VALUES (99, 'e1', 'Checking', '4444')`).run();
  db.prepare(`UPDATE accounts SET connection_id = 99, external_id = 'e1' WHERE id = ?`).run(checking.id);
  importTransactions(card.id, [{ importId: 'b1', date: d(2), amount: -1234, payeeName: 'Amazon' }]);
  importTransactions(checking.id, [{ importId: 'b2', date: d(2), amount: -1234, payeeName: 'Amazon' }]);
  importAmazon({ charges: [{ orderId: '117-1234567-1234567', date: d(2), amount: -1234 }] });
  assert.equal(memo('b1'), '');
  assert.equal(memo('b2'), '');
  importAmazon({ charges: [{ orderId: '118-1234567-1234567', date: d(2), amount: -1234, last4: '4444' }] });
  assert.equal(memo('b2'), 'Amazon');
});

test('orders without an exact charge are matched by their total, with a wider date window', () => {
  importTransactions(card.id, [
    { importId: 'e1', date: d(20), amount: -2489, payeeName: 'AMAZON MKTPL' },
    { importId: 'e2', date: d(18), amount: -9850, payeeName: 'Amazon' },
    { importId: 'e3', date: d(13), amount: -9850, payeeName: 'Amazon' },
  ]);
  const r = importAmazon({
    orders: [
      { orderId: '120-0000000-0000001', orderDate: d(26), total: 2489, items: [] },
      { orderId: '120-0000000-0000002', orderDate: d(20), total: 9850, items: [] },
      { orderId: '120-0000000-0000003', orderDate: d(14), total: 9850, items: [] },
    ],
  });
  assert.ok(r.matched >= 3); // (also picks up a charge left ambiguous by an earlier test, now that its rival is matched)
  importAmazon({ orders: [{ orderId: '120-0000000-0000001', items: ['Lift Supports'] }] });
  assert.equal(memo('e1'), 'Amazon: Lift Supports');
  const linked = (id: string) => (db.prepare(`SELECT order_id FROM amazon_charges WHERE txn_id = (SELECT id FROM transactions WHERE import_id = ?)`).get(id) as { order_id: string }).order_id;
  assert.equal(linked('e2'), '120-0000000-0000002');
  assert.equal(linked('e3'), '120-0000000-0000003');
});

test('an exact charge from Amazon replaces the one worked out from the total', () => {
  importAmazon({ charges: [{ orderId: '120-0000000-0000001', date: d(21), amount: -2489, last4: '1234' }] });
  const rows = db.prepare(`SELECT estimated, txn_id FROM amazon_charges WHERE order_id = '120-0000000-0000001'`).all() as { estimated: number; txn_id: number }[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].estimated, 0);
  assert.ok(rows[0].txn_id);
  // Shipped in two parts: two exact charges that differ from the total replace the estimate (and its memo).
  importAmazon({ charges: [{ orderId: '120-0000000-0000002', date: d(19), amount: -5000 }, { orderId: '120-0000000-0000002', date: d(17), amount: -4850 }] });
  assert.equal(memo('e2'), '');
  assert.equal((db.prepare(`SELECT COUNT(*) n FROM amazon_charges WHERE order_id = '120-0000000-0000002' AND estimated = 1`).get() as { n: number }).n, 0);
});

test('tells the extension what it already has, and asks for a full re-read weekly', () => {
  const k = amazonKnown();
  assert.equal(k.fullScan, true); // never done one yet
  // Orders count as known once their total has been read from the order list; exact charges by order, date and amount.
  assert.ok(k.orders.includes('120-0000000-0000003'));
  assert.ok(!k.orders.includes('112-1234567-1234567')); // only seen via a charge: its order-list entry is still wanted
  assert.ok(k.charges.includes(`120-0000000-0000001|${d(21)}|-2489`));
  assert.ok(!k.charges.some((c: string) => c.startsWith('120-0000000-0000003|'))); // worked out from a total, not exact
  setSetting('amazon_last_full_scan', new Date(Date.now() - 2 * 86400000).toISOString());
  assert.equal(amazonKnown().fullScan, false);
  setSetting('amazon_last_full_scan', new Date(Date.now() - 8 * 86400000).toISOString());
  assert.equal(amazonKnown().fullScan, true);
});

test('bad input is ignored, not stored', () => {
  const r = importAmazon({ charges: [{ orderId: 'nope', date: d(1), amount: -1 }, { orderId: '112-1234567-1234567', date: 'x', amount: -1 }], orders: [{ orderId: 'bad' }] });
  assert.equal(r.charges, 0);
  assert.equal(r.orders, 0);
});

test('tokens are random and only the hash is stored', () => {
  const t1 = newAmazonToken();
  const t2 = newAmazonToken();
  assert.notEqual(t1, t2);
  assert.match(t1, /^mani_amz_/);
  const stored = (db.prepare(`SELECT value FROM settings WHERE key = 'amazon_token_hash'`).get() as { value: string }).value;
  assert.ok(!stored.includes(t2.slice(9)));
  void matchAmazon;
  void saveTransaction;
});
