import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { db, getSetting, setSetting } from './db.ts';
import { HttpError } from './txns.ts';
import { addDays, isValidISODate } from '../shared/util.ts';

// =====================================================================================
// Amazon order details
//
// Banks report Amazon purchases as just "Amazon". The Mani Amazon extension (amazon-extension/) runs in your own Chrome,
// where you're signed in to Amazon, reads your Amazon payment history and order details, and sends them here. Each
// Amazon charge is matched to the bank transaction with the same amount and a close date, and the transaction's memo
// is filled in with what you bought.
// =====================================================================================

export interface AmazonCharge {
  orderId: string;
  date: string; // YYYY-MM-DD, the day Amazon charged the card
  amount: number; // cents; negative = charge, positive = refund (same sign convention as bank transactions)
  last4?: string | null; // last 4 digits of the card charged, when Amazon shows it
}

export interface AmazonOrder {
  orderId: string;
  orderDate?: string | null;
  /** Order total in cents (positive), from Amazon's order list. */
  total?: number | null;
  items: string[];
}

const ORDER_ID = /^[A-Z0-9]{3}-\d{7}-\d{7}$/;
/** How far the bank's posting date may be from the day Amazon charged the card. */
const DATE_BEFORE = 3;
const DATE_AFTER = 7;
/** For a charge worked out from an order total: Amazon charges when it ships, which can be a week or more after ordering. */
const EST_DATE_BEFORE = 1;
const EST_DATE_AFTER = 14;

// ---------------------------------------------------------------- extension token

const hash = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** Creates a new extension token (replacing any old one). The token itself is shown once; only its hash is kept. */
export function newAmazonToken(): string {
  const token = 'mani_amz_' + crypto.randomBytes(24).toString('base64url');
  setSetting('amazon_token_hash', hash(token));
  return token;
}

export function revokeAmazonToken() {
  setSetting('amazon_token_hash', '');
}

