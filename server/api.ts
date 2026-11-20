import express, { type Request, type Response, type NextFunction } from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, getSetting, setSetting, getAccount, payeeIdByName, rtaCategoryId } from './db.ts';
import {
  MAX_PASSWORD_LENGTH,
  clearLoginFailures,
  createSession,
  destroySession,
  isAuthed,
  isSetUp,
  loginAllowed,
  loginThrottleMs,
  recordLoginFailure,
  requireAuth,
  revokeOtherSessions,
  setPassword,
  verifyPassword,
} from './security.ts';
import QRCode from 'qrcode';
import {
  beginSetup,
  codeAttemptsBlocked,
  confirmSetup,
  disableTwoFactor,
  recoveryCodesLeft,
  regenerateRecoveryCodes,
  twoFactorEnabled,
  verifySecondFactor,
} from './totp.ts';
import { amazonStatus, newAmazonToken, revokeAmazonToken } from './amazon.ts';
import { categorizeTransaction, needsCategory, undoCategorize } from './categorize.ts';
import { pushStatus, removeDevice, sendToAll, subscribe, unsubscribe } from './push.ts';
import { HttpError, accountBalances, deleteTransaction, separateTransfer, importTransactions, listTransactions, saveTransaction, type TxnInput } from './txns.ts';
import { createAccount, deleteAccount, listAccounts, reconcileAccount, updateAccount } from './accounts.ts';
import { budgetMode, compute, monthView, targetStatus, emptyState } from './budget.ts';
import { applyPlan, getPlan, planPreview, planStatus, savePlan, skipPlan } from './plan.ts';
import { insights } from './insights.ts';
import {
  deleteConnection,
  listConnections,
  mapAccounts,
  plaidConfig,
  plaidExchange,
  plaidLinkToken,
  simplefinClaim,
  syncAll,
  syncConnection,
  syncIntervalHours,
} from './banks.ts';
import { enterDueScheduled } from './scheduler.ts';
import {
  FREQUENCIES,
  TARGET_TYPES,
  addMonths,
  currentMonth,
  isValidISODate,
  isValidMonth,
  nextOccurrence,
  todayISO,
  type Frequency,
  type Month,
} from '../shared/util.ts';

export const api = express.Router();

type Handler = (req: Request, res: Response) => unknown | Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((out) => {
      if (!res.headersSent) res.json(out ?? { ok: true });
    })
    .catch(next);
};

function int(v: unknown, name = 'value'): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `Invalid ${name}`);
  return n;
}
function optInt(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  return int(v);
}
function month(v: unknown): Month {
  if (!isValidMonth(v)) throw new HttpError(400, 'Invalid month');
  return v;
}

// ---------------------------------------------------------------- auth

api.get('/auth/status', h((req) => ({ setUp: isSetUp(), authed: isAuthed(req) })));

api.post(
  '/auth/setup',
  h((req, res) => {
    if (isSetUp()) throw new HttpError(400, 'Already set up');
    const pw = String(req.body?.password ?? '');
    if (pw.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters');
    if (pw.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, 'That password is too long');
    setPassword(pw);
    if (req.body?.budgetName) setSetting('budget_name', String(req.body.budgetName).slice(0, 100));
    if (req.body?.currency) setSetting('currency', String(req.body.currency).slice(0, 3).toUpperCase());
    createSession(req, res);
  }),
);

api.post(
  '/auth/login',
  h(async (req, res) => {
    const ip = req.ip || 'unknown';
    if (!loginAllowed(ip)) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    // Global slow-down that spoofing a client IP can't sidestep. Applied before the password is
    // even checked, so repeated guessing gets progressively (and genuinely) slower.
    const delay = loginThrottleMs();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const stored = getSetting('password_hash');
    if (!stored || !verifyPassword(String(req.body?.password ?? ''), stored)) {
      recordLoginFailure(ip);
      throw new HttpError(401, 'Incorrect password');
    }
    let usedRecovery = false;
    if (twoFactorEnabled()) {
      const code = String(req.body?.code ?? '').trim();
      // Password was right; ask for the authenticator code (nothing is unlocked yet).
      if (!code) return { needsCode: true };
      if (codeAttemptsBlocked()) throw new HttpError(429, 'Too many incorrect codes. Try again in 15 minutes.');
      const r = verifySecondFactor(code);
      if (!r.ok) {
        recordLoginFailure(ip);
        throw new HttpError(401, 'Incorrect code. Codes change every 30 seconds — use the newest one.');
      }
      usedRecovery = !!r.usedRecovery;
    }
    clearLoginFailures(ip);
    createSession(req, res);
    return { ok: true, usedRecovery, recoveryCodesLeft: twoFactorEnabled() ? recoveryCodesLeft() : null };
  }),
);

api.post('/auth/logout', h((req, res) => destroySession(req, res)));

api.use(requireAuth);

// ---- two-step login (authenticator app) ----

function requirePassword(req: Request) {
  if (!verifyPassword(String(req.body?.password ?? ''), getSetting('password_hash')!)) throw new HttpError(400, 'Password is incorrect');
}

api.get('/auth/2fa', h(() => ({ enabled: twoFactorEnabled(), recoveryCodesLeft: recoveryCodesLeft() })));

api.post(
  '/auth/2fa/setup',
  h(async (req) => {
    requirePassword(req);
    if (twoFactorEnabled()) throw new HttpError(400, 'Two-step login is already on');
    const { secret, uri } = beginSetup();
    return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }) };
  }),
);

api.post(
  '/auth/2fa/enable',
  h((req) => {
    const codes = confirmSetup(String(req.body?.code ?? ''));
    if (!codes) throw new HttpError(400, "That code didn't match. Check your phone's time is automatic and enter the newest code.");
    revokeOtherSessions(req);
    return { recoveryCodes: codes };
  }),
);

api.post(
  '/auth/2fa/disable',
  h((req) => {
    requirePassword(req);
    if (!verifySecondFactor(String(req.body?.code ?? '')).ok) throw new HttpError(400, 'Incorrect code');
    disableTwoFactor();
  }),
);

