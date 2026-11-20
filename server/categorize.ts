import { db, getAccount, rtaCategoryId } from './db.ts';
import { monthView } from './budget.ts';
import { HttpError } from './txns.ts';
import { currentMonth } from '../shared/util.ts';

// Categorizing a transaction straight from a list (the review list's category picker), with enough information to show
// what it did to the budget and to put everything back if it was a mistake.

export interface BalanceChange {
  id: number;
  name: string;
  before: number;
  after: number;
}

export interface CategorizeUndo {
  categoryId: number | null;
  approved: boolean;
  /** The category the payee was remembered under before (used to pre-fill future imports); absent when there's no payee. */
  payeeLastCategoryId?: number | null;
}

/** A category's balance right now (what the budget shows as available); Ready to Assign for the income category. */
function categoryBalance(categoryId: number | null): { id: number; name: string; balance: number } | null {
  if (!categoryId) return null;
  const cat = db.prepare(`SELECT id, name, kind FROM categories WHERE id = ?`).get(categoryId) as { id: number; name: string; kind: string } | undefined;
  if (!cat) return null;
  const view = monthView(currentMonth());
  if (cat.kind === 'income') return { id: cat.id, name: 'Ready to Assign', balance: view.readyToAssign.total };
  for (const g of view.groups) {
    const c = g.categories.find((x) => x.id === categoryId);
    if (c) return { id: cat.id, name: cat.name, balance: c.available };
  }
  return null;
}

/**
 * Puts a transaction in a category and approves it — or, with no category, takes its category off so it goes back to
 * the review list. Reports the balance of the category it went into (and the one it
 * left, if any) before and after, plus what undoCategorize needs to restore the previous state exactly.
 */
export const categorizeTransaction = db.transaction((id: number, categoryId: number | null) => {
  const row = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as any;
  if (!row) throw new HttpError(404, 'Transaction not found');
  const acct = getAccount(row.account_id)!;
  if (row.is_split) throw new HttpError(400, 'Split transactions are categorized line by line — open the transaction to edit it');
  if (!acct.on_budget) throw new HttpError(400, 'Transactions in tracking accounts do not use categories');
  if (row.transfer_account_id && getAccount(row.transfer_account_id)?.on_budget) {
    throw new HttpError(400, 'Transfers between budget accounts do not use categories');
  }
  if (categoryId !== null) {
    const c = db.prepare(`SELECT kind FROM categories WHERE id = ?`).get(categoryId) as { kind: string } | undefined;
    if (!c || c.kind === 'cc_payment') throw new HttpError(400, 'Invalid category');
  }

  const payee = row.payee_id ? (db.prepare(`SELECT last_category_id FROM payees WHERE id = ?`).get(row.payee_id) as { last_category_id: number | null }) : null;
  const moved = row.category_id !== categoryId;
  const before = { to: categoryBalance(categoryId), from: moved ? categoryBalance(row.category_id) : null };

  if (categoryId === null) {
    // Taking the category off sends it back to the review list ("needs a category"); nothing else changes.
    db.prepare(`UPDATE transactions SET category_id = NULL WHERE id = ?`).run(id);
  } else {
    db.prepare(`UPDATE transactions SET category_id = ?, approved = 1 WHERE id = ?`).run(categoryId, id);
    if (row.payee_id && categoryId !== rtaCategoryId()) db.prepare(`UPDATE payees SET last_category_id = ? WHERE id = ?`).run(categoryId, row.payee_id);
  }

  const after = { to: categoryBalance(categoryId), from: moved ? categoryBalance(row.category_id) : null };
  const change = (b: ReturnType<typeof categoryBalance>, a: ReturnType<typeof categoryBalance>): BalanceChange | null =>
    b && a ? { id: a.id, name: a.name, before: b.balance, after: a.balance } : null;
  const undo: CategorizeUndo = { categoryId: row.category_id, approved: !!row.approved, payeeLastCategoryId: payee ? payee.last_category_id : undefined };
  return { to: change(before.to, after.to), from: change(before.from, after.from), undo };
});

/** Reverses categorizeTransaction: the transaction's category and approval, and the payee's remembered category. */
export const undoCategorize = db.transaction((id: number, undo: Partial<CategorizeUndo>) => {
  const row = db.prepare(`SELECT payee_id FROM transactions WHERE id = ?`).get(id) as { payee_id: number | null } | undefined;
  if (!row) throw new HttpError(404, 'Transaction not found');
  const exists = (cat: unknown) => Number.isInteger(cat) && !!db.prepare(`SELECT id FROM categories WHERE id = ?`).get(cat);
  const categoryId = undo.categoryId === null || undo.categoryId === undefined ? null : undo.categoryId;
  if (categoryId !== null && !exists(categoryId)) throw new HttpError(400, 'The earlier category no longer exists');
  db.prepare(`UPDATE transactions SET category_id = ?, approved = ? WHERE id = ?`).run(categoryId, undo.approved ? 1 : 0, id);
  if (row.payee_id && undo.payeeLastCategoryId !== undefined) {
    const last = undo.payeeLastCategoryId !== null && exists(undo.payeeLastCategoryId) ? undo.payeeLastCategoryId : null;
    db.prepare(`UPDATE payees SET last_category_id = ? WHERE id = ?`).run(last, row.payee_id);
  }
});

/** True for on-budget spending with no category yet (the same rule as the review count): it can't be approved as it is. */
export function needsCategory(id: number): boolean {
  return !!db
    .prepare(
      `SELECT 1 FROM transactions t JOIN accounts a ON a.id = t.account_id
       LEFT JOIN accounts b ON b.id = t.transfer_account_id
       WHERE t.id = ? AND a.on_budget = 1 AND t.is_split = 0 AND t.category_id IS NULL
         AND (t.transfer_account_id IS NULL OR b.on_budget = 0)
         AND NOT (a.type IN ('credit_card','line_of_credit') AND COALESCE(t.payee_id = (SELECT id FROM payees WHERE name = 'Starting Balance'), 0))`,
    )
    .get(id);
}
