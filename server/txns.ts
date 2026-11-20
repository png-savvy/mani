import { db, getAccount, payeeIdByName, rtaCategoryId, type AccountRow } from './db.ts';
import { detectTransfers } from './transfers.ts';
import { amazonInfoFor } from './amazon.ts';
import { FLAGS, isCreditType, isValidISODate, addDays, type ISODate } from '../shared/util.ts';

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface SubInput {
  amount: number;
  categoryId: number | null;
  memo?: string;
}

export interface TxnInput {
  accountId: number;
  date: ISODate;
  amount: number;
  payeeId?: number | null;
  payeeName?: string | null;
  transferAccountId?: number | null;
  categoryId?: number | null;
  memo?: string;
  cleared?: 'uncleared' | 'cleared' | 'reconciled';
  approved?: boolean;
  flag?: string | null;
  subtransactions?: SubInput[] | null;
}

interface TxnRow {
  id: number;
  account_id: number;
  date: string;
  amount: number;
  payee_id: number | null;
  category_id: number | null;
  memo: string;
  cleared: string;
  approved: number;
  flag: string | null;
  transfer_account_id: number | null;
  transfer_txn_id: number | null;
  is_split: number;
  import_id: string | null;
  imported_payee: string | null;
  matched: number;
  auto_transfer: number;
}

function validateCategory(id: number | null | undefined): number | null {
  if (id === null || id === undefined) return null;
  const cat = db.prepare(`SELECT id, kind FROM categories WHERE id = ?`).get(id) as { id: number; kind: string } | undefined;
  if (!cat) throw new HttpError(400, 'Category not found');
  if (cat.kind === 'cc_payment') {
    throw new HttpError(400, 'Credit card payment categories are funded automatically — record a transfer to the card instead');
  }
  return cat.id;
}

function mustAccount(id: number): AccountRow {
  const a = getAccount(Number(id));
  if (!a) throw new HttpError(400, 'Account not found');
  return a;
}

function getRow(id: number): TxnRow | undefined {
  return db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as TxnRow | undefined;
}