api.post(
  '/auth/2fa/recovery-codes',
  h((req) => {
    requirePassword(req);
    if (!verifySecondFactor(String(req.body?.code ?? '')).ok) throw new HttpError(400, 'Incorrect code');
    return { recoveryCodes: regenerateRecoveryCodes() };
  }),
);

api.post(
  '/auth/password',
  h((req) => {
    const stored = getSetting('password_hash')!;
    if (!verifyPassword(String(req.body?.current ?? ''), stored)) throw new HttpError(400, 'Current password is incorrect');
    const next = String(req.body?.next ?? '');
    if (next.length < 8) throw new HttpError(400, 'Use a password of at least 8 characters');
    if (next.length > MAX_PASSWORD_LENGTH) throw new HttpError(400, 'That password is too long');
    setPassword(next);
    db.prepare(`DELETE FROM sessions`).run();
  }),
);

// ---------------------------------------------------------------- bootstrap / settings

function settingsObject() {
  return {
    budgetName: getSetting('budget_name') || 'My Budget',
    currency: getSetting('currency') || 'USD',
    locale: getSetting('locale') || 'en-US',
    dateFormat: getSetting('date_format') || 'MM/DD/YYYY',
    syncIntervalHours: syncIntervalHours(),
    budgetMode: budgetMode(),
    showCcPayments: getSetting('show_cc_payments') !== '0',
  };
}

function accountsWithBalances() {
  const bal = new Map(accountBalances().map((b) => [b.id, b]));
  return listAccounts().map((a) => {
    const b = bal.get(a.id)!;
    return {
      id: a.id,
      name: a.name,
      type: a.type,
      onBudget: !!a.on_budget,
      closed: !!a.closed,
      note: a.note,
      lastReconciledAt: a.last_reconciled_at,
      linked: !!(a.connection_id && a.external_id),
      connectionId: a.connection_id,
      provider: a.provider,
      institution: a.institution,
      connectionStatus: a.connection_status,
      connectionError: a.connection_error,
      lastImportAt: a.last_import_at,
      lastCheckedAt: a.connection_last_sync,
      bankBalance: a.bank_balance,
      importStart: a.import_start,
      balance: b.working,
      clearedBalance: b.cleared,
      unclearedBalance: b.uncleared,
      unapprovedCount: b.unapproved,
      reviewCount: b.review,
    };
  });
}

api.get(
  '/bootstrap',
  h(() => ({
    settings: settingsObject(),
    accounts: accountsWithBalances(),
    groups: db.prepare(`SELECT id, name, hidden, system, sort FROM category_groups ORDER BY sort, id`).all(),
    categories: db
      .prepare(`SELECT id, group_id AS groupId, name, hidden, kind, linked_account_id AS linkedAccountId, sort FROM categories ORDER BY sort, id`)
      .all(),
    payees: db.prepare(`SELECT id, name, last_category_id AS lastCategoryId FROM payees ORDER BY name COLLATE NOCASE`).all(),
    plaid: { configured: plaidConfig().configured, env: plaidConfig().env },
    unmappedConnections: (
      db
        .prepare(`SELECT COUNT(*) AS n FROM connections c WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.connection_id = c.id AND a.external_id IS NOT NULL)`)
        .get() as { n: number }
    ).n,
  })),
);

api.get('/settings', h(() => settingsObject()));
api.put(
  '/settings',
  h((req) => {
    const b = req.body || {};
    if (b.budgetName !== undefined) setSetting('budget_name', String(b.budgetName).slice(0, 100));
    if (b.currency !== undefined) {
      const c = String(b.currency).toUpperCase();
      try {
        new Intl.NumberFormat('en-US', { style: 'currency', currency: c });
      } catch {
        throw new HttpError(400, 'Unknown currency code');
      }
      setSetting('currency', c);
    }
    if (b.locale !== undefined) setSetting('locale', String(b.locale));
    if (b.dateFormat !== undefined) {
      if (!['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD'].includes(b.dateFormat)) throw new HttpError(400, 'Invalid date format');
      setSetting('date_format', b.dateFormat);
    }
    if (b.budgetMode !== undefined) {
      if (!['rolling', 'monthly'].includes(b.budgetMode)) throw new HttpError(400, 'Invalid budget style');
      setSetting('budget_mode', b.budgetMode);
    }
    if (b.showCcPayments !== undefined) setSetting('show_cc_payments', b.showCcPayments ? '1' : '0');
    if (b.syncIntervalHours !== undefined) {
      const n = Number(b.syncIntervalHours);
      if (!Number.isFinite(n) || n < 0 || n > 168) throw new HttpError(400, 'Sync interval must be 0–168 hours');
      setSetting('sync_interval_hours', String(n));
    }
    return settingsObject();
  }),
);

// ---------------------------------------------------------------- accounts

api.post(
  '/accounts',
  h((req) => {
    const b = req.body || {};
    const acct = createAccount({ name: b.name, type: b.type, balance: int(b.balance ?? 0, 'balance'), date: b.date, note: b.note });
    return { id: acct.id };
  }),
);

api.put(
  '/accounts/:id',
  h((req) => {
    updateAccount(int(req.params.id), { name: req.body?.name, note: req.body?.note, closed: req.body?.closed });
  }),
);

api.delete('/accounts/:id', h((req) => deleteAccount(int(req.params.id))));

api.post(
  '/accounts/reorder',
  h((req) => {
    const ids: unknown[] = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const stmt = db.prepare(`UPDATE accounts SET sort = ? WHERE id = ?`);
    db.transaction(() => ids.forEach((id, i) => stmt.run(i, int(id))))();
  }),
);

api.post('/accounts/:id/reconcile', h((req) => reconcileAccount(int(req.params.id), int(req.body?.balance, 'balance'))));

api.post(
  '/accounts/:id/import',
  h(async (req) => {
    const acct = getAccount(int(req.params.id));
    if (!acct) throw new HttpError(404, 'Account not found');
    if (!acct.connection_id) throw new HttpError(400, 'This account is not linked to a bank');
    return await syncConnection(acct.connection_id);
  }),
);

