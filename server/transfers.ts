import { db } from './db.ts';
import { addDays, todayISO } from '../shared/util.ts';

// =====================================================================================
// Automatic transfer detection
//
// When money moves between two of your own accounts, each bank reports its half separately: -$500 leaving checking,
// +$500 arriving in savings (or paying down a card). Left alone those become two transactions that each "need a
// category". Here we find such halves and join them into one transfer, the same as if you'd entered it as one.
// =====================================================================================

/** How far apart the two halves may be dated (banks post the two sides on different days). */
const MAX_DAYS_APART = 4;
/** Only recent transactions are considered, so old history is never rewritten. */
const LOOKBACK_DAYS = 90;

/**
 * Words banks use in descriptions of money moving between accounts. At least one half must look like this (or name the
 * other account's last 4 digits), so a $40 purchase and an unrelated $40 refund are never joined.
 */
const TRANSFER_WORDS =
  /\b(transfer|xfer|xfr|trnsfr|tfr|trf|payment|pymt|pmt|autopay|auto[- ]pay|e-?pay|epayment|online (banking|banking transfer|pmt)|thank you|bill ?pay|card ?services|crd|deposit from|withdrawal to|(to|from) (chk|checking|sav|savings|share|mma|money market|brokerage|credit card|card))\b/i;

interface Candidate {
  id: number;
  account_id: number;
  date: string;
  amount: number;
  category_id: number | null;
  on_budget: number;
  text: string;
  mask: string | null;
}

const dayDiff = (a: string, b: string) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);

/** Finds unreviewed imported transactions that are two halves of one transfer and joins them. Returns the number of pairs joined. */
export const detectTransfers = db.transaction((): number => {
  const rows = db
    .prepare(
      `SELECT t.id, t.account_id, t.date, t.amount, t.category_id, a.on_budget,
         TRIM(COALESCE(t.imported_payee, '') || ' ' || COALESCE(p.name, '') || ' ' || t.memo) AS text, e.mask
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN external_accounts e ON e.connection_id = a.connection_id AND e.external_id = a.external_id
       WHERE t.import_id IS NOT NULL AND t.matched = 0 AND t.transfer_account_id IS NULL AND t.is_split = 0
         AND t.cleared != 'reconciled' AND t.no_auto_transfer = 0 AND t.amount != 0 AND a.closed = 0
         AND t.approved = 0 AND t.date >= ?`,
    )
    .all(addDays(todayISO(), -LOOKBACK_DAYS)) as Candidate[];

  // Each half's possible other halves: opposite amount, a different account, close in date.
  const byAmount = new Map<number, Candidate[]>();
  for (const r of rows) {
    if (!byAmount.has(r.amount)) byAmount.set(r.amount, []);
    byAmount.get(r.amount)!.push(r);
  }
  const partners = (x: Candidate) =>
    (byAmount.get(-x.amount) ?? []).filter((y) => y.account_id !== x.account_id && dayDiff(x.date, y.date) <= MAX_DAYS_APART);

  const looksLikeTransfer = (x: Candidate, y: Candidate) =>
    TRANSFER_WORDS.test(x.text) ||
    TRANSFER_WORDS.test(y.text) ||
    (!!y.mask && x.text.includes(y.mask)) ||
    (!!x.mask && y.text.includes(x.mask));

  let joined = 0;
  const used = new Set<number>();
  for (const x of rows) {
    if (used.has(x.id) || x.amount >= 0) continue; // Start from the outgoing half.
    const ys = partners(x).filter((y) => !used.has(y.id));
    // Only when it's unambiguous: exactly one possible partner, and that partner has only this one too.
    if (ys.length !== 1) continue;
    const y = ys[0];
    if (partners(y).filter((z) => !used.has(z.id)).length !== 1) continue;
    if (!looksLikeTransfer(x, y)) continue;
    link(x, y);
    used.add(x.id);
    used.add(y.id);
    joined++;
  }
  return joined;
});

function link(x: Candidate, y: Candidate) {
  // Between two budget accounts a transfer has no category (money stays in the budget). Between a budget account and a
  // tracking account the budget side keeps its category, as with a transfer you enter by hand.
  const xCat = x.on_budget && !y.on_budget ? x.category_id : null;
  const yCat = y.on_budget && !x.on_budget ? y.category_id : null;
  const upd = db.prepare(
    `UPDATE transactions SET transfer_account_id = ?, transfer_txn_id = ?, payee_id = NULL, category_id = ?, auto_transfer = 1 WHERE id = ?`,
  );
  upd.run(y.account_id, y.id, xCat, x.id);
  upd.run(x.account_id, x.id, yCat, y.id);
}