/** Creates or updates a transaction (including its transfer counterpart and split lines). */
export const saveTransaction = db.transaction((input: TxnInput, existingId?: number): number => {
  const acct = mustAccount(input.accountId);
  if (!isValidISODate(input.date)) throw new HttpError(400, 'Invalid date');
  if (!Number.isInteger(input.amount)) throw new HttpError(400, 'Invalid amount');
  if (input.flag && !(FLAGS as readonly string[]).includes(input.flag)) throw new HttpError(400, 'Invalid flag');
  const cleared = input.cleared ?? 'uncleared';
  if (!['uncleared', 'cleared', 'reconciled'].includes(cleared)) throw new HttpError(400, 'Invalid cleared state');

  const existing = existingId ? getRow(existingId) : undefined;
  if (existingId && !existing) throw new HttpError(404, 'Transaction not found');

  let transferAcct: AccountRow | null = null;
  if (input.transferAccountId) {
    transferAcct = mustAccount(input.transferAccountId);
    if (transferAcct.id === acct.id) throw new HttpError(400, 'Cannot transfer to the same account');
  }

  const subs = input.subtransactions && input.subtransactions.length > 0 ? input.subtransactions : null;
  if (subs) {
    if (transferAcct) throw new HttpError(400, 'Split transactions cannot be transfers');
    if (!acct.on_budget) throw new HttpError(400, 'Tracking accounts do not use categories, so they cannot be split');
    if (subs.length < 2) throw new HttpError(400, 'A split needs at least two lines');
    const sum = subs.reduce((s, x) => s + (Number.isInteger(x.amount) ? x.amount : NaN), 0);
    if (sum !== input.amount) throw new HttpError(400, 'Split amounts must add up to the transaction total');
  }

  // Work out which side of a transfer (if any) carries the category.
  let mainCategory: number | null = null;
  let counterpartCategory: number | null = null;
  const requested = subs ? null : validateCategory(input.categoryId);
  if (!transferAcct) {
    mainCategory = acct.on_budget ? requested : null;
  } else if (acct.on_budget && !transferAcct.on_budget) {
    mainCategory = requested;
  } else if (!acct.on_budget && transferAcct.on_budget) {
    counterpartCategory = requested;
  }

  let payeeId: number | null = null;
  if (!transferAcct) {
    if (input.payeeId) {
      const p = db.prepare(`SELECT id FROM payees WHERE id = ?`).get(input.payeeId);
      if (!p) throw new HttpError(400, 'Payee not found');
      payeeId = Number(input.payeeId);
    } else if (input.payeeName) {
      payeeId = payeeIdByName(input.payeeName);
    }
  }

  const fields = {
    account_id: acct.id,
    date: input.date,
    amount: input.amount,
    payee_id: payeeId,
    category_id: mainCategory,
    memo: (input.memo ?? '').slice(0, 500),
    cleared,
    approved: input.approved === false ? 0 : 1,
    flag: input.flag || null,
    transfer_account_id: transferAcct ? transferAcct.id : null,
    is_split: subs ? 1 : 0,
  };

  let id: number;
  if (existing) {
    id = existing.id;
    db.prepare(
      `UPDATE transactions SET account_id=@account_id, date=@date, amount=@amount, payee_id=@payee_id, category_id=@category_id,
       memo=@memo, cleared=@cleared, approved=@approved, flag=@flag, transfer_account_id=@transfer_account_id, is_split=@is_split
       WHERE id=@id`,
    ).run({ ...fields, id });
  } else {
    id = Number(
      db
        .prepare(
          `INSERT INTO transactions (account_id, date, amount, payee_id, category_id, memo, cleared, approved, flag, transfer_account_id, is_split)
           VALUES (@account_id, @date, @amount, @payee_id, @category_id, @memo, @cleared, @approved, @flag, @transfer_account_id, @is_split)`,
        )
        .run(fields).lastInsertRowid,
    );
  }

  // Transfer counterpart management.
  const oldCounterpart = existing?.transfer_txn_id ? getRow(existing.transfer_txn_id) : undefined;
  if (oldCounterpart && (!transferAcct || oldCounterpart.account_id !== transferAcct.id)) {
    releaseCounterpart(oldCounterpart);
    // The user separated these on purpose: never join them again automatically.
    db.prepare(`UPDATE transactions SET auto_transfer = 0, no_auto_transfer = 1 WHERE id = ?`).run(id);
  }
  if (transferAcct) {
    const keep = oldCounterpart && oldCounterpart.account_id === transferAcct.id ? oldCounterpart : undefined;
    if (keep) {
      db.prepare(
        `UPDATE transactions SET date=?, amount=?, memo=?, category_id=?, transfer_account_id=?, transfer_txn_id=?, payee_id=NULL, is_split=0 WHERE id=?`,
      ).run(input.date, -input.amount, fields.memo, counterpartCategory, acct.id, id, keep.id);
      db.prepare(`UPDATE transactions SET transfer_txn_id=? WHERE id=?`).run(keep.id, id);
    } else {
      // If the other bank already sent its half of this transfer, use that instead of adding a duplicate.
      const theirs = db
        .prepare(
          `SELECT id FROM transactions
           WHERE account_id = ? AND amount = ? AND import_id IS NOT NULL AND matched = 0 AND transfer_account_id IS NULL
             AND is_split = 0 AND id != ? AND date BETWEEN ? AND ?
           ORDER BY abs(julianday(date) - julianday(?)), id LIMIT 1`,
        )
        .get(transferAcct.id, -input.amount, id, addDays(input.date, -7), addDays(input.date, 7), input.date) as { id: number } | undefined;
      let cid: number;
      if (theirs) {
        cid = theirs.id;
        db.prepare(
          `UPDATE transactions SET category_id = ?, transfer_account_id = ?, transfer_txn_id = ?, payee_id = NULL, no_auto_transfer = 0 WHERE id = ?`,
        ).run(counterpartCategory, acct.id, id, cid);
      } else {
        cid = Number(
          db
            .prepare(
              `INSERT INTO transactions (account_id, date, amount, category_id, memo, cleared, approved, transfer_account_id, transfer_txn_id)
               VALUES (?, ?, ?, ?, ?, 'uncleared', 1, ?, ?)`,
            )
            .run(transferAcct.id, input.date, -input.amount, counterpartCategory, fields.memo, acct.id, id).lastInsertRowid,
        );
      }
      db.prepare(`UPDATE transactions SET transfer_txn_id=? WHERE id=?`).run(cid, id);
    }
  } else {
    db.prepare(`UPDATE transactions SET transfer_txn_id=NULL WHERE id=?`).run(id);
  }

  db.prepare(`DELETE FROM subtransactions WHERE transaction_id = ?`).run(id);
  if (subs) {
    const ins = db.prepare(`INSERT INTO subtransactions (transaction_id, amount, category_id, memo) VALUES (?, ?, ?, ?)`);
    for (const s of subs) ins.run(id, s.amount, validateCategory(s.categoryId), (s.memo ?? '').slice(0, 500));
  }

  // Remember the category for this payee to auto-fill next time (and for imports).
  if (payeeId && mainCategory && mainCategory !== rtaCategoryId()) {
    db.prepare(`UPDATE payees SET last_category_id = ? WHERE id = ?`).run(mainCategory, payeeId);
  } else if (payeeId && mainCategory === rtaCategoryId() && input.amount > 0) {
    db.prepare(`UPDATE payees SET last_category_id = ? WHERE id = ?`).run(mainCategory, payeeId);
  }
  return id;
});

