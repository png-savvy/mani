import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../store';
import { CategorySelect, Confirm } from './ui';

interface PayeeRow {
  id: number;
  name: string;
  lastCategoryName: string | null;
  transactionCount: number;
}
interface Rule {
  id: number;
  matchType: string;
  matchText: string;
  payeeName: string;
  categoryName: string | null;
}

export default function PayeesPage() {
  const { version, run } = useApp();
  const [payees, setPayees] = useState<PayeeRow[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  const [deleting, setDeleting] = useState<PayeeRow | null>(null);
  const [rule, setRule] = useState({ matchType: 'contains', matchText: '', payeeName: '', categoryId: null as number | null });

  useEffect(() => {
    api.get<PayeeRow[]>('/payees').then(setPayees);
    api.get<Rule[]>('/payee-rules').then(setRules);
  }, [version]);

  const shown = payees.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="page">
      <header className="page-head">
        <h1>Payees & Rules</h1>
      </header>

      <section className="card">
        <h2>Import rules</h2>
        <p className="muted small">
          When a bank description matches a rule, the imported transaction gets that payee (and optionally a category). Without a rule, the category you
          last used for a payee is filled in automatically.
        </p>
        <form
          className="rule-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const r = await run(() => api.post('/payee-rules', rule), 'Rule added');
            if (r !== undefined) setRule({ matchType: 'contains', matchText: '', payeeName: '', categoryId: null });
          }}
        >
          <span>If bank description</span>
          <select value={rule.matchType} onChange={(e) => setRule({ ...rule, matchType: e.target.value })}>
            <option value="contains">contains</option>
            <option value="starts_with">starts with</option>
            <option value="equals">equals</option>
          </select>
          <input placeholder="e.g. AMZN MKTP" value={rule.matchText} onChange={(e) => setRule({ ...rule, matchText: e.target.value })} />
          <span>rename to</span>
          <input list="rule-payees" placeholder="Payee" value={rule.payeeName} onChange={(e) => setRule({ ...rule, payeeName: e.target.value })} />
          <datalist id="rule-payees">{payees.map((p) => <option key={p.id} value={p.name} />)}</datalist>
          <span>and categorize as</span>
          <CategorySelect value={rule.categoryId} onChange={(v) => setRule({ ...rule, categoryId: v })} noneLabel="(remembered category)" />
          <button className="btn btn-small btn-primary" disabled={!rule.matchText.trim() || !rule.payeeName.trim()}>Add rule</button>
        </form>
        {rules.length > 0 && (
          <table className="simple-table">
            <tbody>
              {rules.map((r) => (
                <tr key={r.id}>
                  <td>Description {r.matchType.replace('_', ' ')} “{r.matchText}”</td>
                  <td>→ {r.payeeName}</td>
                  <td className="muted">{r.categoryName ?? ''}</td>
                  <td className="num"><button className="btn btn-tiny btn-danger-ghost" onClick={() => run(() => api.del(`/payee-rules/${r.id}`))}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Payees</h2>
          <input className="search" placeholder="Search payees" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <p className="muted small">Rename a payee to the name of another payee to merge them.</p>
        <table className="simple-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Remembered category</th>
              <th className="num">Transactions</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td>
                  {editing?.id === p.id ? (
                    <form
                      className="inline-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        await run(() => api.put(`/payees/${p.id}`, { name: editing.name }));
                        setEditing(null);
                      }}
                    >
                      <input autoFocus value={editing.name} onChange={(e) => setEditing({ id: p.id, name: e.target.value })} />
                      <button className="btn btn-tiny btn-primary">Save</button>
                      <button type="button" className="btn btn-tiny btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                    </form>
                  ) : (
                    p.name
                  )}
                </td>
                <td className="muted">{p.lastCategoryName ?? ''}</td>
                <td className="num">{p.transactionCount}</td>
                <td className="num">
                  <button className="btn btn-tiny btn-ghost" onClick={() => setEditing({ id: p.id, name: p.name })}>Rename</button>
                  <button className="btn btn-tiny btn-danger-ghost" onClick={() => setDeleting(p)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      {deleting && (
        <Confirm
          title={`Delete payee "${deleting.name}"?`}
          danger
          confirmLabel="Delete"
          message={`${deleting.transactionCount} transaction(s) will keep their amounts but lose this payee name.`}
          onConfirm={() => run(() => api.del(`/payees/${deleting.id}`))}
          onClose={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
