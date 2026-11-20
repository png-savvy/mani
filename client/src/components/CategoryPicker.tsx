import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { money } from '../format';
import { Sheet } from './ui';
import type { BudgetMonth } from '../types';
import { currentMonth } from '../../../shared/util';

/**
 * Full-screen, searchable category list with each category's balance — the touch-friendly way to categorize.
 * Credit card payment categories are never offered (they're funded automatically).
 */
export default function CategoryPicker({
  value,
  onSelect,
  onClear,
  onClose,
  title = 'Choose category',
  includeIncome = true,
}: {
  value: number | null;
  onSelect: (id: number) => void;
  /** When given (and a category is set), offers taking the category off, which sends the transaction back to review. */
  onClear?: () => void;
  onClose: () => void;
  title?: string;
  includeIncome?: boolean;
}) {
  const { data } = useApp();
  const [q, setQ] = useState('');
  const [balances, setBalances] = useState<Map<number, number>>(new Map());

  useEffect(() => {
    api
      .get<BudgetMonth>(`/budget/${currentMonth()}`)
      .then((v) => setBalances(new Map(v.groups.flatMap((g) => g.categories.map((c) => [c.id, c.available] as const)))))
      .catch(() => {});
  }, []);

  const income = data.categories.find((c) => c.kind === 'income');
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return data.groups
      .filter((g) => !g.system && (!g.hidden || data.categories.some((c) => c.groupId === g.id && c.id === value)))
      .map((g) => ({
        g,
        cats: data.categories.filter(
          (c) =>
            c.groupId === g.id &&
            c.kind === 'normal' &&
            (!c.hidden || c.id === value) &&
            (!needle || c.name.toLowerCase().includes(needle) || g.name.toLowerCase().includes(needle)),
        ),
      }))
      .filter((x) => x.cats.length);
  }, [data, q, value]);

  const showIncome = includeIncome && income && (!q || income.name.toLowerCase().includes(q.trim().toLowerCase()) || 'income'.includes(q.trim().toLowerCase()));

  return (
    <Sheet title={title} onClose={onClose}>
      <div className="picker">
        <input className="picker-search" type="search" placeholder="Search categories" value={q} onChange={(e) => setQ(e.target.value)} />
        {onClear && value !== null && !q && (
          <div className="picker-group">
            <button className="picker-item picker-clear" onClick={onClear}>
              <span>No category — send back to review</span>
            </button>
          </div>
        )}
        {showIncome && (
          <div className="picker-group">
            <div className="picker-group-name">Income</div>
            <button className={`picker-item ${value === income!.id ? 'active' : ''}`} onClick={() => onSelect(income!.id)}>
              <span>Ready to Assign (income)</span>
            </button>
          </div>
        )}
        {groups.map(({ g, cats }) => (
          <div key={g.id} className="picker-group">
            <div className="picker-group-name">{g.name}</div>
            {cats.map((c) => {
              const bal = balances.get(c.id);
              return (
                <button key={c.id} className={`picker-item ${value === c.id ? 'active' : ''}`} onClick={() => onSelect(c.id)}>
                  <span>{c.name}</span>
                  {bal !== undefined && (
                    <span className={`pill ${bal < 0 ? 'pill-neg' : bal > 0 ? 'pill-pos' : 'pill-zero'}`}>{money(bal)}</span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        {!groups.length && !showIncome && <p className="muted center">No categories match “{q}”.</p>}
      </div>
    </Sheet>
  );
}
