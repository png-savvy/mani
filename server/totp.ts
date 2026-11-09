import crypto from 'node:crypto';
import { db, getSetting, setSetting } from './db.ts';
import { decrypt, encrypt } from './security.ts';

// Two-step login with an authenticator app (TOTP, RFC 6238: 30-second, 6-digit codes, SHA-1).

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function totpCode(secretB32: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const bin = ((h[off] & 127) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

const STEP = 30;
const counterNow = () => Math.floor(Date.now() / 1000 / STEP);

/** Returns the matching time step (allowing one step of clock drift each way), or null. */
function matchCounter(secret: string, code: string): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = counterNow();
  for (const c of [now, now - 1, now + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, c)), Buffer.from(code))) return c;
  }
  return null;
}

export function twoFactorEnabled(): boolean {
  return !!getSetting('totp_secret');
}

export function recoveryCodesLeft(): number {
  const raw = getSetting('totp_recovery');
  return raw ? (JSON.parse(raw) as string[]).length : 0;
}

/** Starts setup: a new secret is kept as "pending" until the user proves their app works. */
export function beginSetup(): { secret: string; uri: string } {
  const secret = base32Encode(crypto.randomBytes(20));
  setSetting('totp_pending', encrypt(secret));
  const label = encodeURIComponent('Mani:' + (getSetting('budget_name') || 'Budget'));
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=Mani&algorithm=SHA1&digits=6&period=30`;
  return { secret, uri };
}

const hashCode = (code: string) => crypto.createHash('sha256').update(code.replace(/[^a-z0-9]/gi, '').toLowerCase()).digest('hex');

/** Finishes setup if the code matches the pending secret. Returns one-time recovery codes. */
export function confirmSetup(code: string): string[] | null {
  const pending = getSetting('totp_pending');
  if (!pending) return null;
  const secret = decrypt(pending);
  const c = matchCounter(secret, code.trim());
  if (c === null) return null;
  const { codes, hashes } = newRecoveryCodes();
  db.transaction(() => {
    setSetting('totp_secret', encrypt(secret));
    setSetting('totp_last_counter', String(c));
    setSetting('totp_recovery', JSON.stringify(hashes));
    db.prepare(`DELETE FROM settings WHERE key = 'totp_pending'`).run();
  })();
  return codes;
}

function newRecoveryCodes(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: 10 }, () => {
    const s = crypto.randomBytes(5).toString('hex');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { codes, hashes: codes.map(hashCode) };
}

/** Replaces all recovery codes (the old ones stop working). */
export function regenerateRecoveryCodes(): string[] {
  const { codes, hashes } = newRecoveryCodes();
  setSetting('totp_recovery', JSON.stringify(hashes));
  return codes;
}

export function disableTwoFactor() {
  db.prepare(`DELETE FROM settings WHERE key IN ('totp_secret','totp_pending','totp_last_counter','totp_recovery')`).run();
}

// Guess limiting for codes across all IPs: a 6-digit code must never be brute-forced from many addresses.
let globalFailures: number[] = [];

export function codeAttemptsBlocked(): boolean {
  const cutoff = Date.now() - 15 * 60000;
  globalFailures = globalFailures.filter((t) => t > cutoff);
  return globalFailures.length >= 20;
}

/**
 * Checks an authenticator code or a recovery code. Each authenticator code works only once,
 * and each recovery code is removed after use.
 */
export function verifySecondFactor(input: string): { ok: boolean; usedRecovery?: boolean } {
  const secretEnc = getSetting('totp_secret');
  if (!secretEnc) return { ok: true };
  const code = input.trim();
  if (/^\d{6}$/.test(code.replace(/\s/g, ''))) {
    const c = matchCounter(decrypt(secretEnc), code.replace(/\s/g, ''));
    const last = Number(getSetting('totp_last_counter') ?? -1);
    if (c !== null && c > last) {
      setSetting('totp_last_counter', String(c));
      return { ok: true };
    }
  } else if (code) {
    const list = JSON.parse(getSetting('totp_recovery') ?? '[]') as string[];
    const h = hashCode(code);
    const i = list.indexOf(h);
    if (i >= 0) {
      list.splice(i, 1);
      setSetting('totp_recovery', JSON.stringify(list));
      return { ok: true, usedRecovery: true };
    }
  }
  globalFailures.push(Date.now());
  return { ok: false };
}
