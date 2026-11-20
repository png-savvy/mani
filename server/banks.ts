import { db, getAccount, getSetting } from './db.ts';
import { decrypt, encrypt } from './security.ts';
import { HttpError, createStartingBalance, importTransactions, removeImported, startingBalanceCategory, type ImportItem } from './txns.ts';
import { createAccount } from './accounts.ts';
import { detectTransfers } from './transfers.ts';
import { matchAmazon } from './amazon.ts';
import { notifyNewTransactions } from './push.ts';
import { addDays, decimalToCents, formatISODate, isValidISODate, todayISO, type ISODate } from '../shared/util.ts';

// =====================================================================================
// Plaid  (https://plaid.com/docs/api/) — a widely used US bank aggregator.
// =====================================================================================

export function plaidConfig() {
  const clientId = process.env.PLAID_CLIENT_ID || '';
  const secret = process.env.PLAID_SECRET || '';
  const env = (process.env.PLAID_ENV || 'sandbox').toLowerCase();
  return {
    configured: !!(clientId && secret),
    clientId,
    secret,
    env,
    baseUrl: `https://${env === 'production' ? 'production' : 'sandbox'}.plaid.com`,
    countryCodes: (process.env.PLAID_COUNTRY_CODES || 'US').split(',').map((s) => s.trim().toUpperCase()),
    redirectUri: process.env.PLAID_REDIRECT_URI || '',
  };
}

