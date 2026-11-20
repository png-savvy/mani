import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useApp } from '../store';
import { money } from '../format';
import { api } from '../api';
import AddAccountModal from './AddAccountModal';
import type { Account } from '../types';

function sectionOf(a: Account): string {
  if (!a.onBudget) return a.type === 'asset' ? 'Tracking' : 'Loans';
  return a.type === 'credit_card' || a.type === 'line_of_credit' ? 'Credit' : 'Cash';
}

export default function Sidebar({ onNavigate, onLogout }: { onNavigate: () => void; onLogout: () => void }) {
  const { data } = useApp();
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showClosed, setShowClosed] = useState(false);

  const open = data.accounts.filter((a) => !a.closed);
  const closed = data.accounts.filter((a) => a.closed);
  const sections = ['Cash', 'Credit', 'Loans', 'Tracking']
    .map((name) => ({ name, accounts: open.filter((a) => sectionOf(a) === name) }))
    .filter((s) => s.accounts.length);
  const unapproved = data.accounts.reduce((s, a) => s + a.reviewCount, 0);
  const total = open.reduce((s, a) => s + a.balance, 0);

  return (
    <aside className="sidebar">
      <div className="brand">
        <img src="/mani-coin-128.png" alt="" width={28} height={28} />
        <div>
          <div className="brand-name">{data.settings.budgetName}</div>
          <div className="brand-sub">Mani</div>
        </div>
      </div>
      <nav className="nav" onClick={onNavigate}>
        <NavLink to="/budget" className="nav-item">
          <span className="nav-icon">▦</span> Budget
        </NavLink>
        <NavLink to="/reports" className="nav-item">
          <span className="nav-icon">◔</span> Reports
        </NavLink>
        <NavLink to="/review" className="nav-item">
          <span className="nav-icon">✓</span> Review
          {unapproved > 0 && <span className="badge">{unapproved}</span>}
        </NavLink>
        <NavLink to="/accounts" end className="nav-item">
          <span className="nav-icon">≡</span> All Accounts
        </NavLink>
      </nav>

      <div className="accounts-list" onClick={onNavigate}>
        {sections.map((s) => {
          const sum = s.accounts.reduce((x, a) => x + a.balance, 0);
          return (
            <div key={s.name} className="acct-section">
              <button
                className="acct-section-head"
                onClick={(e) => {
                  e.stopPropagation();
                  setCollapsed((c) => ({ ...c, [s.name]: !c[s.name] }));
                }}
              >
                <span>
                  {collapsed[s.name] ? '▸' : '▾'} {s.name.toUpperCase()}
                </span>
                <span className={sum < 0 ? 'neg' : ''}>{money(sum)}</span>
              </button>
              {!collapsed[s.name] &&
                s.accounts.map((a) => (
                  <NavLink key={a.id} to={`/accounts/${a.id}`} className="acct-item">
                    <span className="acct-name">
                      {a.linked && (
                        <span
                          className={`link-dot ${a.connectionStatus === 'ok' ? 'ok' : 'bad'}`}
                          title={a.connectionStatus === 'ok' ? 'Linked for automatic import' : `Connection problem: ${a.connectionError ?? ''}`}
                        />
                      )}
                      {a.name}
                    </span>
                    <span className={a.balance < 0 ? 'neg' : ''}>{money(a.balance)}</span>
                  </NavLink>
                ))}
            </div>
          );
        })}
        {closed.length > 0 && (
          <div className="acct-section">
            <button
              className="acct-section-head"
              onClick={(e) => {
                e.stopPropagation();
                setShowClosed((v) => !v);
              }}
            >
              <span>{showClosed ? '▾' : '▸'} CLOSED</span>
            </button>
            {showClosed &&
              closed.map((a) => (
                <NavLink key={a.id} to={`/accounts/${a.id}`} className="acct-item closed">
                  <span className="acct-name">{a.name}</span>
                  <span>{money(a.balance)}</span>
                </NavLink>
              ))}
          </div>
        )}
        {open.length > 0 && (
          <div className="acct-total">
            <span>Net total</span>
            <span className={total < 0 ? 'neg' : ''}>{money(total)}</span>
          </div>
        )}
      </div>

      <button className="add-account" onClick={() => setAdding(true)}>
        + Add Account
      </button>

      <nav className="nav nav-bottom" onClick={onNavigate}>
        <NavLink to="/plan" className="nav-item small">
          Monthly Plan
        </NavLink>
        <NavLink to="/scheduled" className="nav-item small">
          Scheduled
        </NavLink>
        <NavLink to="/payees" className="nav-item small">
          Payees & Rules
        </NavLink>
        <NavLink to="/settings" className="nav-item small">
          Settings & Bank Connections
        </NavLink>
        <button
          className="nav-item small"
          onClick={async () => {
            await api.post('/auth/logout');
            onLogout();
          }}
        >
          Log out
        </button>
      </nav>
      {adding && <AddAccountModal onClose={() => setAdding(false)} />}
    </aside>
  );
}