api.post(
  '/accounts/:id/unlink',
  h((req) => {
    db.prepare(`UPDATE accounts SET connection_id = NULL, external_id = NULL WHERE id = ?`).run(int(req.params.id));
  }),
);

api.post(
  '/accounts/:id/import-file',
  h((req) => {
    const id = int(req.params.id);
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (items.length > 20000) throw new HttpError(400, 'File too large');
    const clean = items.map((i: any) => ({
      importId: String(i.importId ?? '').slice(0, 200),
      date: String(i.date ?? ''),
      amount: Number(i.amount),
      payeeName: String(i.payeeName ?? '').slice(0, 200) || 'Unknown',
      memo: String(i.memo ?? '').slice(0, 500),
    }));
    // Imported files should not be filtered by a bank-link start date.
    const acct = getAccount(id);
    if (!acct) throw new HttpError(404, 'Account not found');
    const saved = acct.import_start;
    db.prepare(`UPDATE accounts SET import_start = NULL WHERE id = ?`).run(id);
    try {
      return importTransactions(id, clean);
    } finally {
      db.prepare(`UPDATE accounts SET import_start = ? WHERE id = ?`).run(saved, id);
    }
  }),
);

// ---------------------------------------------------------------- transactions

function txnInput(b: any): TxnInput {
  return {
    accountId: int(b.accountId, 'account'),
    date: String(b.date ?? ''),
    amount: int(b.amount, 'amount'),
    payeeId: optInt(b.payeeId),
    payeeName: b.payeeName ? String(b.payeeName) : null,
    transferAccountId: optInt(b.transferAccountId),
    categoryId: optInt(b.categoryId),
    memo: b.memo ? String(b.memo) : '',
    cleared: b.cleared,
    approved: b.approved !== false,
    flag: b.flag || null,
    subtransactions: Array.isArray(b.subtransactions)
      ? b.subtransactions.map((s: any) => ({ amount: int(s.amount, 'split amount'), categoryId: optInt(s.categoryId), memo: s.memo ?? '' }))
      : null,
  };
}

api.get(
  '/transactions',
  h((req) =>
    listTransactions({
      accountId: optInt(req.query.accountId) ?? undefined,
      categoryId: optInt(req.query.categoryId) ?? undefined,
      month: req.query.month ? month(req.query.month) : undefined,
      search: req.query.search ? String(req.query.search) : undefined,
      unapprovedOnly: req.query.unapproved === '1',
    }),
  ),
);

api.post('/transactions', h((req) => ({ id: saveTransaction(txnInput(req.body || {})) })));
api.put('/transactions/:id', h((req) => ({ id: saveTransaction(txnInput(req.body || {}), int(req.params.id)) })));
api.delete('/transactions/:id', h((req) => deleteTransaction(int(req.params.id))));

api.post('/transactions/:id/categorize', h((req) => categorizeTransaction(int(req.params.id), optInt(req.body?.categoryId))));
api.post('/transactions/:id/undo-categorize', h((req) => undoCategorize(int(req.params.id), req.body?.undo ?? {})));

api.post(
  '/transactions/bulk',
  h((req) => {
    const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map((x: unknown) => int(x));
    const action = String(req.body?.action);
    db.transaction(() => {
      for (const id of ids) {
        const row = db.prepare(`SELECT * FROM transactions WHERE id = ?`).get(id) as any;
        if (!row) continue;
        switch (action) {
          case 'approve':
            // Spending that still needs a category stays in review until it has one.
            if (needsCategory(id)) break;
            db.prepare(`UPDATE transactions SET approved = 1 WHERE id = ?`).run(id);
            if (row.category_id && row.payee_id) {
              db.prepare(`UPDATE payees SET last_category_id = ? WHERE id = ? AND ? != ?`).run(row.category_id, row.payee_id, row.category_id, rtaCategoryId());
            }
            break;
          case 'reject-match':
            // Undo an automatic match: split the bank's record back out as its own transaction.
            if (row.matched && row.import_id) {
              db.prepare(
                `INSERT INTO transactions (account_id, date, amount, payee_id, memo, cleared, approved, import_id, imported_payee)
                 VALUES (?, ?, ?, ?, '', 'cleared', 0, ?, ?)`,
              ).run(row.account_id, row.date, row.amount, payeeIdByName(row.imported_payee || 'Unknown'), row.import_id + ':unmatched', row.imported_payee);
              db.prepare(`UPDATE transactions SET import_id = NULL, matched = 0, approved = 1, imported_payee = NULL WHERE id = ?`).run(id);
            }
            break;
          case 'delete':
            deleteTransaction(id);
            break;
          case 'separate-transfer':
            separateTransfer(id);
            break;
          case 'categorize': {
            const cat = optInt(req.body?.categoryId);
            const acct = getAccount(row.account_id)!;
            if (row.is_split || !acct.on_budget) continue;
            if (row.transfer_account_id) {
              const other = getAccount(row.transfer_account_id);
              if (other?.on_budget) continue;
            }
            if (cat) {
              const c = db.prepare(`SELECT kind FROM categories WHERE id = ?`).get(cat) as { kind: string } | undefined;
              if (!c || c.kind === 'cc_payment') throw new HttpError(400, 'Invalid category');
            }
            db.prepare(`UPDATE transactions SET category_id = ? WHERE id = ?`).run(cat, id);
            break;
          }
          case 'clear':
            db.prepare(`UPDATE transactions SET cleared = 'cleared' WHERE id = ? AND cleared = 'uncleared'`).run(id);
            break;
          case 'unclear':
            db.prepare(`UPDATE transactions SET cleared = 'uncleared' WHERE id = ?`).run(id);
            break;
          case 'flag':
            db.prepare(`UPDATE transactions SET flag = ? WHERE id = ?`).run(req.body?.flag || null, id);
            break;
          default:
            throw new HttpError(400, 'Unknown bulk action');
        }
      }
    })();
  }),
);

// ---------------------------------------------------------------- budget

api.get(
  '/budget/:month',
  h((req) => {
    const view = monthView(month(req.params.month));
    return { ...view, plan: planStatus(view.month) };
  }),
);

// ---------------------------------------------------------------- monthly plan