class PlaidError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Every bank request gets a deadline: a hung connection must fail (and be retried) rather than block all later syncs. */
const REQUEST_TIMEOUT_MS = 30000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function plaidPost<T = any>(path: string, body: Record<string, unknown>): Promise<T> {
  const cfg = plaidConfig();
  if (!cfg.configured) throw new HttpError(400, 'Plaid is not configured. Set PLAID_CLIENT_ID and PLAID_SECRET (see README).');
  // Everything we send Plaid is safe to repeat, so ride out network blips, rate limits and Plaid-side errors.
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= 3;
    let res: Response;
    try {
      res = await fetch(cfg.baseUrl + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: cfg.clientId, secret: cfg.secret, ...body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      if (last) throw new PlaidError('NETWORK_ERROR', `Could not reach Plaid: ${(e as Error).message}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const json = (await res.json().catch(() => ({}))) as any;
    if (res.ok) return json as T;
    if ((res.status === 429 || res.status >= 500) && !last) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    throw new PlaidError(json.error_code || 'PLAID_ERROR', json.display_message || json.error_message || `Plaid error ${res.status}`);
  }
}

export async function plaidLinkToken(connectionId?: number): Promise<string> {
  const cfg = plaidConfig();
  const body: Record<string, unknown> = {
    client_name: 'Mani',
    language: 'en',
    country_codes: cfg.countryCodes,
    // Internal Plaid user id; kept from the app's original name so existing connections stay consistent.
    user: { client_user_id: 'allot-owner' },
  };
  if (cfg.redirectUri) body.redirect_uri = cfg.redirectUri;
  if (connectionId) {
    // Update mode: lets the user re-enter credentials / MFA for a broken connection.
    const conn = getConnection(connectionId);
    body.access_token = decrypt(conn.secret_enc);
  } else {
    body.products = ['transactions'];
    body.transactions = { days_requested: 730 };
  }
  const r = await plaidPost<{ link_token: string }>('/link/token/create', body);
  return r.link_token;
}

export async function plaidExchange(publicToken: string, institution: string): Promise<number> {
  const r = await plaidPost<{ access_token: string; item_id: string }>('/item/public_token/exchange', { public_token: publicToken });
  const existing = db.prepare(`SELECT id FROM connections WHERE provider = 'plaid' AND item_id = ?`).get(r.item_id) as { id: number } | undefined;
  let id: number;
  if (existing) {
    id = existing.id;
    // A cursor belongs to the access token it was issued for; start over (imports are deduplicated by id).
    db.prepare(`UPDATE connections SET secret_enc = ?, cursor = NULL, status = 'ok', error = NULL WHERE id = ?`).run(encrypt(r.access_token), id);
  } else {
    id = Number(
      db
        .prepare(`INSERT INTO connections (provider, institution, item_id, secret_enc) VALUES ('plaid', ?, ?, ?)`)
        .run(institution || 'Bank', r.item_id, encrypt(r.access_token)).lastInsertRowid,
    );
  }
  await refreshPlaidAccounts(id);
  return id;
}

function plaidSignedBalance(a: any): number | null {
  const cur = a.balances?.current;
  if (cur === null || cur === undefined) return null;
  const cents = decimalToCents(String(cur));
  // Plaid reports credit and loan balances as a positive amount owed.
  return a.type === 'credit' || a.type === 'loan' ? -cents : cents;
}

async function refreshPlaidAccounts(connId: number) {
  const conn = getConnection(connId);
  const r = await plaidPost<{ accounts: any[] }>('/accounts/get', { access_token: decrypt(conn.secret_enc) });
  for (const a of r.accounts) {
    upsertExternal(connId, a.account_id, a.name || a.official_name || 'Account', a.mask ?? null, a.type, a.subtype ?? null, plaidSignedBalance(a));
  }
}

async function syncPlaid(connId: number) {
  const conn = getConnection(connId);
  const accessToken = decrypt(conn.secret_enc);
  let startCursor = conn.cursor || undefined;
  let added: any[] = [];
  let modified: any[] = [];
  let removed: any[] = [];
  let cursor = startCursor;
  let updateStatus: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    added = [];
    modified = [];
    removed = [];
    cursor = startCursor;
    try {
      let hasMore = true;
      while (hasMore) {
        const page: any = await plaidPost('/transactions/sync', { access_token: accessToken, cursor, count: 500 });
        added.push(...page.added);
        modified.push(...page.modified);
        removed.push(...page.removed);
        hasMore = page.has_more;
        updateStatus = page.transactions_update_status;
        cursor = page.next_cursor;
      }
      break;
    } catch (e) {
      // Plaid asks clients to restart pagination from the original cursor in this case.
      if (e instanceof PlaidError && e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < 2) continue;
      // A cursor Plaid no longer accepts would otherwise fail forever. Start over from the beginning instead:
      // imports are deduplicated by transaction id, so nothing is doubled and nothing is lost.
      if (e instanceof PlaidError && startCursor && /cursor/i.test(e.message) && attempt < 2) {
        startCursor = undefined;
        continue;
      }
      throw e;
    }
  }

  const mapped = linkedAccounts(connId);
  const byExternal = new Map(mapped.map((a) => [a.external_id!, a.id]));
  const items = new Map<number, ImportItem[]>();
  // "Modified" transactions go through the import path too: one we don't have yet (e.g. it was still pending the first
  // time we saw it) must be added, not dropped. Ones we already have are skipped there and updated below.
  for (const t of [...added, ...modified]) {
    if (t.pending) continue; // Only import posted transactions; pending ones come back as posted later.
    const local = byExternal.get(t.account_id);
    if (!local) continue;
    if (!items.has(local)) items.set(local, []);
    items.get(local)!.push({
      importId: `plaid:${t.transaction_id}`,
      date: t.date,
      amount: -decimalToCents(String(t.amount)), // Plaid: positive = money out
      payeeName: t.merchant_name || t.name || 'Unknown',
    });
  }
  const totals = { imported: 0, matched: 0, skipped: 0, newIds: [] as number[] };
  for (const [acctId, list] of items) {
    const r = importTransactions(acctId, list);
    totals.newIds.push(...r.newIds);
    totals.imported += r.imported;
    totals.matched += r.matched;
    totals.skipped += r.skipped;
  }
  for (const t of modified) {
    const local = byExternal.get(t.account_id);
    if (!local || t.pending) continue;
    db.prepare(
      `UPDATE transactions SET date = ?, amount = ? WHERE account_id = ? AND import_id = ? AND approved = 0 AND matched = 0`,
    ).run(t.date, -decimalToCents(String(t.amount)), local, `plaid:${t.transaction_id}`);
  }
  for (const t of removed) {
    for (const a of mapped) removeImported(a.id, `plaid:${t.transaction_id}`);
  }
  db.prepare(`UPDATE connections SET cursor = ? WHERE id = ?`).run(cursor ?? null, connId);
  // Until Plaid has finished pulling history from the bank, more is on its way: check back soon instead of in hours.
  if (updateStatus && updateStatus !== 'HISTORICAL_UPDATE_COMPLETE') retrySoon.add(connId);
  await refreshPlaidAccounts(connId);
  // Plaid pulls ~30 days right after linking, then older history in the background.
  const monthAgo = addDays(todayISO(), -30);
  updateOpeningBalances(
    connId,
    (a) => updateStatus === 'HISTORICAL_UPDATE_COMPLETE' || (updateStatus === 'INITIAL_UPDATE_COMPLETE' && (a.import_start ?? monthAgo) >= monthAgo),
  );
  return totals;
}

async function removePlaidItem(connId: number) {
  const conn = getConnection(connId);
  try {
    await plaidPost('/item/remove', { access_token: decrypt(conn.secret_enc) });
  } catch (e) {
    console.warn('Plaid item/remove failed (continuing):', (e as Error).message);
  }
}

// =====================================================================================
// SimpleFIN Bridge (https://www.simplefin.org/protocol.html) — cheap, no developer account
// needed. The user buys access at bridge.simplefin.org, links banks there, and pastes a
// one-time Setup Token here.
// =====================================================================================

function splitAccessUrl(accessUrl: string) {
  // Node's fetch refuses URLs containing credentials, so move them into an Authorization header.
  const u = new URL(accessUrl);
  const auth = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
  u.username = '';
  u.password = '';
  return { base: u.toString().replace(/\/$/, ''), auth };
}

export async function simplefinClaim(setupToken: string): Promise<number> {
  let claimUrl: string;
  try {
    claimUrl = Buffer.from(setupToken.trim(), 'base64').toString('utf8').trim();
    const u = new URL(claimUrl);
    if (u.protocol !== 'https:') throw new Error('not https');
  } catch {
    throw new HttpError(400, 'That does not look like a SimpleFIN Setup Token. Copy the whole token from bridge.simplefin.org.');
  }
  const res = await fetch(claimUrl, { method: 'POST', headers: { 'Content-Length': '0' } });
  if (res.status === 403) {
    throw new HttpError(
      400,
      'SimpleFIN rejected this token: it was already used or does not exist. Create a new Setup Token at bridge.simplefin.org (if you did not use it yourself, revoke it there).',
    );
  }
  if (!res.ok) throw new HttpError(502, `SimpleFIN claim failed (HTTP ${res.status})`);
  const accessUrl = (await res.text()).trim();
  try {
    new URL(accessUrl);
  } catch {
    throw new HttpError(502, 'SimpleFIN returned an invalid access URL');
  }
  const id = Number(
    db.prepare(`INSERT INTO connections (provider, institution, secret_enc) VALUES ('simplefin', 'SimpleFIN', ?)`).run(encrypt(accessUrl))
      .lastInsertRowid,
  );
  try {
    const r = await syncSimplefin(id, true);
    if (r.warnings.length) db.prepare(`UPDATE connections SET error = ? WHERE id = ?`).run('Bank reported: ' + r.warnings.join('; '), id);
  } catch (e) {
    // Keep the connection (the access URL is single-use to obtain) and surface the problem in Settings.
    db.prepare(`UPDATE connections SET status = 'error', error = ? WHERE id = ?`).run((e as Error).message, id);
  }
  return id;
}

async function simplefinFetch(accessUrl: string, params: Record<string, string>) {
  const { base, auth } = splitAccessUrl(accessUrl);
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${base}/accounts${qs ? '?' + qs : ''}`, { headers: { Authorization: auth }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2) });
  if (res.status === 403) throw new HttpError(400, 'SimpleFIN access was revoked or is invalid. Reconnect with a new Setup Token.');
  if (res.status === 402) throw new HttpError(400, 'Your SimpleFIN Bridge subscription needs payment.');
  if (!res.ok) throw new HttpError(502, `SimpleFIN request failed (HTTP ${res.status})`);
  return (await res.json()) as any;
}

function epochToISO(epoch: number): ISODate {
  return formatISODate(new Date(epoch * 1000));
}

async function syncSimplefin(connId: number, accountsOnly = false) {
  const conn = getConnection(connId);
  const accessUrl = decrypt(conn.secret_enc);
  const mapped = linkedAccounts(connId);
  // Ask for transactions since the earliest needed date, overlapping previous syncs so late-posting items are caught.
  const today = todayISO();
  let start: ISODate = addDays(today, -30);
  for (const a of mapped) {
    const fromLast = a.last_import_at ? addDays(a.last_import_at.slice(0, 10), -7) : a.import_start || addDays(today, -30);
    const want = a.import_start && a.import_start > fromLast ? a.import_start : fromLast;
    if (want < start) start = want;
  }
  // SimpleFIN Bridge recommends <= 45 days per request (hard limit 90) and ~24 requests/day, so fetch in 45-day windows
  // (max 1 year back — only the very first import of an old start date needs several windows).
  if (start < addDays(today, -365)) start = addDays(today, -365);
  const toEpoch = (d: ISODate) => String(Math.floor(new Date(d + 'T00:00:00').getTime() / 1000));
  const windows: Record<string, string>[] = [];
  if (accountsOnly) windows.push({ 'balances-only': '1', version: '2' });
  else {
    for (let s = start; s <= today; s = addDays(s, 44)) {
      const e = addDays(s, 44);
      // The newest window is left open-ended so nothing posted "today" in another time zone is missed.
      windows.push(e > today ? { 'start-date': toEpoch(s), version: '2' } : { 'start-date': toEpoch(s), 'end-date': toEpoch(e), version: '2' });
    }
  }

  const byExternal = new Map(mapped.map((a) => [a.external_id!, a.id]));
  const totals = { imported: 0, matched: 0, skipped: 0, newIds: [] as number[], warnings: [] as string[] };
  const institutions = new Set<string>();
  // Newest window last so the balance we keep is the current one.
  for (const params of windows) {
    const data = await simplefinFetch(accessUrl, params);
    const connNames = new Map<string, string>((data.connections || []).map((c: any) => [c.conn_id, c.name]));
    for (const a of data.accounts || []) {
      const inst = a.org?.name || connNames.get(a.conn_id) || '';
      if (inst) institutions.add(inst);
      const balance = a.balance !== undefined ? decimalToCents(String(a.balance)) : null;
      upsertExternal(connId, a.id, inst ? `${inst} — ${a.name}` : a.name, null, null, null, balance);
      const local = byExternal.get(a.id);
      if (!local || accountsOnly) continue;
      const items: ImportItem[] = [];
      for (const t of a.transactions || []) {
        if (t.pending || !t.posted) continue;
        items.push({
          importId: `sf:${t.id}`,
          date: epochToISO(t.posted),
          amount: decimalToCents(String(t.amount)), // SimpleFIN: negative = money out
          payeeName: t.payee || t.description || 'Unknown',
          memo: t.payee && t.description && t.payee !== t.description ? t.description : '',
        });
      }
      const r = importTransactions(local, items);
      totals.newIds.push(...r.newIds);
      totals.imported += r.imported;
      totals.matched += r.matched;
      totals.skipped += r.skipped;
    }
    // The bridge reports problems (e.g. a bank needing re-authentication, rate-limit warnings) here; always show them.
    for (const e of data.errors || []) totals.warnings.push(String(e));
    for (const e of (data.errlist || []) as any[]) totals.warnings.push(`${e.msg}${e.code ? ` (${e.code})` : ''}`);
  }
  if (institutions.size) {
    db.prepare(`UPDATE connections SET institution = ? WHERE id = ?`).run([...institutions].join(', ').slice(0, 200), connId);
  }
  totals.warnings = [...new Set(totals.warnings)];
  // SimpleFIN returns everything in the request, so the opening balance is final after the first full sync.
  if (!accountsOnly) updateOpeningBalances(connId, () => true);
  return totals;
}

// =====================================================================================
// Shared connection management
// =====================================================================================

interface ConnectionRow {
  id: number;
  provider: 'plaid' | 'simplefin';
  institution: string;
  item_id: string | null;
  secret_enc: string;
  cursor: string | null;
  status: string;
  error: string | null;
  created_at: string;
  last_sync_at: string | null;
}

function getConnection(id: number): ConnectionRow {
  const c = db.prepare(`SELECT * FROM connections WHERE id = ?`).get(id) as ConnectionRow | undefined;
  if (!c) throw new HttpError(404, 'Connection not found');
  return c;
}

function linkedAccounts(connId: number) {
  return db.prepare(`SELECT * FROM accounts WHERE connection_id = ? AND external_id IS NOT NULL AND closed = 0`).all(connId) as {
    id: number;
    external_id: string;
    import_start: string | null;
    last_import_at: string | null;
  }[];
}

function upsertExternal(
  connId: number,
  externalId: string,
  name: string,
  mask: string | null,
  kind: string | null,
  subtype: string | null,
  balance: number | null,
) {
  db.prepare(
    `INSERT INTO external_accounts (connection_id, external_id, name, mask, kind, subtype, balance) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(connection_id, external_id) DO UPDATE SET name = excluded.name, mask = excluded.mask, kind = excluded.kind,
       subtype = excluded.subtype, balance = excluded.balance`,
  ).run(connId, externalId, name, mask, kind, subtype, balance);
  if (balance !== null) {
    db.prepare(`UPDATE accounts SET bank_balance = ? WHERE connection_id = ? AND external_id = ?`).run(balance, connId, externalId);
  }
}

export function listConnections() {
  const conns = db.prepare(`SELECT id, provider, institution, status, error, created_at, last_sync_at FROM connections ORDER BY id`).all() as any[];
  const ext = db
    .prepare(
      `SELECT e.*, a.id AS local_account_id, a.name AS local_account_name FROM external_accounts e
       LEFT JOIN accounts a ON a.connection_id = e.connection_id AND a.external_id = e.external_id
       ORDER BY e.id`,
    )
    .all() as any[];
  return conns.map((c) => ({
    ...c,
    accounts: ext
      .filter((e) => e.connection_id === c.id)
      .map((e) => ({
        externalId: e.external_id,
        name: e.name,
        mask: e.mask,
        kind: e.kind,
        subtype: e.subtype,
        balance: e.balance,
        localAccountId: e.local_account_id,
        localAccountName: e.local_account_name,
      })),
  }));
}

export interface Mapping {
  externalId: string;
  action: 'create' | 'link' | 'ignore';
  localAccountId?: number;
  name?: string;
  type?: string;
  startDate?: ISODate;
}

export async function mapAccounts(connId: number, mappings: Mapping[]) {
  const conn = getConnection(connId);
  db.transaction(() => {
    for (const m of mappings) {
      const ext = db.prepare(`SELECT * FROM external_accounts WHERE connection_id = ? AND external_id = ?`).get(connId, m.externalId) as any;
      if (!ext) throw new HttpError(400, 'Unknown bank account');
      const startDate = m.startDate && isValidISODate(m.startDate) ? m.startDate : addDays(todayISO(), -30);
      // Only one local account may be linked to a given bank account.
      db.prepare(`UPDATE accounts SET connection_id = NULL, external_id = NULL WHERE connection_id = ? AND external_id = ?`).run(
        connId,
        m.externalId,
      );
      if (m.action === 'create') {
        const acct = createAccount({
          name: m.name || ext.name,
          type: m.type || 'checking',
          balance: 0,
          connectionId: connId,
          externalId: m.externalId,
          importStart: startDate,
          skipStartingBalance: true,
        });
        db.prepare(`UPDATE accounts SET bank_balance = ? WHERE id = ?`).run(ext.balance, acct.id);
        const openingId = createStartingBalance(acct, 0, addDays(startDate, -1));
        db.prepare(`UPDATE accounts SET opening_txn_id = ?, opening_auto = 1 WHERE id = ?`).run(openingId, acct.id);
      } else if (m.action === 'link') {
        const acct = getAccount(Number(m.localAccountId));
        if (!acct) throw new HttpError(400, 'Account to link not found');
        db.prepare(`UPDATE accounts SET connection_id = ?, external_id = ?, import_start = ?, bank_balance = ? WHERE id = ?`).run(
          connId,
          m.externalId,
          startDate,
          ext.balance,
          acct.id,
        );
      }
    }
    // Re-read history from the beginning so newly linked accounts get their past transactions (deduped by import id).
    if (conn.provider === 'plaid') resetPlaidCursor(connId);
  })();

  try {
    return await syncConnection(connId);
  } catch (e) {
    // Accounts are already created/linked; the next sync will fill them in. Don't make the user resubmit (that would duplicate accounts).
    return { imported: 0, matched: 0, skipped: 0, warnings: [`Accounts linked, but the first import failed: ${(e as Error).message}. It will retry automatically.`] };
  }
}

/**
 * Keeps each new linked account's starting balance equal to (bank balance - imported transactions), so the account
 * matches the bank even when history arrives after linking. Stops adjusting once `complete(account)` says all history is in.
 */
export function updateOpeningBalances(connId: number, complete: (a: { import_start: string | null }) => boolean) {
  const rows = db
    .prepare(`SELECT * FROM accounts WHERE connection_id = ? AND opening_auto = 1`)
    .all(connId) as import('./db.ts').AccountRow[];
  for (const a of rows) {
    const opening = a.opening_txn_id ? (db.prepare(`SELECT id FROM transactions WHERE id = ?`).get(a.opening_txn_id) as { id: number } | undefined) : undefined;
    if (!opening || a.bank_balance === null) {
      if (!opening) db.prepare(`UPDATE accounts SET opening_auto = 0 WHERE id = ?`).run(a.id);
      continue;
    }
    const { imported } = db
      .prepare(`SELECT COALESCE(SUM(amount), 0) AS imported FROM transactions WHERE account_id = ? AND import_id IS NOT NULL AND id != ?`)
      .get(a.id, opening.id) as { imported: number };
    const amount = a.bank_balance - imported;
    db.prepare(`UPDATE transactions SET amount = ?, category_id = ? WHERE id = ?`).run(amount, startingBalanceCategory(a, amount), opening.id);
    if (complete(a)) db.prepare(`UPDATE accounts SET opening_auto = 0 WHERE id = ?`).run(a.id);
  }
}

/** Makes the next Plaid sync re-read everything from the start (already-imported transactions are skipped by id). */
export function resetPlaidCursor(connId: number) {
  db.prepare(`UPDATE connections SET cursor = NULL WHERE id = ? AND provider = 'plaid'`).run(connId);
}

const running = new Map<number, Promise<any>>();

/** Connections whose last sync failed for a passing reason, or whose bank history is still arriving; the scheduler retries these early. */
const retrySoon = new Set<number>();
export function connectionsToRetrySoon(): number[] {
  return [...retrySoon];
}

type SyncResult = { imported: number; matched: number; skipped: number; newIds?: number[]; warnings?: string[] };

/**
 * Imports new transactions for one bank connection. With `notify`, devices that turned on notifications hear about what
 * arrived (used for background syncs; when you press Import yourself you're already looking).
 */
export async function syncConnection(connId: number, opts: { notify?: boolean } = {}): Promise<SyncResult> {
  const r = await syncConnectionOnce(connId);
  if (opts.notify && r.newIds?.length) await notifyNewTransactions(r.newIds);
  return r;
}

async function syncConnectionOnce(connId: number): Promise<SyncResult> {
  // Avoid overlapping syncs of the same connection (e.g. timer + button click).
  if (running.has(connId)) return running.get(connId)!;
  const p = (async () => {
    const conn = getConnection(connId);
    retrySoon.delete(connId);
    try {
      const r: SyncResult =
        conn.provider === 'plaid' ? await syncPlaid(connId) : await syncSimplefin(connId);
      detectTransfers();
      matchAmazon();
      const warning = r.warnings?.length ? 'Bank reported: ' + r.warnings.join('; ') : null;
      db.prepare(`UPDATE connections SET status = 'ok', error = ?, last_sync_at = datetime('now') WHERE id = ?`).run(warning, connId);
      return r;
    } catch (e) {
      const err = e as Error & { code?: string };
      const status = err instanceof PlaidError && ['ITEM_LOGIN_REQUIRED', 'PENDING_EXPIRATION', 'PENDING_DISCONNECT'].includes(err.code)
        ? 'reauth'
        : 'error';
      // Needing the user to sign in again won't fix itself; anything else (bank or network trouble) is worth retrying soon.
      if (status === 'error') retrySoon.add(connId);
      db.prepare(`UPDATE connections SET status = ?, error = ?, last_sync_at = datetime('now') WHERE id = ?`).run(status, err.message, connId);
      throw e instanceof HttpError ? e : new HttpError(502, err.message);
    } finally {
      running.delete(connId);
    }
  })();
  running.set(connId, p);
  return p;
}

export async function syncAll(opts: { notify?: boolean } = {}) {
  const conns = db.prepare(`SELECT id FROM connections`).all() as { id: number }[];
  const out: Record<number, unknown> = {};
  for (const c of conns) {
    try {
      out[c.id] = await syncConnection(c.id, opts);
    } catch (e) {
      out[c.id] = { error: (e as Error).message };
    }
  }
  return out;
}

export async function deleteConnection(connId: number) {
  const conn = getConnection(connId);
  if (conn.provider === 'plaid') await removePlaidItem(connId);
  db.prepare(`UPDATE accounts SET connection_id = NULL, external_id = NULL WHERE connection_id = ?`).run(connId);
  db.prepare(`DELETE FROM connections WHERE id = ?`).run(connId);
}

export function syncIntervalHours(): number {
  const v = Number(getSetting('sync_interval_hours') ?? process.env.SYNC_INTERVAL_HOURS ?? 6);
  return Number.isFinite(v) && v >= 0 ? v : 6;
}
