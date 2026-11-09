import { useEffect, useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, Legend } from 'recharts';
import { api } from '../api';
import { useApp } from '../store';
import { fmtMonth, money } from '../format';
import { addMonths, currentMonth } from '../../../shared/util';

type Tab = 'spending' | 'networth' | 'incexp';

const RANGES: [string, number][] = [
  ['This month', 1],
  ['Last 3 months', 3],
  ['Last 6 months', 6],
  ['Last 12 months', 12],
  ['Last 24 months', 24],
];

const compact = (cents: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <div className="strong">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey}>
          <span className="swatch" style={{ background: p.color || p.fill }} /> {p.name}: <b>{money(p.value)}</b>
        </div>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>('spending');
  const [months, setMonths] = useState(6);
  const to = currentMonth();
  const from = addMonths(to, -(months - 1));
  return (
    <div className="page reports">
      <header className="page-head">
        <h1>Reports</h1>
        <div className="chips">
          {(
            [
              ['spending', 'Spending'],
              ['networth', 'Net Worth'],
              ['incexp', 'Income v Expense'],
            ] as [Tab, string][]
          ).map(([t, l]) => (
            <button key={t} className={`chip ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{l}</button>
          ))}
        </div>
        <select value={months} onChange={(e) => setMonths(Number(e.target.value))} aria-label="Date range">
          {RANGES.map(([l, n]) => (
            <option key={n} value={n}>{l}</option>
          ))}
        </select>
      </header>
      {tab === 'spending' && <Spending from={from} to={to} />}
      {tab === 'networth' && <NetWorth from={from} to={to} />}
      {tab === 'incexp' && <IncomeExpense from={from} to={to} />}
    </div>
  );
}

function Spending({ from, to }: { from: string; to: string }) {
  const { version } = useApp();
  const [rows, setRows] = useState<{ categoryName: string; groupName: string; month: string; spent: number }[] | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  useEffect(() => {
    api.get(`/reports/spending?from=${from}&to=${to}`).then((r) => setRows(r.rows));
  }, [from, to, version]);

  const { bars, total, byMonth } = useMemo(() => {
    const m = new Map<string, number>();
    const mm = new Map<string, number>();
    for (const r of rows ?? []) {
      if (group && r.groupName !== group) continue;
      const key = group ? r.categoryName : r.groupName;
      m.set(key, (m.get(key) ?? 0) + r.spent);
      mm.set(r.month, (mm.get(r.month) ?? 0) + r.spent);
    }
    const bars = [...m.entries()].map(([name, spent]) => ({ name, spent })).filter((b) => b.spent > 0).sort((a, b) => b.spent - a.spent);
    const months: { month: string; spent: number }[] = [];
    for (let x = from; x <= to; x = addMonths(x, 1)) months.push({ month: fmtMonth(x, 'short'), spent: mm.get(x) ?? 0 });
    return { bars, total: bars.reduce((s, b) => s + b.spent, 0), byMonth: months };
  }, [rows, group, from, to]);

  if (!rows) return <div className="spinner" />;
  return (
    <div className="report-grid">
      <div className="card">
        <div className="card-head">
          <div>
            <div className="muted small">Total spending{group ? ` · ${group}` : ''}</div>
            <div className="hero">{money(total)}</div>
            <div className="muted small">Average {money(Math.round(total / byMonth.length))}/month</div>
          </div>
          {group && <button className="btn btn-small btn-ghost" onClick={() => setGroup(null)}>← All groups</button>}
        </div>
        {bars.length === 0 ? (
          <p className="muted">No spending in this period.</p>
        ) : (
          <ResponsiveContainer width="100%" height={Math.max(160, bars.length * 34 + 30)}>
            <BarChart data={bars} layout="vertical" margin={{ left: 8, right: 24 }}>
              <CartesianGrid horizontal={false} stroke="var(--grid)" />
              <XAxis type="number" tickFormatter={compact} stroke="var(--axis)" fontSize={12} />
              <YAxis type="category" dataKey="name" width={140} stroke="var(--axis)" fontSize={12} />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--hover)' }} />
              <Bar
                dataKey="spent"
                name="Spent"
                fill="var(--series-1)"
                radius={[0, 4, 4, 0]}
                barSize={20}
                onClick={(d: any) => !group && setGroup(d.name)}
                style={{ cursor: group ? 'default' : 'pointer' }}
              />
            </BarChart>
          </ResponsiveContainer>
        )}
        {!group && bars.length > 0 && <p className="muted small">Click a group to see its categories.</p>}
      </div>
      <div className="card">
        <div className="muted small">Spending by month</div>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={byMonth} margin={{ top: 12, right: 12 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="month" stroke="var(--axis)" fontSize={12} />
            <YAxis tickFormatter={compact} stroke="var(--axis)" fontSize={12} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--hover)' }} />
            <Bar dataKey="spent" name="Spent" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={48} />
          </BarChart>
        </ResponsiveContainer>
        <table className="simple-table">
          <thead>
            <tr>
              <th>{group ? 'Category' : 'Group'}</th>
              <th className="num">Total</th>
              <th className="num">%</th>
            </tr>
          </thead>
          <tbody>
            {bars.map((b) => (
              <tr key={b.name}>
                <td>{b.name}</td>
                <td className="num">{money(b.spent)}</td>
                <td className="num">{total ? ((b.spent / total) * 100).toFixed(1) : 0}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NetWorth({ from, to }: { from: string; to: string }) {
  const { version } = useApp();
  const [data, setData] = useState<{ month: string; assets: number; debts: number; netWorth: number }[] | null>(null);
  useEffect(() => {
    api.get(`/reports/net-worth?from=${from}&to=${to}`).then((r) => setData(r.months));
  }, [from, to, version]);
  if (!data) return <div className="spinner" />;
  const last = data[data.length - 1];
  const first = data[0];
  const chart = data.map((d) => ({ ...d, label: fmtMonth(d.month, 'short') }));
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="muted small">Net worth</div>
          <div className="hero">{money(last?.netWorth ?? 0)}</div>
          {first && last && (
            <div className={`small ${last.netWorth - first.netWorth < 0 ? 'neg' : 'pos'}`}>
              {last.netWorth - first.netWorth >= 0 ? '▲' : '▼'} {money(Math.abs(last.netWorth - first.netWorth))} over this period
            </div>
          )}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={chart} margin={{ top: 12, right: 12 }} barGap={2}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" stroke="var(--axis)" fontSize={12} />
          <YAxis tickFormatter={compact} stroke="var(--axis)" fontSize={12} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--hover)' }} />
          <Legend />
          <Bar dataKey="assets" name="Assets" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={36} />
          <Bar dataKey="debts" name="Debts" fill="var(--series-2)" radius={[0, 0, 4, 4]} maxBarSize={36} />
          <Line dataKey="netWorth" name="Net worth" stroke="var(--text)" strokeWidth={2} dot={{ r: 4 }} type="monotone" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function IncomeExpense({ from, to }: { from: string; to: string }) {
  const { version } = useApp();
  const [d, setD] = useState<{ income: { payee: string; month: string; total: number }[]; expenses: { categoryName: string; groupName: string; month: string; total: number }[] } | null>(null);
  useEffect(() => {
    api.get(`/reports/income-expense?from=${from}&to=${to}`).then(setD);
  }, [from, to, version]);
  const months: string[] = [];
  for (let x = from; x <= to; x = addMonths(x, 1)) months.push(x);
  if (!d) return <div className="spinner" />;

  const pivot = <T,>(rows: T[], key: (r: T) => string, amt: (r: T) => number, month: (r: T) => string) => {
    const m = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const k = key(r);
      if (!m.has(k)) m.set(k, new Map());
      const mm = m.get(k)!;
      mm.set(month(r), (mm.get(month(r)) ?? 0) + amt(r));
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  const income = pivot(d.income, (r) => r.payee, (r) => r.total, (r) => r.month);
  const expenses = pivot(d.expenses, (r) => r.groupName, (r) => -r.total, (r) => r.month);
  const sumMonth = (rows: [string, Map<string, number>][], m: string) => rows.reduce((s, [, mm]) => s + (mm.get(m) ?? 0), 0);
  const sumRow = (mm: Map<string, number>) => months.reduce((s, m) => s + (mm.get(m) ?? 0), 0);
  const chart = months.map((m) => ({ label: fmtMonth(m, 'short'), income: sumMonth(income, m), expenses: sumMonth(expenses, m) }));
  const totalIn = chart.reduce((s, c) => s + c.income, 0);
  const totalOut = chart.reduce((s, c) => s + c.expenses, 0);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <div className="muted small">Net income</div>
          <div className={`hero ${totalIn - totalOut < 0 ? 'neg' : ''}`}>{money(totalIn - totalOut)}</div>
          <div className="muted small">Income {money(totalIn)} · Expenses {money(totalOut)}</div>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={chart} margin={{ top: 12, right: 12 }} barGap={2}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" stroke="var(--axis)" fontSize={12} />
          <YAxis tickFormatter={compact} stroke="var(--axis)" fontSize={12} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--hover)' }} />
          <Legend />
          <Bar dataKey="income" name="Income" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={28} />
          <Bar dataKey="expenses" name="Expenses" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={28} />
        </BarChart>
      </ResponsiveContainer>
      <div className="table-scroll">
        <table className="simple-table pivot">
          <thead>
            <tr>
              <th />
              {months.map((m) => (
                <th key={m} className="num">{fmtMonth(m, 'short')}</th>
              ))}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            <tr className="section"><td colSpan={months.length + 2}>Income</td></tr>
            {income.map(([k, mm]) => (
              <tr key={'i' + k}>
                <td>{k}</td>
                {months.map((m) => <td key={m} className="num">{money(mm.get(m) ?? 0)}</td>)}
                <td className="num strong">{money(sumRow(mm))}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Total income</td>
              {months.map((m) => <td key={m} className="num">{money(sumMonth(income, m))}</td>)}
              <td className="num">{money(totalIn)}</td>
            </tr>
            <tr className="section"><td colSpan={months.length + 2}>Expenses</td></tr>
            {expenses.map(([k, mm]) => (
              <tr key={'e' + k}>
                <td>{k}</td>
                {months.map((m) => <td key={m} className="num">{money(mm.get(m) ?? 0)}</td>)}
                <td className="num strong">{money(sumRow(mm))}</td>
              </tr>
            ))}
            <tr className="total">
              <td>Total expenses</td>
              {months.map((m) => <td key={m} className="num">{money(sumMonth(expenses, m))}</td>)}
              <td className="num">{money(totalOut)}</td>
            </tr>
            <tr className="total">
              <td>Net income</td>
              {months.map((m) => <td key={m} className="num">{money(sumMonth(income, m) - sumMonth(expenses, m))}</td>)}
              <td className="num">{money(totalIn - totalOut)}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