export const deleteTransaction = db.transaction((id: number) => {
  const row = getRow(id);
  if (!row) throw new HttpError(404, 'Transaction not found');
  const other = row.transfer_txn_id ? getRow(row.transfer_txn_id) : undefined;
  if (other) releaseCounterpart(other);
  db.prepare(`DELETE FROM transactions WHERE id = ?`).run(id);
});

/** Splits a transfer the app joined automatically back into the two separate bank transactions. */
export const separateTransfer = db.transaction((id: number) => {
  const row = getRow(id);
  if (!row || !row.transfer_txn_id) return;
  const other = getRow(row.transfer_txn_id);
  if (other) releaseCounterpart(other);
  if (row.import_id) releaseCounterpart(row);
  else db.prepare(`UPDATE transactions SET transfer_account_id = NULL, transfer_txn_id = NULL WHERE id = ?`).run(id);
});

/**
 * The other half of a transfer that is being removed or re-pointed. One the app made up is deleted with it; one your bank
 * sent stays (it really happened) and goes back to being an ordinary transaction for you to review.
 */
function releaseCounterpart(other: TxnRow) {
  if (!other.import_id) {
    db.prepare(`DELETE FROM transactions WHERE id = ?`).run(other.id);
    return;
  }
  db.prepare(
    `UPDATE transactions SET transfer_account_id = NULL, transfer_txn_id = NULL, category_id = NULL, payee_id = ?, approved = 0,
       auto_transfer = 0, no_auto_transfer = 1 WHERE id = ?`,
  ).run(payeeIdByName(cleanPayee(other.imported_payee || 'Unknown')), other.id);
}

export interface TxnFilter {
  accountId?: number;
  categoryId?: number;
  month?: string;
  search?: string;
  unapprovedOnly?: boolean;
  limit?: number;
}

