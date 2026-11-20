import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try {
  // Your budget and bank connection details live here: keep other accounts on this computer out.
  fs.chmodSync(DATA_DIR, 0o700);
} catch {
  // Some file systems (Windows drives, certain Docker mounts) don't support this; nothing to do.
}

export const DB_PATH = path.join(DATA_DIR, process.env.DB_FILE || 'budget.db');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('plaid','simplefin')),
  institution TEXT NOT NULL DEFAULT '',
  item_id TEXT,
  secret_enc TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_sync_at TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  on_budget INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_reconciled_at TEXT,
  connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
  external_id TEXT,
  import_start TEXT,
  last_import_at TEXT,
  bank_balance INTEGER
);

CREATE TABLE IF NOT EXISTS external_accounts (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mask TEXT,
  kind TEXT,
  subtype TEXT,
  balance INTEGER,
  UNIQUE(connection_id, external_id)
);

CREATE TABLE IF NOT EXISTS category_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  system TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES category_groups(id),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  hidden INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('normal','income','cc_payment')),
  linked_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  target_type TEXT,
  target_amount INTEGER,
  target_date TEXT
);

CREATE TABLE IF NOT EXISTS budget_amounts (
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  assigned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (category_id, month)
);

CREATE TABLE IF NOT EXISTS payees (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  last_category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS payee_rules (
  id INTEGER PRIMARY KEY,
  match_type TEXT NOT NULL CHECK (match_type IN ('contains','equals','starts_with')),
  match_text TEXT NOT NULL,
  payee_id INTEGER NOT NULL REFERENCES payees(id) ON DELETE CASCADE,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payee_id INTEGER REFERENCES payees(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  memo TEXT NOT NULL DEFAULT '',
  cleared TEXT NOT NULL DEFAULT 'uncleared' CHECK (cleared IN ('uncleared','cleared','reconciled')),
  approved INTEGER NOT NULL DEFAULT 1,
  flag TEXT,
  transfer_account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
  transfer_txn_id INTEGER,
  is_split INTEGER NOT NULL DEFAULT 0,
  import_id TEXT,
  imported_payee TEXT,
  matched INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_txn_account_date ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS idx_txn_category ON transactions(category_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_import ON transactions(account_id, import_id) WHERE import_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subtransactions (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  memo TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sub_txn ON subtransactions(transaction_id);

CREATE TABLE IF NOT EXISTS scheduled (
  id INTEGER PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  next_date TEXT NOT NULL,
  anchor_day INTEGER NOT NULL,
  frequency TEXT NOT NULL,
  amount INTEGER NOT NULL,
  payee_id INTEGER REFERENCES payees(id) ON DELETE SET NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  transfer_account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
  memo TEXT NOT NULL DEFAULT '',
  flag TEXT
);
`;

db.exec(SCHEMA);

// Additive migrations for databases created by earlier versions.
function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
// For bank-linked accounts created by the app: the starting-balance transaction is kept in step with the bank
// balance until the bank has delivered all history (Plaid fetches it in the background after linking).
addColumn('accounts', 'opening_txn_id', 'INTEGER');
addColumn('accounts', 'opening_auto', 'INTEGER NOT NULL DEFAULT 0');
// Monthly plan: a fixed amount per category, assigned in one click each month (see plan.ts).
addColumn('categories', 'plan_amount', 'INTEGER NOT NULL DEFAULT 0');
// When set, the plan amount is this share of the monthly income instead, in hundredths of a percent (1000 = 10%).
addColumn('categories', 'plan_percent', 'INTEGER');
// Transfers joined automatically from two imported halves (see transfers.ts); no_auto_transfer marks halves the user
// separated again, so they are never re-joined.
addColumn('transactions', 'auto_transfer', 'INTEGER NOT NULL DEFAULT 0');
addColumn('transactions', 'no_auto_transfer', 'INTEGER NOT NULL DEFAULT 0');
// Amazon order details sent by the Mani Amazon extension (see amazon.ts).
db.exec(`CREATE TABLE IF NOT EXISTS amazon_orders (
  order_id TEXT PRIMARY KEY,
  order_date TEXT,
  items TEXT NOT NULL DEFAULT '[]',
  fetched_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS amazon_charges (
  id INTEGER PRIMARY KEY,
  order_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,
  last4 TEXT,
  txn_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  UNIQUE(order_id, date, amount)
)`);
// Order totals from Amazon's order list, and charges Mani worked out from them (estimated = 1) for orders Amazon's
// payments page no longer shows.
addColumn('amazon_orders', 'total', 'INTEGER');
addColumn('amazon_charges', 'estimated', 'INTEGER NOT NULL DEFAULT 0');
// Devices that asked for push notifications (see push.ts).
db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_ok_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS plan_applied (month TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);

export const SYSTEM_GROUP_INTERNAL = 'internal';
export const SYSTEM_GROUP_CC = 'credit_card_payments';

function seed() {
  const has = db.prepare(`SELECT id FROM category_groups WHERE system = ?`).get(SYSTEM_GROUP_INTERNAL);
  if (has) return;
  const tx = db.transaction(() => {
    const internal = db
      .prepare(`INSERT INTO category_groups (name, sort, hidden, system) VALUES ('Inflow', -100, 1, ?)`)
      .run(SYSTEM_GROUP_INTERNAL).lastInsertRowid;
    db.prepare(`INSERT INTO categories (group_id, name, kind) VALUES (?, 'Inflow: Ready to Assign', 'income')`).run(internal);
    db.prepare(`INSERT INTO category_groups (name, sort, system) VALUES ('Credit Card Payments', -50, ?)`).run(SYSTEM_GROUP_CC);

    // A sensible starter category list, Users can rename/delete freely.
    const starter: [string, string[]][] = [
      ['Bills', ['Rent/Mortgage', 'Electric', 'Water', 'Internet', 'Phone', 'Insurance']],
      ['Needs', ['Groceries', 'Transportation', 'Medical']],
      ['Wants', ['Dining Out', 'Entertainment', 'Shopping', 'Subscriptions']],
      ['Savings Goals', ['Emergency Fund', 'Vacation', 'Car Replacement']],
    ];
    starter.forEach(([group, cats], gi) => {
      const gid = db.prepare(`INSERT INTO category_groups (name, sort) VALUES (?, ?)`).run(group, gi + 1).lastInsertRowid;
      cats.forEach((c, ci) => db.prepare(`INSERT INTO categories (group_id, name, sort) VALUES (?, ?, ?)`).run(gid, c, ci));
    });
    db.prepare(`INSERT OR IGNORE INTO payees (name) VALUES ('Starting Balance'), ('Reconciliation Balance Adjustment')`).run();
  });
  tx();
}
seed();

export function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function rtaCategoryId(): number {
  const row = db.prepare(`SELECT id FROM categories WHERE kind = 'income' LIMIT 1`).get() as { id: number };
  return row.id;
}

export function ccGroupId(): number {
  const row = db.prepare(`SELECT id FROM category_groups WHERE system = ?`).get(SYSTEM_GROUP_CC) as { id: number };
  return row.id;
}

export function payeeIdByName(name: string, create = true): number | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const row = db.prepare(`SELECT id FROM payees WHERE name = ? COLLATE NOCASE`).get(trimmed) as { id: number } | undefined;
  if (row) return row.id;
  if (!create) return null;
  return Number(db.prepare(`INSERT INTO payees (name) VALUES (?)`).run(trimmed).lastInsertRowid);
}

export interface AccountRow {
  id: number;
  name: string;
  type: string;
  on_budget: number;
  closed: number;
  note: string;
  sort: number;
  created_at: string;
  last_reconciled_at: string | null;
  connection_id: number | null;
  external_id: string | null;
  import_start: string | null;
  last_import_at: string | null;
  bank_balance: number | null;
  opening_txn_id: number | null;
  opening_auto: number;
}

export function getAccount(id: number): AccountRow | undefined {
  return db.prepare(`SELECT * FROM accounts WHERE id = ?`).get(id) as AccountRow | undefined;
}