api.get('/plan', h(() => getPlan()));
api.put('/plan', h((req) => savePlan({ income: req.body?.income, amounts: req.body?.amounts, percents: req.body?.percents })));
api.post('/plan/skip/:month', h((req) => skipPlan(month(req.params.month))));
api.get('/plan/preview/:month', h((req) => planPreview(month(req.params.month))));
api.post('/plan/apply/:month', h((req) => applyPlan(month(req.params.month), req.body?.again === true)));

function setAssigned(categoryId: number, m: Month, amount: number) {
  const cat = db.prepare(`SELECT kind FROM categories WHERE id = ?`).get(categoryId) as { kind: string } | undefined;
  if (!cat) throw new HttpError(404, 'Category not found');
  if (cat.kind === 'income') throw new HttpError(400, 'Cannot assign to the income category');
  if (!Number.isInteger(amount) || Math.abs(amount) > 1e13) throw new HttpError(400, 'Invalid amount');
  if (amount === 0) db.prepare(`DELETE FROM budget_amounts WHERE category_id = ? AND month = ?`).run(categoryId, m);
  else
    db.prepare(
      `INSERT INTO budget_amounts (category_id, month, assigned) VALUES (?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET assigned = excluded.assigned`,
    ).run(categoryId, m, amount);
}

function getAssigned(categoryId: number, m: Month): number {
  const r = db.prepare(`SELECT assigned FROM budget_amounts WHERE category_id = ? AND month = ?`).get(categoryId, m) as { assigned: number } | undefined;
  return r?.assigned ?? 0;
}

api.put(
  '/budget/:month/categories/:id',
  h((req) => {
    setAssigned(int(req.params.id), month(req.params.month), int(req.body?.assigned, 'amount'));
  }),
);

api.post(
  '/budget/:month/move',
  h((req) => {
    const m = month(req.params.month);
    const amount = int(req.body?.amount, 'amount');
    if (amount <= 0) throw new HttpError(400, 'Amount must be positive');
    const from = optInt(req.body?.fromId);
    const to = optInt(req.body?.toId);
    if (from === to) throw new HttpError(400, 'Choose two different categories');
    db.transaction(() => {
      if (from) setAssigned(from, m, getAssigned(from, m) - amount);
      if (to) setAssigned(to, m, getAssigned(to, m) + amount);
    })();
  }),
);

export const AUTO_ASSIGN_MODES = [
  'underfunded',
  'assigned_last_month',
  'spent_last_month',
  'average_assigned',
  'average_spent',
  'reset_available',
  'reset_assigned',
] as const;

api.post(
  '/budget/:month/auto-assign',
  h((req) => {
    const m = month(req.params.month);
    const mode = String(req.body?.mode);
    if (!(AUTO_ASSIGN_MODES as readonly string[]).includes(mode)) throw new HttpError(400, 'Unknown auto-assign mode');
    const comp = compute(m);
    const cur = comp.state.get(m) ?? new Map();
    const requested: number[] | null = Array.isArray(req.body?.categoryIds) ? req.body.categoryIds.map((x: unknown) => int(x)) : null;
    const cats = comp.categories.filter(
      (c) => c.kind !== 'income' && (requested ? requested.includes(c.id) : !c.hidden),
    );
    const history = (catId: number, n: number) => {
      const out: { assigned: number; activity: number }[] = [];
      for (let i = 1; i <= n; i++) {
        const pm = addMonths(m, -i);
        if (pm < comp.firstMonth) break;
        out.push(comp.state.get(pm)?.get(catId) ?? emptyState());
      }
      return out;
    };
    let changed = 0;
    db.transaction(() => {
      for (const c of cats) {
        const s = cur.get(c.id) ?? emptyState();
        let next = s.assigned;
        switch (mode) {
          case 'underfunded': {
            const t = targetStatus(c, s, m);
            if (t) next = s.assigned + t.underfunded;
            break;
          }
          case 'assigned_last_month':
            next = history(c.id, 1)[0]?.assigned ?? 0;
            break;
          case 'spent_last_month':
            next = Math.max(0, -(history(c.id, 1)[0]?.activity ?? 0));
            break;
          case 'average_assigned': {
            const hst = history(c.id, 12);
            next = hst.length ? Math.round(hst.reduce((x, y) => x + y.assigned, 0) / hst.length) : 0;
            break;
          }
          case 'average_spent': {
            const hst = history(c.id, 12);
            next = hst.length ? Math.max(0, Math.round(hst.reduce((x, y) => x - y.activity, 0) / hst.length)) : 0;
            break;
          }
          case 'reset_available':
            next = s.assigned - s.available;
            break;
          case 'reset_assigned':
            next = 0;
            break;
        }
        if (next !== s.assigned) {
          setAssigned(c.id, m, next);
          changed++;
        }
      }
    })();
    return { changed };
  }),
);

// ---------------------------------------------------------------- categories

