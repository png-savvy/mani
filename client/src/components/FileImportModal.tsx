import { useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { fmtDate, money } from '../format';
import { Modal } from './ui';
import type { Account } from '../types';
import { decimalToCents, isValidISODate } from '../../../shared/util';

interface Item {
  importId: string;
  date: string;
  amount: number;
  payeeName: string;
  memo: string;
}

// ---------------------------------------------------------------- parsers

export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const delim = (() => {
    const first = text.split(/\r?\n/, 1)[0] ?? '';
    const counts = [',', ';', '\t'].map((d) => [d, first.split(d).length] as const);
    return counts.sort((a, b) => b[1] - a[1])[0][0];
  })();
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

type DateFmt = 'MDY' | 'DMY' | 'YMD';

function parseDate(s: string, fmt: DateFmt): string | null {
  const parts = s.trim().split(/[^\d]+/).filter(Boolean);
  if (parts.length < 3) {
    if (/^\d{8}$/.test(s.trim())) return parseDate(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`, 'YMD');
    return null;
  }
  let y: string, m: string, d: string;
  if (fmt === 'YMD') [y, m, d] = parts;
  else if (fmt === 'MDY') [m, d, y] = parts;
  else [d, m, y] = parts;
  if (y.length === 2) y = (Number(y) > 70 ? '19' : '20') + y;
  const iso = `${y.padStart(4, '0')}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isValidISODate(iso) ? iso : null;
}

function guessDateFmt(samples: string[]): DateFmt {
  for (const f of ['YMD', 'MDY', 'DMY'] as DateFmt[]) {
    if (samples.length && samples.every((s) => parseDate(s, f))) {
      if (f === 'MDY' && samples.some((s) => Number(s.split(/[^\d]+/)[0]) > 12)) continue;
      return f;
    }
  }
  return 'MDY';
}

function parseAmount(s: string): number | null {
  let t = s.trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (/-$/.test(t)) {
    neg = true;
    t = t.slice(0, -1);
  }
  t = t.replace(/[^\d.,-]/g, '');
  // European format "1.234,56" -> "1234.56"
  if (/,\d{1,2}$/.test(t) && !/\.\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  const cents = decimalToCents(t);
  return neg ? -Math.abs(cents) : cents;
}

function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Stable ids so importing the same file twice doesn't duplicate transactions. */
function withIds(items: Omit<Item, 'importId'>[], prefix: string): Item[] {
  const seen = new Map<string, number>();
  return items.map((it) => {
    const key = `${it.date}|${it.amount}|${it.payeeName.toLowerCase()}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return { ...it, importId: `${prefix}:${hash(key)}:${n}` };
  });
}

export function parseOFX(text: string): Item[] {
  const out: Item[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const tag = (b: string, name: string) => {
    const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(b);
    return m ? m[1].trim() : '';
  };
  for (const raw of blocks) {
    const b = raw.split(/<\/STMTTRN>/i)[0];
    const dt = tag(b, 'DTPOSTED').slice(0, 8);
    const date = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    const amount = parseAmount(tag(b, 'TRNAMT'));
    if (!isValidISODate(date) || amount === null) continue;
    const name = tag(b, 'NAME') || tag(b, 'PAYEE') || tag(b, 'MEMO') || 'Unknown';
    const memo = tag(b, 'MEMO');
    const fitid = tag(b, 'FITID');
    out.push({
      importId: fitid ? `ofx:${fitid}` : `ofx:${hash(date + amount + name)}`,
      date,
      amount,
      payeeName: decodeEntities(name),
      memo: memo && memo !== name ? decodeEntities(memo) : '',
    });
  }
  return out;
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ---------------------------------------------------------------- component

export default function FileImportModal({ account, onClose }: { account: Account; onClose: () => void }) {
  const { run, toast } = useApp();
  const [fileName, setFileName] = useState('');
  const [ofxItems, setOfxItems] = useState<Item[] | null>(null);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [hasHeader, setHasHeader] = useState(true);
  const [map, setMap] = useState({ date: 0, payee: 1, memo: -1, amount: 2, outflow: -1, inflow: -1 });
  const [amountMode, setAmountMode] = useState<'single' | 'split'>('single');
  const [flip, setFlip] = useState(false);
  const [dateFmt, setDateFmt] = useState<DateFmt>('MDY');
  const [busy, setBusy] = useState(false);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setFileName(f.name);
    const text = await f.text();
    if (/\.(ofx|qfx)$/i.test(f.name) || /<OFX>/i.test(text)) {
      const items = parseOFX(text);
      if (!items.length) toast('No transactions found in that file', 'error');
      setOfxItems(items);
      setRows(null);
      return;
    }
    const parsed = parseCSV(text);
    if (!parsed.length) return toast('That file is empty', 'error');
    setOfxItems(null);
    setRows(parsed);
    // Guess columns from header names.
    const header = parsed[0].map((h) => h.toLowerCase());
    const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
    const date = Math.max(0, find('date', 'posted'));
    const payee = find('payee', 'description', 'merchant', 'name', 'details');
    const memo = find('memo', 'note');
    const amount = find('amount');
    const outflow = find('debit', 'outflow', 'withdrawal', 'money out');
    const inflow = find('credit', 'inflow', 'deposit', 'money in');
    const isHeader = header.some((h) => /date|amount|description|payee/.test(h));
    setHasHeader(isHeader);
    setMap({ date, payee: payee >= 0 ? payee : 1, memo, amount: amount >= 0 ? amount : 2, outflow, inflow });
    setAmountMode(amount < 0 && outflow >= 0 && inflow >= 0 ? 'split' : 'single');
    setDateFmt(guessDateFmt(parsed.slice(isHeader ? 1 : 0, 30).map((r) => r[date] ?? '')));
  };

  const csvItems = useMemo(() => {
    if (!rows) return [];
    const body = rows.slice(hasHeader ? 1 : 0);
    const items: Omit<Item, 'importId'>[] = [];
    for (const r of body) {
      const date = parseDate(r[map.date] ?? '', dateFmt);
      let amount: number | null;
      if (amountMode === 'single') {
        amount = parseAmount(r[map.amount] ?? '');
        if (amount !== null && flip) amount = -amount;
      } else {
        const out = parseAmount(r[map.outflow] ?? '') ?? 0;
        const inn = parseAmount(r[map.inflow] ?? '') ?? 0;
        amount = Math.abs(inn) - Math.abs(out);
        if (!r[map.outflow] && !r[map.inflow]) amount = null;
      }
      if (!date || amount === null) continue;
      items.push({ date, amount, payeeName: r[map.payee] || 'Unknown', memo: map.memo >= 0 ? r[map.memo] ?? '' : '' });
    }
    return withIds(items, 'csv');
  }, [rows, hasHeader, map, amountMode, flip, dateFmt]);

  const items = ofxItems ?? csvItems;
  const skippedRows = rows ? rows.length - (hasHeader ? 1 : 0) - csvItems.length : 0;
  const headers = rows ? (hasHeader ? rows[0] : rows[0].map((_, i) => `Column ${i + 1}`)) : [];

  const colSelect = (key: keyof typeof map, optional = false) => (
    <select value={map[key]} onChange={(e) => setMap({ ...map, [key]: Number(e.target.value) })}>
      {optional && <option value={-1}>(none)</option>}
      {headers.map((h, i) => (
        <option key={i} value={i}>{h || `Column ${i + 1}`}</option>
      ))}
    </select>
  );

  const doImport = async () => {
    setBusy(true);
    const r = await run(() => api.post<{ imported: number; matched: number; skipped: number }>(`/accounts/${account.id}/import-file`, { items }));
    setBusy(false);
    if (r) {
      toast(`Imported ${r.imported}, matched ${r.matched}, skipped ${r.skipped} duplicate(s)`, 'success');
      onClose();
    }
  };

  return (
    <Modal
      title={`Import file into ${account.name}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!items.length || busy} onClick={doImport}>
            Import {items.length || ''} transaction{items.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <p className="muted">
        Download a <b>CSV</b>, <b>OFX</b> or <b>QFX</b> (Quicken/Web Connect) file from your bank's website and choose it here. Duplicates are skipped
        automatically and transactions you already entered by hand are matched.
      </p>
      <input type="file" accept=".csv,.txt,.ofx,.qfx" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Choose file" />
      {fileName && <p className="small muted">{fileName}</p>}

      {rows && (
        <div className="csv-map form">
          <label className="check-inline">
            <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} /> First row is a header
          </label>
          <div className="grid-3">
            <label>Date column {colSelect('date')}</label>
            <label>
              Date format
              <select value={dateFmt} onChange={(e) => setDateFmt(e.target.value as DateFmt)}>
                <option value="MDY">MM/DD/YYYY</option>
                <option value="DMY">DD/MM/YYYY</option>
                <option value="YMD">YYYY-MM-DD</option>
              </select>
            </label>
            <label>Payee / description {colSelect('payee')}</label>
            <label>Memo {colSelect('memo', true)}</label>
            <label>
              Amounts are in
              <select value={amountMode} onChange={(e) => setAmountMode(e.target.value as 'single' | 'split')}>
                <option value="single">One column (negative = outflow)</option>
                <option value="split">Separate outflow & inflow columns</option>
              </select>
            </label>
            {amountMode === 'single' ? (
              <>
                <label>Amount column {colSelect('amount')}</label>
                <label className="check-inline">
                  <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} /> Flip signs (positive = outflow, common for credit cards)
                </label>
              </>
            ) : (
              <>
                <label>Outflow column {colSelect('outflow')}</label>
                <label>Inflow column {colSelect('inflow')}</label>
              </>
            )}
          </div>
          {skippedRows > 0 && <p className="small warn-text">{skippedRows} row(s) couldn't be read with these settings and will be skipped.</p>}
        </div>
      )}

      {items.length > 0 && (
        <div className="preview">
          <h3>Preview</h3>
          <table className="simple-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Payee</th>
                <th>Memo</th>
                <th className="num">Outflow</th>
                <th className="num">Inflow</th>
              </tr>
            </thead>
            <tbody>
              {items.slice(0, 8).map((it) => (
                <tr key={it.importId}>
                  <td>{fmtDate(it.date)}</td>
                  <td>{it.payeeName}</td>
                  <td className="muted">{it.memo}</td>
                  <td className="num">{it.amount < 0 ? money(-it.amount) : ''}</td>
                  <td className="num">{it.amount > 0 ? money(it.amount) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items.length > 8 && <p className="small muted">…and {items.length - 8} more</p>}
        </div>
      )}
    </Modal>
  );
}