function tokenOk(req: Request): boolean {
  const want = getSetting('amazon_token_hash');
  const m = /^Bearer\s+(\S+)$/.exec(req.get('authorization') || '');
  if (!want || !m) return false;
  const a = Buffer.from(hash(m[1]), 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------------------------------------------------------------- storing what the extension sends

function cleanCharge(c: any): AmazonCharge | null {
  const orderId = String(c?.orderId ?? '').trim().toUpperCase();
  const date = String(c?.date ?? '');
  const amount = Number(c?.amount);
  const last4 = c?.last4 && /^\d{4}$/.test(String(c.last4)) ? String(c.last4) : null;
  if (!ORDER_ID.test(orderId) || !isValidISODate(date) || !Number.isInteger(amount) || amount === 0) return null;
  return { orderId, date, amount, last4 };
}

function cleanOrder(o: any): AmazonOrder | null {
  const orderId = String(o?.orderId ?? '').trim().toUpperCase();
  if (!ORDER_ID.test(orderId)) return null;
  const items = (Array.isArray(o?.items) ? o.items : [])
    .map((s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300))
    .filter((s: string) => s.length > 1)
    .slice(0, 50);
  const orderDate = o?.orderDate && isValidISODate(String(o.orderDate)) ? String(o.orderDate) : null;
  const total = Number.isInteger(o?.total) && o.total > 0 ? Number(o.total) : null;
  return { orderId, orderDate, total, items: [...new Set<string>(items)] };
}

/** Saves charges and/or order details from the extension, matches what it can, and says which orders still need details. */
export const importAmazon = db.transaction((body: { charges?: unknown[]; orders?: unknown[] }) => {
  const charges = (Array.isArray(body.charges) ? body.charges : []).slice(0, 5000).map(cleanCharge).filter(Boolean) as AmazonCharge[];
  const orders = (Array.isArray(body.orders) ? body.orders : []).slice(0, 1000).map(cleanOrder).filter(Boolean) as AmazonOrder[];

  const insCharge = db.prepare(
    `INSERT INTO amazon_charges (order_id, date, amount, last4) VALUES (?, ?, ?, ?)
     ON CONFLICT(order_id, date, amount) DO UPDATE SET last4 = COALESCE(excluded.last4, amazon_charges.last4), estimated = 0`,
  );
  for (const c of charges) {
    // An exact charge replaces one worked out from the order total.
    const est = db.prepare(`SELECT * FROM amazon_charges WHERE order_id = ? AND estimated = 1`).all(c.orderId) as ChargeRow[];
    const same = est.find((e) => e.amount === c.amount);
    if (same) {
      db.prepare(`UPDATE amazon_charges SET date = ?, last4 = ?, estimated = 0 WHERE id = ?`).run(c.date, c.last4 ?? null, same.id);
      continue;
    }
    for (const e of est) dropCharge(e);
    insCharge.run(c.orderId, c.date, c.amount, c.last4 ?? null);
  }

  const upOrder = db.prepare(
    `INSERT INTO amazon_orders (order_id, order_date, total, items, fetched_at) VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(order_id) DO UPDATE SET order_date = COALESCE(excluded.order_date, amazon_orders.order_date),
       total = COALESCE(excluded.total, amazon_orders.total),
       items = CASE WHEN excluded.items != '[]' THEN excluded.items ELSE amazon_orders.items END, fetched_at = excluded.fetched_at`,
  );
  for (const o of orders) upOrder.run(o.orderId, o.orderDate ?? null, o.total ?? null, JSON.stringify(o.items));

  // Orders with no exact charge from Amazon: assume one charge of the order total. (Orders that ship in several parts
  // are charged in several amounts; those simply won't find a match.)
  db.prepare(
    `INSERT INTO amazon_charges (order_id, date, amount, estimated)
     SELECT o.order_id, o.order_date, -o.total, 1 FROM amazon_orders o
     WHERE o.total > 0 AND o.order_date IS NOT NULL AND NOT EXISTS (SELECT 1 FROM amazon_charges c WHERE c.order_id = o.order_id)`,
  ).run();

  const matched = matchAmazon();
  setSetting('amazon_last_import', new Date().toISOString());

  // Orders we have charges for but no item list yet (recent ones first) — the extension fetches these next.
  const needOrders = (
    db
      .prepare(
        `SELECT DISTINCT c.order_id FROM amazon_charges c LEFT JOIN amazon_orders o ON o.order_id = c.order_id
         WHERE o.order_id IS NULL OR o.items = '[]' ORDER BY c.date DESC LIMIT 60`,
      )
      .all() as { order_id: string }[]
  ).map((r) => r.order_id);
  return { charges: charges.length, orders: orders.length, matched, needOrders };
});

/** How often the extension should re-read the whole look-back period instead of stopping at what Mani already has. */
const FULL_SCAN_EVERY_DAYS = 7;

/**
 * What Mani already has, so the extension can stop paging through Amazon once it reaches familiar ground (fewer page
 * loads). `fullScan` asks it to read everything anyway, as a periodic safety net for anything that showed up late or
 * out of order.
 */
export function amazonKnown() {
  const since = addDays(new Date().toISOString().slice(0, 10), -400);
  const orders = (
    db.prepare(`SELECT order_id FROM amazon_orders WHERE total IS NOT NULL AND (order_date IS NULL OR order_date >= ?)`).all(since) as { order_id: string }[]
  ).map((r) => r.order_id);
  const charges = (
    db.prepare(`SELECT order_id, date, amount FROM amazon_charges WHERE estimated = 0 AND date >= ?`).all(since) as { order_id: string; date: string; amount: number }[]
  ).map((c) => `${c.order_id}|${c.date}|${c.amount}`);
  const last = Date.parse(getSetting('amazon_last_full_scan') || '');
  const fullScan = !Number.isFinite(last) || Date.now() - last > FULL_SCAN_EVERY_DAYS * 86400000;
  return { orders, charges, fullScan };
}

// ---------------------------------------------------------------- matching to bank transactions

/** Short, readable item names: Amazon titles run long ("Anker USB C Charger 20W, 511 Charger (Nano Pro), PIQ 3.0…"). */
export function shortTitle(title: string): string {
  let s = title.split(/\s[|–—-]\s|,\s|\s\(/)[0].trim();
  if (s.length > 48) s = s.slice(0, 47).replace(/\s+\S*$/, '') + '…';
  return s || title.slice(0, 48);
}

export function amazonMemo(items: string[], amount: number, part?: { n: number; of: number }): string {
  const head = amount > 0 ? 'Amazon refund' : 'Amazon';
  const partNote = part && part.of > 1 ? ` (charge ${part.n} of ${part.of})` : '';
  if (!items.length) return `${head}${partNote}`;
  const names = items.map(shortTitle);
  let text = names.slice(0, 3).join(' · ');
  if (names.length > 3) text += ` +${names.length - 3} more`;
  return `${head}${partNote}: ${text}`.slice(0, 500);
}

/** A memo Mani wrote itself (so it may be refreshed); anything you typed is never overwritten. */
const AUTO_MEMO = /^Amazon( refund)?( \(charge \d+ of \d+\))?(: .*)?$/;

interface ChargeRow {
  id: number;
  order_id: string;
  date: string;
  amount: number;
  last4: string | null;
  txn_id: number | null;
  estimated: number;
}

/** Forgets a charge, clearing the memo Mani wrote on its bank transaction (a memo you typed stays). */
function dropCharge(c: ChargeRow) {
  if (c.txn_id) {
    const t = db.prepare(`SELECT memo FROM transactions WHERE id = ?`).get(c.txn_id) as { memo: string } | undefined;
    if (t && AUTO_MEMO.test(t.memo)) db.prepare(`UPDATE transactions SET memo = '' WHERE id = ?`).run(c.txn_id);
  }
  db.prepare(`DELETE FROM amazon_charges WHERE id = ?`).run(c.id);
}

/** Links unmatched Amazon charges to bank transactions and (re)writes memos. Returns how many charges were newly matched. */
export function matchAmazon(): number {
  const pending = db.prepare(`SELECT * FROM amazon_charges WHERE txn_id IS NULL ORDER BY date, id`).all() as ChargeRow[];
  const findTxns = db.prepare(
    `SELECT t.id, t.date, e.mask FROM transactions t
     JOIN accounts a ON a.id = t.account_id
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN external_accounts e ON e.connection_id = a.connection_id AND e.external_id = a.external_id
     WHERE t.amount = ? AND t.date BETWEEN ? AND ? AND t.transfer_account_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM amazon_charges x WHERE x.txn_id = t.id)
       AND (lower(COALESCE(t.imported_payee, '') || ' ' || COALESCE(p.name, '')) LIKE '%amazon%'
         OR lower(COALESCE(t.imported_payee, '') || ' ' || COALESCE(p.name, '')) LIKE '%amzn%')`,
  );
  const link = db.prepare(`UPDATE amazon_charges SET txn_id = ? WHERE id = ?`);
  let matched = 0;
  for (const c of pending) {
    const [before, after] = c.estimated ? [EST_DATE_BEFORE, EST_DATE_AFTER] : [DATE_BEFORE, DATE_AFTER];
    let cands = findTxns.all(c.amount, addDays(c.date, -before), addDays(c.date, after)) as { id: number; date: string; mask: string | null }[];
    // Several Amazon transactions of the same amount: prefer the card Amazon says it charged, then the closest date.
    if (cands.length > 1 && c.last4) {
      const sameCard = cands.filter((t) => t.mask === c.last4);
      if (sameCard.length) cands = sameCard;
    }
    if (cands.length > 1) {
      const dist = (t: { date: string }) => Math.abs(Date.parse(t.date) - Date.parse(c.date));
      cands.sort((x, y) => dist(x) - dist(y));
      if (dist(cands[0]) === dist(cands[1])) continue; // genuinely ambiguous: leave it
      cands = [cands[0]];
    }
    if (cands.length !== 1) continue;
    link.run(cands[0].id, c.id);
    matched++;
  }
  refreshAmazonMemos();
  return matched;
}

function refreshAmazonMemos() {
  const rows = db
    .prepare(
      `SELECT c.txn_id, c.order_id, c.amount, t.memo, o.items,
         (SELECT COUNT(*) FROM amazon_charges c2 WHERE c2.order_id = c.order_id AND (c2.amount < 0) = (c.amount < 0)) AS parts,
         (SELECT COUNT(*) FROM amazon_charges c3 WHERE c3.order_id = c.order_id AND (c3.amount < 0) = (c.amount < 0)
            AND (c3.date < c.date OR (c3.date = c.date AND c3.id <= c.id))) AS part
       FROM amazon_charges c JOIN transactions t ON t.id = c.txn_id LEFT JOIN amazon_orders o ON o.order_id = c.order_id`,
    )
    .all() as { txn_id: number; order_id: string; amount: number; memo: string; items: string | null; parts: number; part: number }[];
  const up = db.prepare(`UPDATE transactions SET memo = ? WHERE id = ?`);
  for (const r of rows) {
    if (r.memo && !AUTO_MEMO.test(r.memo)) continue;
    const memo = amazonMemo(JSON.parse(r.items || '[]'), r.amount, { n: r.part, of: r.parts });
    if (memo !== r.memo) up.run(memo, r.txn_id);
  }
}

/** Amazon order info for transactions (for the transaction editor). */
export function amazonInfoFor(txnIds: number[]): Map<number, { orderId: string; items: string[] }> {
  const out = new Map<number, { orderId: string; items: string[] }>();
  if (!txnIds.length) return out;
  const rows = db
    .prepare(
      `SELECT c.txn_id, c.order_id, o.items FROM amazon_charges c LEFT JOIN amazon_orders o ON o.order_id = c.order_id
       WHERE c.txn_id IN (${txnIds.map(() => '?').join(',')})`,
    )
    .all(...txnIds) as { txn_id: number; order_id: string; items: string | null }[];
  for (const r of rows) out.set(r.txn_id, { orderId: r.order_id, items: JSON.parse(r.items || '[]') });
  return out;
}

export function amazonStatus() {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    connected: !!getSetting('amazon_token_hash'),
    lastImport: getSetting('amazon_last_import') || null,
    lastError: getSetting('amazon_last_error') || null,
    charges: n(`SELECT COUNT(*) n FROM amazon_charges`),
    matched: n(`SELECT COUNT(*) n FROM amazon_charges WHERE txn_id IS NOT NULL`),
    orders: n(`SELECT COUNT(*) n FROM amazon_orders WHERE items != '[]'`),
  };
}

// ---------------------------------------------------------------- the extension's API (token auth, not your login)

export const amazonRouter = express.Router();
amazonRouter.use(express.json({ limit: '5mb' }));
amazonRouter.use((req, res, next) => {
  if (!tokenOk(req)) return res.status(401).json({ error: 'Invalid or missing Mani Amazon token. Create one in Mani → Settings → Amazon.' });
  next();
});
const wrap = (fn: (req: Request) => unknown) => (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(fn(req) ?? { ok: true });
  } catch (e) {
    next(e);
  }
};
amazonRouter.get('/ping', wrap(() => ({ ok: true })));
amazonRouter.get('/known', wrap(() => amazonKnown()));
amazonRouter.post('/import', wrap((req) => importAmazon(req.body || {})));
amazonRouter.post(
  '/status',
  wrap((req) => {
    // The extension reports problems (e.g. signed out of Amazon) so they show up in Mani's Settings.
    const err = req.body?.error ? String(req.body.error).slice(0, 300) : '';
    setSetting('amazon_last_error', err);
    // Layout notes about Amazon's pages when reading stopped early (for adjusting the reader).
    // A completed read of the whole look-back period resets the weekly full-scan clock.
    if (req.body?.fullScan === true && !err) setSetting('amazon_last_full_scan', new Date().toISOString());
    setSetting('amazon_debug', req.body?.debug ? JSON.stringify(req.body.debug).slice(0, 8000) : '');
  }),
);
amazonRouter.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if ((err as { type?: string })?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Check the server logs.' });
});