export function listTransactions(f: TxnFilter) {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (f.accountId) {
    where.push('t.account_id = @accountId');
    params.accountId = f.accountId;
  }
  if (f.categoryId) {
    where.push(
      `(COALESCE(t.category_id, ct.category_id) = @categoryId OR EXISTS (SELECT 1 FROM subtransactions s WHERE s.transaction_id = t.id AND s.category_id = @categoryId))`,
    );
    params.categoryId = f.categoryId;
  }
  if (f.month) {
    where.push(`substr(t.date,1,7) = @month`);
    params.month = f.month;
  }
  if (f.unapprovedOnly) where.push('t.approved = 0');
  if (f.search) {
    where.push(
      `(p.name LIKE @q OR t.memo LIKE @q OR c.name LIKE @q OR ta.name LIKE @q OR t.imported_payee LIKE @q OR printf('%.2f', abs(t.amount)/100.0) LIKE @q)`,
    );
    params.q = `%${f.search}%`;
  }
  const sql = `
    SELECT t.*, a.name AS account_name, p.name AS payee_name, c.name AS category_name,
           ta.name AS transfer_account_name, ct.category_id AS counterpart_category_id, cc.name AS counterpart_category_name
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN payees p ON p.id = t.payee_id
    LEFT JOIN categories c ON c.id = t.category_id
    LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
    LEFT JOIN transactions ct ON ct.id = t.transfer_txn_id
    LEFT JOIN categories cc ON cc.id = ct.category_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY t.date DESC, t.id DESC
    ${f.limit ? 'LIMIT ' + Number(f.limit) : ''}`;
  const rows = db.prepare(sql).all(params) as (TxnRow & Record<string, any>)[];
  const ids = rows.filter((r) => r.is_split).map((r) => r.id);
  const subsBy = new Map<number, any[]>();
  if (ids.length) {
    const subs = db
      .prepare(
        `SELECT s.*, c.name AS category_name FROM subtransactions s LEFT JOIN categories c ON c.id = s.category_id
         WHERE s.transaction_id IN (${ids.map(() => '?').join(',')}) ORDER BY s.id`,
      )
      .all(...ids) as any[];
    for (const s of subs) {
      if (!subsBy.has(s.transaction_id)) subsBy.set(s.transaction_id, []);
      subsBy.get(s.transaction_id)!.push({ id: s.id, amount: s.amount, categoryId: s.category_id, categoryName: s.category_name, memo: s.memo });
    }
  }
  const amazon = amazonInfoFor(rows.map((r) => r.id));
  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    accountName: r.account_name,
    date: r.date,
    amount: r.amount,
    payeeId: r.payee_id,
    payeeName: r.payee_name,
    categoryId: r.category_id,
    categoryName: r.category_name,
    counterpartCategoryId: r.counterpart_category_id,
    counterpartCategoryName: r.counterpart_category_name,
    memo: r.memo,
    cleared: r.cleared,
    approved: !!r.approved,
    flag: r.flag,
    transferAccountId: r.transfer_account_id,
    transferAccountName: r.transfer_account_name,
    transferTxnId: r.transfer_txn_id,
    isSplit: !!r.is_split,
    subtransactions: subsBy.get(r.id) ?? [],
    importId: r.import_id,
    importedPayee: r.imported_payee,
    matched: !!r.matched,
    autoTransfer: !!r.auto_transfer,
    amazon: amazon.get(r.id) ?? null,
  }));
}

export function accountBalances() {
  return db
    .prepare(
      `SELECT a.id,
         COALESCE(SUM(t.amount), 0) AS working,
         COALESCE(SUM(CASE WHEN t.cleared != 'uncleared' THEN t.amount ELSE 0 END), 0) AS cleared,
         COALESCE(SUM(CASE WHEN t.cleared = 'uncleared' THEN t.amount ELSE 0 END), 0) AS uncleared,
         COALESCE(SUM(CASE WHEN t.approved = 0 THEN 1 ELSE 0 END), 0) AS unapproved,
         -- Everything the user still has to look at: not yet approved, or missing a category (same rule as the budget's
         -- uncategorized count). One number so there is a single place to review.
         COALESCE(SUM(CASE WHEN t.approved = 0 OR (
           a.on_budget = 1 AND t.is_split = 0 AND t.category_id IS NULL
           AND (t.transfer_account_id IS NULL OR b.on_budget = 0)
           AND NOT (a.type IN ('credit_card','line_of_credit') AND COALESCE(t.payee_id = (SELECT id FROM payees WHERE name = 'Starting Balance'), 0))
         ) THEN 1 ELSE 0 END), 0) AS review
       FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
       LEFT JOIN accounts b ON b.id = t.transfer_account_id
       GROUP BY a.id`,
    )
    .all() as { id: number; working: number; cleared: number; uncleared: number; unapproved: number; review: number }[];
}

// ---------------- Imports (bank sync and file import share this path) ----------------

export interface ImportItem {
  importId: string;
  date: ISODate;
  amount: number; // cents, negative = outflow
  payeeName: string;
  memo?: string;
}

function applyRules(text: string): { payeeId: number | null; categoryId: number | null } {
  const rules = db.prepare(`SELECT * FROM payee_rules ORDER BY id`).all() as {
    match_type: string;
    match_text: string;
    payee_id: number;
    category_id: number | null;
  }[];
  const t = text.toLowerCase();
  for (const r of rules) {
    const m = r.match_text.toLowerCase();
    const hit = r.match_type === 'equals' ? t === m : r.match_type === 'starts_with' ? t.startsWith(m) : t.includes(m);
    if (hit) return { payeeId: r.payee_id, categoryId: r.category_id };
  }
  return { payeeId: null, categoryId: null };
}

/** Cleans up raw bank descriptions a little ("POS DEBIT  STARBUCKS #1234" -> "Starbucks #1234"). */
export function cleanPayee(raw: string): string {
  let s = raw.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(POS|DEBIT|CREDIT|ACH|CHECKCARD|CHECK CARD|PURCHASE|RECURRING|PREAUTHORIZED|DEBIT CARD|VISA|SQ \*|TST\*)\s+/i, '');
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) {
    s = s.toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
  }
  return s.slice(0, 100) || 'Unknown';
}