api.post(
  '/category-groups',
  h((req) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Name required');
    const s = (db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM category_groups`).get() as { s: number }).s;
    return { id: Number(db.prepare(`INSERT INTO category_groups (name, sort) VALUES (?, ?)`).run(name, s).lastInsertRowid) };
  }),
);

api.put(
  '/category-groups/:id',
  h((req) => {
    const id = int(req.params.id);
    const g = db.prepare(`SELECT * FROM category_groups WHERE id = ?`).get(id) as any;
    if (!g) throw new HttpError(404, 'Group not found');
    if (g.system === 'internal') throw new HttpError(400, 'This group cannot be changed');
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw new HttpError(400, 'Name required');
      db.prepare(`UPDATE category_groups SET name = ? WHERE id = ?`).run(name, id);
    }
    if (req.body?.hidden !== undefined) db.prepare(`UPDATE category_groups SET hidden = ? WHERE id = ?`).run(req.body.hidden ? 1 : 0, id);
  }),
);

function reassignAndDeleteCategory(id: number, reassignTo: number | null) {
  const cat = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id) as any;
  if (!cat) throw new HttpError(404, 'Category not found');
  if (cat.kind !== 'normal') throw new HttpError(400, 'System categories cannot be deleted');
  if (reassignTo !== null) {
    const target = db.prepare(`SELECT kind FROM categories WHERE id = ?`).get(reassignTo) as any;
    if (!target || target.kind === 'cc_payment' || reassignTo === id) throw new HttpError(400, 'Invalid category to reassign to');
    db.prepare(`UPDATE transactions SET category_id = ? WHERE category_id = ?`).run(reassignTo, id);
    db.prepare(`UPDATE subtransactions SET category_id = ? WHERE category_id = ?`).run(reassignTo, id);
    db.prepare(`UPDATE scheduled SET category_id = ? WHERE category_id = ?`).run(reassignTo, id);
    if (target.kind !== 'income') {
      const rows = db.prepare(`SELECT month, assigned FROM budget_amounts WHERE category_id = ?`).all(id) as any[];
      for (const r of rows) {
        db.prepare(
          `INSERT INTO budget_amounts (category_id, month, assigned) VALUES (?, ?, ?) ON CONFLICT(category_id, month) DO UPDATE SET assigned = assigned + excluded.assigned`,
        ).run(reassignTo, r.month, r.assigned);
      }
    }
  }
  db.prepare(`DELETE FROM categories WHERE id = ?`).run(id);
}

api.delete(
  '/category-groups/:id',
  h((req) => {
    const id = int(req.params.id);
    const g = db.prepare(`SELECT * FROM category_groups WHERE id = ?`).get(id) as any;
    if (!g) throw new HttpError(404, 'Group not found');
    if (g.system) throw new HttpError(400, 'This group cannot be deleted');
    const reassignTo = optInt(req.query.reassignTo);
    db.transaction(() => {
      const cats = db.prepare(`SELECT id FROM categories WHERE group_id = ?`).all(id) as { id: number }[];
      for (const c of cats) reassignAndDeleteCategory(c.id, reassignTo);
      db.prepare(`DELETE FROM category_groups WHERE id = ?`).run(id);
    })();
  }),
);

api.post(
  '/categories',
  h((req) => {
    const name = String(req.body?.name ?? '').trim();
    const groupId = int(req.body?.groupId, 'group');
    if (!name) throw new HttpError(400, 'Name required');
    const g = db.prepare(`SELECT system FROM category_groups WHERE id = ?`).get(groupId) as any;
    if (!g || g.system) throw new HttpError(400, 'Choose a regular category group');
    const s = (db.prepare(`SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM categories WHERE group_id = ?`).get(groupId) as { s: number }).s;
    return { id: Number(db.prepare(`INSERT INTO categories (group_id, name, sort) VALUES (?, ?, ?)`).run(groupId, name, s).lastInsertRowid) };
  }),
);

api.put(
  '/categories/:id',
  h((req) => {
    const id = int(req.params.id);
    const cat = db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id) as any;
    if (!cat) throw new HttpError(404, 'Category not found');
    if (cat.kind === 'income') throw new HttpError(400, 'This category cannot be changed');
    const b = req.body || {};
    if (b.name !== undefined && cat.kind === 'normal') {
      const name = String(b.name).trim();
      if (!name) throw new HttpError(400, 'Name required');
      db.prepare(`UPDATE categories SET name = ? WHERE id = ?`).run(name, id);
    }
    if (b.note !== undefined) db.prepare(`UPDATE categories SET note = ? WHERE id = ?`).run(String(b.note).slice(0, 2000), id);
    if (b.hidden !== undefined) db.prepare(`UPDATE categories SET hidden = ? WHERE id = ?`).run(b.hidden ? 1 : 0, id);
    if (b.groupId !== undefined && cat.kind === 'normal') {
      const g = db.prepare(`SELECT system FROM category_groups WHERE id = ?`).get(int(b.groupId)) as any;
      if (!g || g.system) throw new HttpError(400, 'Invalid group');
      db.prepare(`UPDATE categories SET group_id = ? WHERE id = ?`).run(int(b.groupId), id);
    }
    if (b.target !== undefined) {
      if (b.target === null) {
        db.prepare(`UPDATE categories SET target_type = NULL, target_amount = NULL, target_date = NULL WHERE id = ?`).run(id);
      } else {
        const t = b.target;
        if (!(TARGET_TYPES as readonly string[]).includes(t.type)) throw new HttpError(400, 'Invalid target type');
        const amount = int(t.amount, 'target amount');
        if (amount <= 0) throw new HttpError(400, 'Target amount must be positive');
        let date: string | null = null;
        if (t.type === 'by_date') {
          if (!isValidISODate(t.date)) throw new HttpError(400, 'Target date required');
          date = t.date;
        }
        db.prepare(`UPDATE categories SET target_type = ?, target_amount = ?, target_date = ? WHERE id = ?`).run(t.type, amount, date, id);
      }
    }
  }),
);

api.delete(
  '/categories/:id',
  h((req) => {
    db.transaction(() => reassignAndDeleteCategory(int(req.params.id), optInt(req.query.reassignTo)))();
  }),
);

api.post(
  '/categories/reorder',
  h((req) => {
    // body: { groups: [{ id, categoryIds: [] }] } in desired order
    const groups: any[] = Array.isArray(req.body?.groups) ? req.body.groups : [];
    db.transaction(() => {
      groups.forEach((g, gi) => {
        const gid = int(g.id);
        const grp = db.prepare(`SELECT system FROM category_groups WHERE id = ?`).get(gid) as any;
        if (!grp) return;
        if (!grp.system) db.prepare(`UPDATE category_groups SET sort = ? WHERE id = ?`).run(gi + 1, gid);
        (Array.isArray(g.categoryIds) ? g.categoryIds : []).forEach((cid: unknown, ci: number) => {
          const c = db.prepare(`SELECT kind, group_id FROM categories WHERE id = ?`).get(int(cid)) as any;
          if (!c) return;
          // Normal categories may move between regular groups; system categories only reorder within their own group.
          if (c.kind === 'normal' ? !!grp.system : c.group_id !== gid) throw new HttpError(400, 'That category cannot be moved to this group');
          db.prepare(`UPDATE categories SET group_id = ?, sort = ? WHERE id = ?`).run(gid, ci, int(cid));
        });
      });
    })();
  }),
);

// ---------------------------------------------------------------- payees & rules

api.get(
  '/payees',
  h(() =>
    db
      .prepare(
        `SELECT p.id, p.name, p.last_category_id AS lastCategoryId, c.name AS lastCategoryName,
          (SELECT COUNT(*) FROM transactions t WHERE t.payee_id = p.id) AS transactionCount
         FROM payees p LEFT JOIN categories c ON c.id = p.last_category_id ORDER BY p.name COLLATE NOCASE`,
      )
      .all(),
  ),
);

api.put(
  '/payees/:id',
  h((req) => {
    const id = int(req.params.id);
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'Name required');
    db.transaction(() => {
      const other = db.prepare(`SELECT id FROM payees WHERE name = ? COLLATE NOCASE AND id != ?`).get(name, id) as { id: number } | undefined;
      if (other) {
        // Renaming to an existing payee merges the two.
        db.prepare(`UPDATE transactions SET payee_id = ? WHERE payee_id = ?`).run(other.id, id);
        db.prepare(`UPDATE scheduled SET payee_id = ? WHERE payee_id = ?`).run(other.id, id);
        db.prepare(`UPDATE payee_rules SET payee_id = ? WHERE payee_id = ?`).run(other.id, id);
        db.prepare(`DELETE FROM payees WHERE id = ?`).run(id);
      } else {
        db.prepare(`UPDATE payees SET name = ? WHERE id = ?`).run(name, id);
      }
    })();
  }),
);

api.delete('/payees/:id', h((req) => void db.prepare(`DELETE FROM payees WHERE id = ?`).run(int(req.params.id))));

api.get(
  '/payee-rules',
  h(() =>
    db
      .prepare(
        `SELECT r.id, r.match_type AS matchType, r.match_text AS matchText, r.payee_id AS payeeId, p.name AS payeeName,
                r.category_id AS categoryId, c.name AS categoryName
         FROM payee_rules r JOIN payees p ON p.id = r.payee_id LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.id`,
      )
      .all(),
  ),
);

api.post(
  '/payee-rules',
  h((req) => {
    const b = req.body || {};
    if (!['contains', 'equals', 'starts_with'].includes(b.matchType)) throw new HttpError(400, 'Invalid match type');
    const text = String(b.matchText ?? '').trim();
    if (!text) throw new HttpError(400, 'Match text required');
    const payeeId = b.payeeId ? int(b.payeeId) : payeeIdByName(String(b.payeeName ?? ''));
    if (!payeeId) throw new HttpError(400, 'Payee required');
    const cat = optInt(b.categoryId);
    if (cat) {
      const c = db.prepare(`SELECT kind FROM categories WHERE id = ?`).get(cat) as any;
      if (!c || c.kind === 'cc_payment') throw new HttpError(400, 'Invalid category');
    }
    db.prepare(`INSERT INTO payee_rules (match_type, match_text, payee_id, category_id) VALUES (?, ?, ?, ?)`).run(b.matchType, text, payeeId, cat);
  }),
);

api.delete('/payee-rules/:id', h((req) => void db.prepare(`DELETE FROM payee_rules WHERE id = ?`).run(int(req.params.id))));

// ---------------------------------------------------------------- scheduled transactions

api.get(
  '/scheduled',
  h(() =>
    (
      db
        .prepare(
          `SELECT s.*, a.name AS account_name, p.name AS payee_name, c.name AS category_name, ta.name AS transfer_account_name
           FROM scheduled s JOIN accounts a ON a.id = s.account_id LEFT JOIN payees p ON p.id = s.payee_id
           LEFT JOIN categories c ON c.id = s.category_id LEFT JOIN accounts ta ON ta.id = s.transfer_account_id
           ORDER BY s.next_date, s.id`,
        )
        .all() as any[]
    ).map((s) => ({
      id: s.id,
      accountId: s.account_id,
      accountName: s.account_name,
      nextDate: s.next_date,
      frequency: s.frequency,
      amount: s.amount,
      payeeId: s.payee_id,
      payeeName: s.payee_name,
      categoryId: s.category_id,
      categoryName: s.category_name,
      transferAccountId: s.transfer_account_id,
      transferAccountName: s.transfer_account_name,
      memo: s.memo,
      flag: s.flag,
    })),
  ),
);

function scheduledFields(b: any) {
  const accountId = int(b.accountId, 'account');
  if (!getAccount(accountId)) throw new HttpError(400, 'Account not found');
  if (!isValidISODate(b.date)) throw new HttpError(400, 'Invalid date');
  if (!(FREQUENCIES as readonly string[]).includes(b.frequency)) throw new HttpError(400, 'Invalid frequency');
  const transferAccountId = optInt(b.transferAccountId);
  if (transferAccountId && (transferAccountId === accountId || !getAccount(transferAccountId))) throw new HttpError(400, 'Invalid transfer account');
  const categoryId = optInt(b.categoryId);
  if (categoryId) {
    const c = db.prepare(`SELECT kind FROM categories WHERE id = ?`).get(categoryId) as any;
    if (!c || c.kind === 'cc_payment') throw new HttpError(400, 'Invalid category');
  }
  return {
    account_id: accountId,
    next_date: b.date as string,
    anchor_day: Number(String(b.date).slice(8, 10)),
    frequency: b.frequency as Frequency,
    amount: int(b.amount, 'amount'),
    payee_id: transferAccountId ? null : b.payeeId ? int(b.payeeId) : b.payeeName ? payeeIdByName(String(b.payeeName)) : null,
    category_id: categoryId,
    transfer_account_id: transferAccountId,
    memo: String(b.memo ?? '').slice(0, 500),
    flag: b.flag || null,
  };
}

api.post(
  '/scheduled',
  h((req) => {
    const f = scheduledFields(req.body || {});
    const id = Number(
      db
        .prepare(
          `INSERT INTO scheduled (account_id, next_date, anchor_day, frequency, amount, payee_id, category_id, transfer_account_id, memo, flag)
           VALUES (@account_id, @next_date, @anchor_day, @frequency, @amount, @payee_id, @category_id, @transfer_account_id, @memo, @flag)`,
        )
        .run(f).lastInsertRowid,
    );
    enterDueScheduled();
    return { id };
  }),
);

api.put(
  '/scheduled/:id',
  h((req) => {
    const f = scheduledFields(req.body || {});
    db.prepare(
      `UPDATE scheduled SET account_id=@account_id, next_date=@next_date, anchor_day=@anchor_day, frequency=@frequency, amount=@amount,
       payee_id=@payee_id, category_id=@category_id, transfer_account_id=@transfer_account_id, memo=@memo, flag=@flag WHERE id=@id`,
    ).run({ ...f, id: int(req.params.id) });
    enterDueScheduled();
  }),
);

api.delete('/scheduled/:id', h((req) => void db.prepare(`DELETE FROM scheduled WHERE id = ?`).run(int(req.params.id))));

api.post(
  '/scheduled/:id/enter-now',
  h((req) => {
    const s = db.prepare(`SELECT * FROM scheduled WHERE id = ?`).get(int(req.params.id)) as any;
    if (!s) throw new HttpError(404, 'Not found');
    db.transaction(() => {
      saveTransaction({
        accountId: s.account_id,
        date: todayISO(),
        amount: s.amount,
        payeeId: s.payee_id,
        transferAccountId: s.transfer_account_id,
        categoryId: s.category_id,
        memo: s.memo,
        flag: s.flag,
      });
      const next = nextOccurrence(s.next_date, s.frequency, s.anchor_day);
      if (next) db.prepare(`UPDATE scheduled SET next_date = ? WHERE id = ?`).run(next, s.id);
      else db.prepare(`DELETE FROM scheduled WHERE id = ?`).run(s.id);
    })();
  }),
);

api.post(
  '/scheduled/:id/skip',
  h((req) => {
    const s = db.prepare(`SELECT * FROM scheduled WHERE id = ?`).get(int(req.params.id)) as any;
    if (!s) throw new HttpError(404, 'Not found');
    const next = nextOccurrence(s.next_date, s.frequency, s.anchor_day);
    if (next) db.prepare(`UPDATE scheduled SET next_date = ? WHERE id = ?`).run(next, s.id);
    else db.prepare(`DELETE FROM scheduled WHERE id = ?`).run(s.id);
  }),
);

// ---------------------------------------------------------------- reports

function rangeParams(req: Request): { from: Month; to: Month } {
  const to = req.query.to ? month(req.query.to) : currentMonth();
  const from = req.query.from ? month(req.query.from) : addMonths(to, -11);
  return { from, to };
}

const CATEGORY_ACTIVITY_SQL = `
  SELECT c.category_id, substr(c.date,1,7) AS month, SUM(c.amount) AS total
  FROM (
    SELECT account_id, date, amount, category_id FROM transactions WHERE is_split = 0 AND category_id IS NOT NULL
    UNION ALL
    SELECT t.account_id, t.date, s.amount, s.category_id FROM subtransactions s JOIN transactions t ON t.id = s.transaction_id WHERE s.category_id IS NOT NULL
  ) c JOIN accounts a ON a.id = c.account_id
  WHERE a.on_budget = 1 AND substr(c.date,1,7) BETWEEN ? AND ?
  GROUP BY c.category_id, month`;

api.get('/reports/insights', h(() => insights()));

api.get(
  '/reports/spending',
  h((req) => {
    const { from, to } = rangeParams(req);
    const rows = db.prepare(CATEGORY_ACTIVITY_SQL).all(from, to) as { category_id: number; month: string; total: number }[];
    const cats = db
      .prepare(`SELECT c.id, c.name, c.kind, g.name AS group_name, g.id AS group_id FROM categories c JOIN category_groups g ON g.id = c.group_id`)
      .all() as any[];
    const byId = new Map(cats.map((c) => [c.id, c]));
    return {
      from,
      to,
      rows: rows
        .filter((r) => byId.get(r.category_id)?.kind === 'normal')
        .map((r) => {
          const c = byId.get(r.category_id);
          return { categoryId: r.category_id, categoryName: c.name, groupId: c.group_id, groupName: c.group_name, month: r.month, spent: -r.total };
        }),
    };
  }),
);

api.get(
  '/reports/income-expense',
  h((req) => {
    const { from, to } = rangeParams(req);
    const income = db
      .prepare(
        `SELECT COALESCE(p.name, 'Other') AS payee, substr(t.date,1,7) AS month, SUM(t.amount) AS total
         FROM transactions t JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = t.category_id LEFT JOIN payees p ON p.id = t.payee_id
         WHERE a.on_budget = 1 AND c.kind = 'income' AND t.is_split = 0 AND substr(t.date,1,7) BETWEEN ? AND ?
           AND COALESCE(p.name,'') NOT IN ('Starting Balance', 'Reconciliation Balance Adjustment')
         GROUP BY payee, month
         UNION ALL
         SELECT COALESCE(p.name, 'Other'), substr(t.date,1,7), SUM(s.amount)
         FROM subtransactions s JOIN transactions t ON t.id = s.transaction_id JOIN accounts a ON a.id = t.account_id
         JOIN categories c ON c.id = s.category_id LEFT JOIN payees p ON p.id = t.payee_id
         WHERE a.on_budget = 1 AND c.kind = 'income' AND substr(t.date,1,7) BETWEEN ? AND ?
         GROUP BY 1, 2`,
      )
      .all(from, to, from, to);
    const rows = db.prepare(CATEGORY_ACTIVITY_SQL).all(from, to) as { category_id: number; month: string; total: number }[];
    const cats = db
      .prepare(`SELECT c.id, c.name, c.kind, g.name AS group_name FROM categories c JOIN category_groups g ON g.id = c.group_id`)
      .all() as any[];
    const byId = new Map(cats.map((c) => [c.id, c]));
    const expenses = rows
      .filter((r) => byId.get(r.category_id)?.kind === 'normal')
      .map((r) => ({ categoryName: byId.get(r.category_id).name, groupName: byId.get(r.category_id).group_name, month: r.month, total: r.total }));
    return { from, to, income, expenses };
  }),
);

api.get(
  '/reports/net-worth',
  h((req) => {
    const { from, to } = rangeParams(req);
    const rows = db
      .prepare(`SELECT account_id, substr(date,1,7) AS month, SUM(amount) AS total FROM transactions GROUP BY account_id, month ORDER BY month`)
      .all() as { account_id: number; month: string; total: number }[];
    const balances = new Map<number, number>();
    const out: { month: string; assets: number; debts: number; netWorth: number }[] = [];
    let i = 0;
    const start = rows.length && rows[0].month < from ? rows[0].month : from;
    for (let m = start; m <= to; m = addMonths(m, 1)) {
      while (i < rows.length && rows[i].month <= m) {
        balances.set(rows[i].account_id, (balances.get(rows[i].account_id) ?? 0) + rows[i].total);
        i++;
      }
      if (m < from) continue;
      let assets = 0;
      let debts = 0;
      for (const v of balances.values()) {
        if (v >= 0) assets += v;
        else debts += v;
      }
      out.push({ month: m, assets, debts, netWorth: assets + debts });
    }
    return { from, to, months: out };
  }),
);

// ---------------------------------------------------------------- bank connections

api.get(
  '/connections',
  h(() => ({ plaid: { configured: plaidConfig().configured, env: plaidConfig().env }, connections: listConnections() })),
);
api.post('/plaid/link-token', h(async (req) => ({ linkToken: await plaidLinkToken(optInt(req.body?.connectionId) ?? undefined) })));
api.post(
  '/plaid/exchange',
  h(async (req) => {
    const token = String(req.body?.publicToken ?? '');
    if (!token) throw new HttpError(400, 'Missing public token');
    return { connectionId: await plaidExchange(token, String(req.body?.institution ?? '')) };
  }),
);
api.post(
  '/plaid/reauthed/:id',
  h(async (req) => {
    const id = int(req.params.id);
    db.prepare(`UPDATE connections SET status = 'ok', error = NULL WHERE id = ?`).run(id);
    return await syncConnection(id);
  }),
);
api.post(
  '/simplefin/claim',
  h(async (req) => {
    const token = String(req.body?.token ?? '');
    if (!token.trim()) throw new HttpError(400, 'Paste your SimpleFIN Setup Token');
    return { connectionId: await simplefinClaim(token) };
  }),
);
api.post('/connections/:id/map', h(async (req) => mapAccounts(int(req.params.id), Array.isArray(req.body?.mappings) ? req.body.mappings : [])));
api.post('/connections/:id/sync', h(async (req) => syncConnection(int(req.params.id))));
api.post('/connections/sync-all', h(async () => syncAll()));

// ---------------------------------------------------------------- Amazon extension

api.get('/amazon', h(() => amazonStatus()));
api.post('/amazon/token', h(() => ({ token: newAmazonToken() })));
api.delete('/amazon/token', h(() => revokeAmazonToken()));

// ---------------------------------------------------------------- push notifications

api.get('/push', h(() => pushStatus()));
api.post(
  '/push/subscribe',
  h((req) => subscribe(req.body?.subscription, String(req.body?.label ?? ''), req.get('origin') ?? undefined)),
);
api.post('/push/unsubscribe', h((req) => unsubscribe(String(req.body?.endpoint ?? ''))));
api.delete('/push/devices/:id', h((req) => removeDevice(int(req.params.id))));
api.post(
  '/push/test',
  h(async (req) => {
    const sent = await sendToAll(
      { title: 'Mani notifications are on', body: "You'll get a note here whenever new transactions come in from your bank.", url: '/review', tag: 'test' },
      req.body?.endpoint ? String(req.body.endpoint) : undefined,
    );
    if (!sent) throw new HttpError(502, "The notification couldn't be delivered. Turn notifications off and on again on this device.");
    return { sent };
  }),
);
api.delete('/connections/:id', h(async (req) => deleteConnection(int(req.params.id))));

// ---------------------------------------------------------------- export / backup

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  // A payee or memo starting with = + - @ would be run as a formula by Excel/Sheets; a leading apostrophe makes it text.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

api.get('/export/transactions.csv', (req, res) => {
  const txns = listTransactions({});
  const lines = [['Account', 'Date', 'Payee', 'Category', 'Memo', 'Outflow', 'Inflow', 'Cleared', 'Flag'].join(',')];
  const fmt = (c: number) => (c / 100).toFixed(2);
  for (const t of txns.reverse()) {
    const payee = t.transferAccountName ? `Transfer : ${t.transferAccountName}` : t.payeeName ?? '';
    const parts = t.isSplit
      ? t.subtransactions.map((s: any) => ({ amount: s.amount, cat: s.categoryName ?? '', memo: s.memo || t.memo }))
      : [{ amount: t.amount, cat: t.categoryName ?? t.counterpartCategoryName ?? '', memo: t.memo }];
    for (const p of parts) {
      lines.push(
        [t.accountName, t.date, payee, p.cat, p.memo, p.amount < 0 ? fmt(-p.amount) : '', p.amount > 0 ? fmt(p.amount) : '', t.cleared, t.flag ?? '']
          .map(csvCell)
          .join(','),
      );
    }
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="transactions-${todayISO()}.csv"`);
  res.send(lines.join('\n'));
});

api.get('/export/backup.db', async (req, res, next) => {
  // A private folder (only this user can open it), not a guessable name in the shared temp folder.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mani-backup-'));
  const tmp = path.join(dir, 'backup.db');
  const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
  try {
    await db.backup(tmp);
    // The copy is for restoring your budget, not your logins: signed-in sessions are left out.
    const copy = new Database(tmp);
    copy.exec('DELETE FROM sessions; VACUUM;');
    copy.close();
    res.setHeader('Cache-Control', 'no-store');
    res.download(tmp, `budget-backup-${todayISO()}.db`, cleanup);
  } catch (e) {
    cleanup();
    next(e);
  }
});

// ---------------------------------------------------------------- errors

api.use((req, res) => res.status(404).json({ error: 'Not found' }));

api.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  const e = err as Error & { type?: string };
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Check the server logs.' });
});

