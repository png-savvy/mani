import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useApp } from '../store';
import { Sheet } from './ui';
import TxnEditor from './TxnEditor';

/** Bottom tab bar shown on phones (like a native budgeting app). */
export default function MobileNav({ onAccounts, accountsOpen }: { onAccounts: () => void; accountsOpen: boolean }) {
  const { data } = useApp();
  const location = useLocation();
  const [adding, setAdding] = useState(false);
  const unapproved = data.accounts.reduce((s, a) => s + a.unapprovedCount, 0);
  // Pre-select the account you're looking at when adding from an account screen.
  const m = /^\/accounts\/(\d+)/.exec(location.pathname);
  const currentAccount = m ? Number(m[1]) : null;

  return (
    <>
      <nav className="mobile-nav" aria-label="Main">
        <NavLink to="/budget" className="mnav-item">
          <span className="mnav-icon">▦</span>
          <span>Budget</span>
        </NavLink>
        <button className={`mnav-item ${accountsOpen || location.pathname.startsWith('/accounts') ? 'active' : ''}`} onClick={onAccounts}>
          <span className="mnav-icon">≡</span>
          <span>Accounts</span>
          {unapproved > 0 && <span className="badge mnav-badge">{unapproved}</span>}
        </button>
        <button className="mnav-add" onClick={() => setAdding(true)} aria-label="Add transaction" disabled={!data.accounts.some((a) => !a.closed)}>
          +
        </button>
        <NavLink to="/reports" className="mnav-item">
          <span className="mnav-icon">◔</span>
          <span>Reports</span>
        </NavLink>
        <NavLink to="/settings" className="mnav-item">
          <span className="mnav-icon">⚙</span>
          <span>Settings</span>
        </NavLink>
      </nav>
      {adding && (
        <Sheet title="New transaction" onClose={() => setAdding(false)}>
          <TxnEditor txn={null} accountId={currentAccount} showAccount onDone={() => setAdding(false)} />
        </Sheet>
      )}
    </>
  );
}
