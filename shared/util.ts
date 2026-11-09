// Helpers shared by the server and the client. All money is stored as integer cents.

export type Month = string; // 'YYYY-MM'
export type ISODate = string; // 'YYYY-MM-DD'

export const CREDIT_TYPES = ['credit_card', 'line_of_credit'] as const;
export const BUDGET_TYPES = ['checking', 'savings', 'cash', 'credit_card', 'line_of_credit'] as const;
export const TRACKING_TYPES = ['asset', 'liability', 'mortgage', 'loan'] as const;
export const ACCOUNT_TYPES = [...BUDGET_TYPES, ...TRACKING_TYPES] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit_card: 'Credit Card',
  line_of_credit: 'Line of Credit',
  asset: 'Asset (e.g. Investment, House)',
  liability: 'Liability',
  mortgage: 'Mortgage',
  loan: 'Loan (Auto, Student, Personal)',
};

export function isCreditType(t: string): boolean {
  return (CREDIT_TYPES as readonly string[]).includes(t);
}
export function isBudgetType(t: string): boolean {
  return (BUDGET_TYPES as readonly string[]).includes(t);
}

export const FREQUENCIES = [
  'never',
  'daily',
  'weekly',
  'everyOtherWeek',
  'twiceAMonth',
  'every4Weeks',
  'monthly',
  'everyOtherMonth',
  'every3Months',
  'every4Months',
  'twiceAYear',
  'yearly',
  'everyOtherYear',
] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export const FREQUENCY_LABELS: Record<Frequency, string> = {
  never: 'Never (one time)',
  daily: 'Daily',
  weekly: 'Weekly',
  everyOtherWeek: 'Every other week',
  twiceAMonth: 'Twice a month',
  every4Weeks: 'Every 4 weeks',
  monthly: 'Monthly',
  everyOtherMonth: 'Every other month',
  every3Months: 'Every 3 months',
  every4Months: 'Every 4 months',
  twiceAYear: 'Twice a year',
  yearly: 'Yearly',
  everyOtherYear: 'Every other year',
};

export const TARGET_TYPES = ['monthly_set_aside', 'monthly_refill', 'balance', 'by_date'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];
export const TARGET_LABELS: Record<TargetType, string> = {
  monthly_set_aside: 'Monthly: set aside another',
  monthly_refill: 'Monthly: refill up to',
  balance: 'Have a balance of',
  by_date: 'Have a balance of … by date',
};

export const FLAGS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

export function formatISODate(d: Date): ISODate {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO(): ISODate {
  return formatISODate(new Date());
}

export function monthOf(date: ISODate): Month {
  return date.slice(0, 7);
}

export function currentMonth(): Month {
  return monthOf(todayISO());
}

export function addMonths(month: Month, n: number): Month {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

/** Number of months from a to b (b - a). */
export function monthDiff(a: Month, b: Month): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return by * 12 + bm - (ay * 12 + am);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(year, month1, 0).getDate();
}

export function parseISO(date: ISODate): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(date: ISODate, n: number): ISODate {
  const d = parseISO(date);
  d.setDate(d.getDate() + n);
  return formatISODate(d);
}

/** Adds months to a date, clamping to the end of the target month (Jan 31 + 1 month = Feb 28/29). */
export function addMonthsToDate(date: ISODate, n: number, preferredDay?: number): ISODate {
  const [y, m, d] = date.split('-').map(Number);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const day = Math.min(preferredDay ?? d, daysInMonth(ny, nm));
  return `${ny}-${pad(nm)}-${pad(day)}`;
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86400000);
}

export function isValidISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = parseISO(s);
  return formatISODate(d) === s;
}

export function isValidMonth(s: unknown): s is Month {
  return typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/**
 * Next occurrence of a scheduled transaction. `anchorDay` is the original day of month so that
 * a transaction scheduled on the 31st keeps landing on the last day of shorter months.
 */
export function nextOccurrence(date: ISODate, freq: Frequency, anchorDay?: number): ISODate | null {
  switch (freq) {
    case 'never':
      return null;
    case 'daily':
      return addDays(date, 1);
    case 'weekly':
      return addDays(date, 7);
    case 'everyOtherWeek':
      return addDays(date, 14);
    case 'every4Weeks':
      return addDays(date, 28);
    case 'twiceAMonth': {
      // Two dates per month, 15 days apart (e.g. 1st & 16th, or 15th & last day).
      const [y, m, d] = date.split('-').map(Number);
      const anchor = anchorDay ?? d;
      const first = anchor > 15 ? anchor - 15 : anchor;
      const second = first + 15;
      if (d < Math.min(second, daysInMonth(y, m))) {
        return `${y}-${pad(m)}-${pad(Math.min(second, daysInMonth(y, m)))}`;
      }
      return addMonthsToDate(`${y}-${pad(m)}-01`, 1, first);
    }
    case 'monthly':
      return addMonthsToDate(date, 1, anchorDay);
    case 'everyOtherMonth':
      return addMonthsToDate(date, 2, anchorDay);
    case 'every3Months':
      return addMonthsToDate(date, 3, anchorDay);
    case 'every4Months':
      return addMonthsToDate(date, 4, anchorDay);
    case 'twiceAYear':
      return addMonthsToDate(date, 6, anchorDay);
    case 'yearly':
      return addMonthsToDate(date, 12, anchorDay);
    case 'everyOtherYear':
      return addMonthsToDate(date, 24, anchorDay);
  }
}

/** Parses a user-entered money string ("1,234.56", "$12", "-5", "10+2.5*2") into cents. */
export function parseMoney(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  const s = input.replace(/[$,\s€£¥]/g, '');
  if (s === '') return null;
  const value = evalArithmetic(s);
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Tiny safe arithmetic evaluator supporting + - * / and parentheses. */
export function evalArithmetic(expr: string): number | null {
  let i = 0;
  const peek = () => expr[i];
  function parseExpr(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    while (peek() === '+' || peek() === '-') {
      const op = expr[i++];
      const right = parseTerm();
      if (right === null) return null;
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }
  function parseTerm(): number | null {
    let left = parseFactor();
    if (left === null) return null;
    while (peek() === '*' || peek() === '/') {
      const op = expr[i++];
      const right = parseFactor();
      if (right === null) return null;
      if (op === '/' && right === 0) return null;
      left = op === '*' ? left * right : left / right;
    }
    return left;
  }
  function parseFactor(): number | null {
    if (peek() === '-') {
      i++;
      const v = parseFactor();
      return v === null ? null : -v;
    }
    if (peek() === '+') {
      i++;
      return parseFactor();
    }
    if (peek() === '(') {
      i++;
      const v = parseExpr();
      if (peek() !== ')') return null;
      i++;
      return v;
    }
    const m = /^\d*\.?\d+|^\d+\./.exec(expr.slice(i));
    if (!m) return null;
    i += m[0].length;
    return parseFloat(m[0]);
  }
  const result = parseExpr();
  return i === expr.length ? result : null;
}

/** Converts a decimal amount string from a bank API ("-12.34") to integer cents without float drift. */
export function decimalToCents(value: string | number): number {
  if (typeof value === 'number') return Math.round(value * 100);
  const s = value.trim();
  const neg = s.startsWith('-');
  const [whole, frac = ''] = s.replace(/^[-+]/, '').split('.');
  const cents = Number(whole || '0') * 100 + Number((frac + '00').slice(0, 2)) + (Number(frac[2] || '0') >= 5 ? 1 : 0);
  return neg ? -cents : cents;
}
