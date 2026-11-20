import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response, NextFunction } from 'express';
import { DATA_DIR, db, getSetting, setSetting } from './db.ts';

// ---------- Encryption of bank credentials at rest (AES-256-GCM) ----------

function loadKey(): Buffer {
  const env = process.env.ENCRYPTION_KEY;
  if (env) return crypto.createHash('sha256').update(env).digest();
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  }
  return crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8').trim()).digest();
}
const KEY = loadKey();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(blob: string): string {
  const [iv, tag, data] = blob.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// ---------- Password + sessions (single-user app) ----------

const SESSION_DAYS = 30;
const COOKIE = 'mani_sid';

export const MAX_PASSWORD_LENGTH = 1024;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split('$');
  // No real password is this long; refusing early keeps a huge input from tying up the server.
  if (scheme !== 'scrypt' || password.length > MAX_PASSWORD_LENGTH) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export function isSetUp(): boolean {
  return !!getSetting('password_hash');
}

export function setPassword(password: string) {
  setSetting('password_hash', hashPassword(password));
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Only a hash of each session token is stored, so a copy of the database (a backup file, say) can't be used to sign in.
const sessionKey = (token: string) => 'h1:' + crypto.createHash('sha256').update(token).digest('hex');

// Sessions saved by older versions were stored as-is; convert them in place so nobody is signed out.
for (const r of db.prepare(`SELECT token FROM sessions WHERE token NOT LIKE 'h1:%'`).all() as { token: string }[]) {
  db.prepare(`UPDATE OR REPLACE sessions SET token = ? WHERE token = ?`).run(sessionKey(r.token), r.token);
}

export function createSession(req: Request, res: Response) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expires = now + SESSION_DAYS * 86400000;
  db.prepare(`INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)`).run(sessionKey(token), now, expires);
  db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  );
}

export function destroySession(req: Request, res: Response) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare(`DELETE FROM sessions WHERE token = ?`).run(sessionKey(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

/** Signs out every other browser/phone (used after turning on two-step login). */
export function revokeOtherSessions(req: Request) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  db.prepare(`DELETE FROM sessions WHERE token != ?`).run(token ? sessionKey(token) : '');
}

export function isAuthed(req: Request): boolean {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const row = db.prepare(`SELECT expires_at FROM sessions WHERE token = ?`).get(sessionKey(token)) as { expires_at: number } | undefined;
  return !!row && row.expires_at > Date.now();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: 'Not signed in' });
}

// ---------- Login brute-force defense ----------
//
// Two layers. The per-IP limiter gives fast feedback and a hard stop, but it keys on req.ip,
// which can be influenced by a spoofed X-Forwarded-For when a proxy forwards from loopback, and
// it lives in memory so a restart clears it. The real backstop is a GLOBAL throttle that does not
// depend on the client's apparent IP and is persisted in the database, so neither header spoofing
// nor the app's automatic restarts can reset it. Sustained guessing is slowed with a growing delay
// rather than a hard global block, so an attacker can't lock the real owner out by spamming the form.

const FAIL_WINDOW_MS = 15 * 60000;
const FREE_FAILURES = 5; // normal mistypes stay instant
const DELAY_STEP_MS = 750; // added per failure past the free allowance
const MAX_DELAY_MS = 5000; // ceiling, so a legitimate login never stalls for long

// Per-IP limiter (best-effort, fast feedback).
const attempts = new Map<string, { count: number; until: number }>();
export function loginAllowed(ip: string): boolean {
  const a = attempts.get(ip);
  return !a || a.until < Date.now() || a.count < 10;
}

// Global, IP-independent, persisted record of recent failures.
function recentGlobalFailures(): number[] {
  const cutoff = Date.now() - FAIL_WINDOW_MS;
  let list: number[] = [];
  try {
    const raw = getSetting('login_fail_events');
    if (raw) list = JSON.parse(raw) as number[];
  } catch {
    list = [];
  }
  return list.filter((t) => typeof t === 'number' && t > cutoff);
}

/** Delay (ms) to stall the next password check, based on recent global failures across all IPs. */
export function loginThrottleMs(): number {
  const n = recentGlobalFailures().length;
  if (n <= FREE_FAILURES) return 0;
  return Math.min(MAX_DELAY_MS, (n - FREE_FAILURES) * DELAY_STEP_MS);
}

export function recordLoginFailure(ip: string) {
  const a = attempts.get(ip);
  if (!a || a.until < Date.now()) attempts.set(ip, { count: 1, until: Date.now() + FAIL_WINDOW_MS });
  else a.count++;
  const list = recentGlobalFailures();
  list.push(Date.now());
  setSetting('login_fail_events', JSON.stringify(list.slice(-500)));
}

export function clearLoginFailures(ip: string) {
  // Clear only this IP's fast limiter. The global window is left to age out so a successful
  // login can't be used to wipe the record of an ongoing attack.
  attempts.delete(ip);
}

// CSRF protection: state-changing API calls must be JSON (or carry our own header), which another website can't send
// without the browser asking first — and must not be marked by the browser as coming from a different site.
export function csrfGuard(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const reject = () => res.status(403).json({ error: 'Rejected request (CSRF protection)' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return reject();
  // The exact media type, not "contains": `text/plain; application/json` is a form-style request in disguise.
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/json' || req.headers['x-requested-with'] === 'mani') return next();
  reject();
}
