import { db, ccGroupId, getAccount, type AccountRow } from './db.ts';
import { HttpError, createStartingBalance } from './txns.ts';
import { ACCOUNT_TYPES, isBudgetType, isCreditType, isValidISODate, todayISO, type ISODate } from '../shared/util.ts';

export interface NewAccount {
  name: string;
  type: string;
  balance: number; // cents, as shown by the bank (credit card debt is negative)
  date?: ISODate;
  note?: string;
  connectionId?: number | null;
  externalId?: string | null;
  importStart?: ISODate | null;
  skipStartingBalance?: boolean;
}

export const createAccount = db.transaction((a: NewAccount): AccountRow => {
  const name = (a.name || '').trim();
  if (!name) throw new HttpError(400, 'Account name is required');
  if (!(ACCOUNT_TYPES as readonly string[]).includes(a.type)) throw new HttpError(400, 'Invalid account type');
  if (!Number.isInteger(a.balance)) throw new HttpError(400, 'Invalid balance');
  const date = a.date && isValidISODate(a.date) ? a.date : todayISO();
  const onBudget = isBudgetType(a.type) ? 1 : 0;
  const sort = (db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM accounts`).get() as { s: number }).s;
  const id = Number(
    db
      .prepare(
        `INSERT INTO accounts (name, type, on_budget, note, sort, connection_id, external_id, import_start) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, a.type, onBudget, a.note ?? '', sort, a.connectionId ?? null, a.externalId ?? null, a.importStart ?? null).lastInsertRowid,
  );
  const acct = getAccount(id)!;
  if (onBudget && isCreditType(a.type)) {
    const s = (db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE group_id = ?`).get(ccGroupId()) as { s: number }).s;
    db.prepare(`INSERT INTO categories (group_id, name, kind, linked_account_id, sort) VALUES (?, ?, 'cc_payment', ?, ?)`).run(
      ccGroupId(),
      name,
      id,
      s,
    );
  }
  if (!a.skipStartingBalance) createStartingBalance(acct, a.balance, date);
  return acct;
});

export function updateAccount(id: number, patch: { name?: string; note?: string; closed?: boolean }) {
  const acct = getAccount(id);
  if (!acct) throw new HttpError(404, 'Account not found');
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new HttpError(400, 'Account name is required');
    db.prepare(`UPDATE accounts SET name = ? WHERE id = ?`).run(name, id);
    db.prepare(`UPDATE categories SET name = ? WHERE kind = 'cc_payment' AND linked_account_id = ?`).run(name, id);
  }
  if (patch.note !== undefined) db.prepare(`UPDATE accounts SET note = ? WHERE id = ?`).run(patch.note, id);
  if (patch.closed !== undefined) db.prepare(`UPDATE accounts SET closed = ? WHERE id = ?`).run(patch.closed ? 1 : 0, id);
}

export const deleteAccount = db.transaction((id: number) => {
  const acct = getAccount(id);
  if (!acct) throw new HttpError(404, 'Account not found');
  // Transfers from other accounts lose their link but keep their amounts, so other balances don't change.
  const payee = db.prepare(`INSERT OR IGNORE INTO payees (name) VALUES (?)`).run(`Transfer: ${acct.name} (deleted)`);
  void payee;
  const pid = (db.prepare(`SELECT id FROM payees WHERE name = ?`).get(`Transfer: ${acct.name} (deleted)`) as { id: number }).id;
  db.prepare(
    `UPDATE transactions SET transfer_account_id = NULL, transfer_txn_id = NULL, payee_id = ? WHERE transfer_account_id = ? AND account_id != ?`,
  ).run(pid, id, id);
  db.prepare(`DELETE FROM scheduled WHERE account_id = ? OR transfer_account_id = ?`).run(id, id);
  db.prepare(`DELETE FROM transactions WHERE account_id = ?`).run(id);
  // Keep the payment category history but turn it into a normal category so past budget data stays intact.
  db.prepare(`UPDATE categories SET kind = 'normal', linked_account_id = NULL, name = name || ' (deleted account)' WHERE linked_account_id = ?`).run(id);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
});

export function listAccounts() {
  return db
    .prepare(
      `SELECT a.*, c.provider, c.institution, c.status AS connection_status, c.error AS connection_error
       FROM accounts a LEFT JOIN connections c ON c.id = a.connection_id ORDER BY a.sort, a.id`,
    )
    .all() as (AccountRow & { provider: string | null; institution: string | null; connection_status: string | null; connection_error: string | null })[];
}

/**
 * Reconcile: if the bank's balance equals the cleared balance, lock all cleared transactions.
 * Otherwise create an adjustment transaction for the difference first.
 */
export const reconcileAccount = db.transaction((id: number, bankBalance: number) => {
  const acct = getAccount(id);
  if (!acct) throw new HttpError(404, 'Account not found');
  if (!Number.isInteger(bankBalance)) throw new HttpError(400, 'Invalid balance');
  const { cleared } = db
    .prepare(`SELECT COALESCE(SUM(amount), 0) AS cleared FROM transactions WHERE account_id = ? AND cleared != 'uncleared'`)
    .get(id) as { cleared: number };
  const diff = bankBalance - cleared;
  let adjustmentId: number | null = null;
  if (diff !== 0) {
    const payee = (db.prepare(`SELECT id FROM payees WHERE name = 'Reconciliation Balance Adjustment'`).get() as { id: number } | undefined)?.id ?? null;
    const category = acct.on_budget ? (db.prepare(`SELECT id FROM categories WHERE kind = 'income'`).get() as { id: number }).id : null;
    adjustmentId = Number(
      db
        .prepare(
          `INSERT INTO transactions (account_id, date, amount, payee_id, category_id, memo, cleared, approved) VALUES (?, ?, ?, ?, ?, 'Entered automatically by reconciliation', 'cleared', 1)`,
        )
        .run(id, todayISO(), diff, payee, category).lastInsertRowid,
    );
  }
  db.prepare(`UPDATE transactions SET cleared = 'reconciled' WHERE account_id = ? AND cleared = 'cleared'`).run(id);
  db.prepare(`UPDATE accounts SET last_reconciled_at = datetime('now') WHERE id = ?`).run(id);
  return { adjustment: diff, adjustmentId };
});
