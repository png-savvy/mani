import { WebPushError, generateVAPIDKeys, sendNotification } from 'web-push';
import { db, getSetting, setSetting } from './db.ts';
import { decrypt, encrypt } from './security.ts';
import { HttpError } from './txns.ts';

// =====================================================================================
// Push notifications (Web Push). Each phone or browser that turns notifications on registers a subscription here; the
// server tells it about newly imported transactions so they can be categorized right away. Messages are end-to-end
// encrypted to the device: Apple/Google's push service only relays them.
// =====================================================================================

interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

function vapidKeys() {
  let pub = getSetting('vapid_public');
  let priv = getSetting('vapid_private_enc');
  if (!pub || !priv) {
    const k = generateVAPIDKeys();
    pub = k.publicKey;
    priv = encrypt(k.privateKey);
    setSetting('vapid_public', pub);
    setSetting('vapid_private_enc', priv);
  }
  return { publicKey: pub, privateKey: decrypt(priv) };
}

export function pushPublicKey(): string {
  return vapidKeys().publicKey;
}

export function pushStatus() {
  const rows = db.prepare(`SELECT id, label, created_at, last_ok_at FROM push_subscriptions ORDER BY id`).all() as {
    id: number;
    label: string;
    created_at: string;
    last_ok_at: string | null;
  }[];
  return { publicKey: pushPublicKey(), devices: rows.map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, lastOkAt: r.last_ok_at })) };
}

export function subscribe(sub: unknown, label: string, origin: string | undefined) {
  const s = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof s?.endpoint === 'string' ? s.endpoint : '';
  const p256dh = typeof s?.keys?.p256dh === 'string' ? s.keys.p256dh : '';
  const auth = typeof s?.keys?.auth === 'string' ? s.keys.auth : '';
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, 'Invalid push subscription');
  }
  if (url.protocol !== 'https:' || !p256dh || !auth || endpoint.length > 2000) throw new HttpError(400, 'Invalid push subscription');
  // Apple requires the sender to identify itself with a real https: URL or mailto: address; the app's own address works.
  if (origin && /^https:\/\/[^/]+$/.test(origin) && !/\/\/(localhost|127\.)/.test(origin)) setSetting('push_subject', origin);
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, label) VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label`,
  ).run(endpoint, p256dh, auth, label.slice(0, 80));
}

export function unsubscribe(endpoint: string) {
  db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint);
}

export function removeDevice(id: number) {
  db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(id);
}

export interface PushMessage {
  title: string;
  body: string;
  /** Page to open when the notification is tapped. */
  url: string;
  /** Notifications with the same tag replace each other instead of piling up. */
  tag?: string;
}

/** Sends to every registered device. Returns how many accepted it. Devices the push service says are gone are removed. */
export async function sendToAll(msg: PushMessage, only?: string): Promise<number> {
  const rows = (
    only
      ? db.prepare(`SELECT * FROM push_subscriptions WHERE endpoint = ?`).all(only)
      : db.prepare(`SELECT * FROM push_subscriptions`).all()
  ) as SubscriptionRow[];
  if (!rows.length) return 0;
  const { publicKey, privateKey } = vapidKeys();
  const subject = getSetting('push_subject') || 'mailto:notifications@mani.invalid';
  let ok = 0;
  await Promise.all(
    rows.map(async (r) => {
      try {
        await sendNotification({ endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } }, JSON.stringify(msg), {
          vapidDetails: { subject, publicKey, privateKey },
          TTL: 24 * 3600,
          // High urgency wakes a sleeping phone; at 'normal', Android holds the message until the phone is next used.
          urgency: 'high',
          timeout: 15000,
        });
        db.prepare(`UPDATE push_subscriptions SET last_ok_at = datetime('now') WHERE id = ?`).run(r.id);
        ok++;
      } catch (e) {
        // 404/410: the device unsubscribed or the app was removed — forget it.
        if (e instanceof WebPushError && (e.statusCode === 404 || e.statusCode === 410)) {
          db.prepare(`DELETE FROM push_subscriptions WHERE id = ?`).run(r.id);
        } else {
          console.warn('Push notification failed:', (e as Error).message);
        }
      }
    }),
  );
  return ok;
}

function fmtMoney(cents: number) {
  const currency = getSetting('currency') || 'USD';
  const locale = getSetting('locale') || 'en-US';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return (cents / 100).toFixed(2);
  }
}

/** Builds the "new transactions" message for these freshly imported transaction ids (null when there's nothing to say). */
export function newTransactionsMessage(ids: number[]): PushMessage | null {
  if (!ids.length) return null;
  const rows = db
    .prepare(
      `SELECT t.id, t.amount, t.category_id, t.transfer_account_id, t.is_split, p.name AS payee, ta.name AS transfer_name,
         a.on_budget, tb.on_budget AS other_on_budget
       FROM transactions t JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN accounts ta ON ta.id = t.transfer_account_id
       LEFT JOIN accounts tb ON tb.id = t.transfer_account_id
       WHERE t.id IN (${ids.map(() => '?').join(',')}) AND t.approved = 0
       ORDER BY t.date DESC, t.id DESC`,
    )
    .all(...ids) as {
    id: number;
    amount: number;
    category_id: number | null;
    transfer_account_id: number | null;
    is_split: number;
    payee: string | null;
    transfer_name: string | null;
    on_budget: number;
    other_on_budget: number | null;
  }[];
  if (!rows.length) return null;
  // A joined transfer appears as two new rows; mention it once.
  const seen = new Set<number>();
  const shown = rows.filter((r) => {
    if (r.transfer_account_id) {
      const pair = db.prepare(`SELECT transfer_txn_id FROM transactions WHERE id = ?`).get(r.id) as { transfer_txn_id: number | null };
      if (pair.transfer_txn_id && seen.has(pair.transfer_txn_id)) return false;
    }
    seen.add(r.id);
    return true;
  });
  const needsCategory = (r: (typeof rows)[number]) =>
    !!r.on_budget && !r.is_split && r.category_id === null && (!r.transfer_account_id || r.other_on_budget === 0);
  const line = (r: (typeof rows)[number]) =>
    `${r.transfer_name ? `Transfer : ${r.transfer_name}` : r.payee || 'Unknown'} ${fmtMoney(r.amount)}${needsCategory(r) ? ' · needs a category' : ''}`;
  const uncategorized = shown.filter(needsCategory).length;
  if (shown.length === 1) {
    return { title: 'New transaction', body: line(shown[0]), url: '/review', tag: 'new-transactions' };
  }
  const max = 4;
  const body = shown.slice(0, max).map(line).join('\n') + (shown.length > max ? `\n+${shown.length - max} more` : '');
  return {
    title: `${shown.length} new transactions${uncategorized ? ` · ${uncategorized} to categorize` : ''}`,
    body,
    url: '/review',
    tag: 'new-transactions',
  };
}

export async function notifyNewTransactions(ids: number[]) {
  const msg = newTransactionsMessage(ids);
  if (!msg) return;
  try {
    await sendToAll(msg);
  } catch (e) {
    console.warn('Push notification failed:', (e as Error).message);
  }
}
