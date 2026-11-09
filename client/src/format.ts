import type { Settings } from './types';

let moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
let plainFmt = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let dateFormat = 'MM/DD/YYYY';
let locale = 'en-US';

export function configureFormat(s: Settings) {
  locale = s.locale || 'en-US';
  try {
    moneyFmt = new Intl.NumberFormat(locale, { style: 'currency', currency: s.currency || 'USD' });
  } catch {
    moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  }
  plainFmt = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  dateFormat = s.dateFormat || 'MM/DD/YYYY';
}

/** Formats integer cents as currency. */
export function money(cents: number): string {
  // Avoid "-$0.00".
  return moneyFmt.format((cents === 0 ? 0 : cents) / 100);
}

/** Formats cents as a plain number for an input box ("1234.50"). */
export function moneyInput(cents: number): string {
  return cents === 0 ? '' : (cents / 100).toFixed(2);
}

export function plain(cents: number): string {
  return plainFmt.format(cents / 100);
}

export function fmtDate(iso: string): string {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  if (dateFormat === 'DD/MM/YYYY') return `${d}/${m}/${y}`;
  if (dateFormat === 'YYYY-MM-DD') return iso;
  return `${m}/${d}/${y}`;
}

export function fmtMonth(month: string, style: 'long' | 'short' = 'long'): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: style, year: 'numeric' });
}

export function fmtDateTime(sqlUtc: string | null): string {
  if (!sqlUtc) return 'never';
  const d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeAgo(sqlUtc: string | null): string {
  if (!sqlUtc) return 'never';
  const ms = Date.now() - new Date(sqlUtc.replace(' ', 'T') + 'Z').getTime();
  const min = Math.round(ms / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}