export const importTransactions = db.transaction((accountId: number, items: ImportItem[]) => {
  const acct = mustAccount(accountId);
  const result = { imported: 0, matched: 0, skipped: 0, newIds: [] as number[] };
  // A bank record the user un-matched lives on as "<id>:unmatched"; it still counts as imported.
  const exists = db.prepare(`SELECT id FROM transactions WHERE account_id = ? AND import_id IN (?, ? || ':unmatched')`);
  const findMatch = db.prepare(
    `SELECT id FROM transactions
     WHERE account_id = ? AND import_id IS NULL AND amount = ? AND date BETWEEN ? AND ? AND cleared != 'reconciled'
     ORDER BY abs(julianday(date) - julianday(?)), id LIMIT 1`,
  );
  for (const it of items) {
    if (!isValidISODate(it.date) || !Number.isInteger(it.amount) || !it.importId) {
      result.skipped++;
      continue;
    }
    if (acct.import_start && it.date < acct.import_start) {
      result.skipped++;
      continue;
    }
    if (exists.get(acct.id, it.importId, it.importId)) {
      result.skipped++;
      continue;
    }
    const match = findMatch.get(acct.id, it.amount, addDays(it.date, -10), addDays(it.date, 10), it.date) as { id: number } | undefined;
    if (match) {
      db.prepare(
        `UPDATE transactions SET import_id = ?, imported_payee = ?, matched = 1, approved = 0,
         cleared = CASE WHEN cleared = 'uncleared' THEN 'cleared' ELSE cleared END WHERE id = ?`,
      ).run(it.importId, it.payeeName, match.id);
      result.matched++;
      continue;
    }
    const rule = applyRules(it.payeeName);
    const payeeId = rule.payeeId ?? payeeIdByName(cleanPayee(it.payeeName));
    let categoryId: number | null = null;
    if (acct.on_budget) {
      categoryId = rule.categoryId;
      if (!categoryId && payeeId) {
        const p = db.prepare(`SELECT last_category_id FROM payees WHERE id = ?`).get(payeeId) as { last_category_id: number | null };
        categoryId = p?.last_category_id ?? null;
      }
      if (categoryId) {
        const c = db.prepare(`SELECT kind FROM categories WHERE id = ?`).get(categoryId) as { kind: string } | undefined;
        if (!c || c.kind === 'cc_payment' || (c.kind === 'income' && it.amount < 0)) categoryId = null;
      }
    }
    const ins = db
      .prepare(
        `INSERT INTO transactions (account_id, date, amount, payee_id, category_id, memo, cleared, approved, import_id, imported_payee)
         VALUES (?, ?, ?, ?, ?, ?, 'cleared', 0, ?, ?)`,
      )
      .run(acct.id, it.date, it.amount, payeeId, categoryId, (it.memo ?? '').slice(0, 500), it.importId, it.payeeName);
    result.newIds.push(Number(ins.lastInsertRowid));
    result.imported++;
  }
  db.prepare(`UPDATE accounts SET last_import_at = datetime('now') WHERE id = ?`).run(acct.id);
  if (result.imported) detectTransfers();
  return result;
});

/** Removes an imported transaction the bank says no longer exists, unless the user already approved it. */
export function removeImported(accountId: number, importId: string) {
  db.prepare(`DELETE FROM transactions WHERE account_id = ? AND import_id = ? AND approved = 0 AND matched = 0`).run(accountId, importId);
}

/** Cash starting balances go to Ready to Assign; card debt does not (only a positive card balance does). */
export function startingBalanceCategory(acct: AccountRow, amount: number): number | null {
  return acct.on_budget && (!isCreditType(acct.type) || amount > 0) ? rtaCategoryId() : null;
}

export function createStartingBalance(acct: AccountRow, amount: number, date: ISODate): number {
  const payee = payeeIdByName('Starting Balance');
  return Number(
    db
      .prepare(
        `INSERT INTO transactions (account_id, date, amount, payee_id, category_id, cleared, approved) VALUES (?, ?, ?, ?, ?, 'cleared', 1)`,
      )
      .run(acct.id, date, amount, payee, startingBalanceCategory(acct, amount)).lastInsertRowid,
  );
}
