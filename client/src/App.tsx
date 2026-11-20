import { lazy, Suspense, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api, setUnauthorizedHandler } from './api';
import { AppProvider } from './store';
import Sidebar from './components/Sidebar';
import BudgetPage from './components/BudgetPage';
import AccountPage from './components/AccountPage';
import SettingsPage from './components/SettingsPage';
import PayeesPage from './components/PayeesPage';
import ScheduledPage from './components/ScheduledPage';
import PlanPage from './components/PlanPage';
import PlaidOAuthReturn from './components/PlaidOAuthReturn';
import AuthScreen from './components/AuthScreen';
import MobileNav from './components/MobileNav';

// Charts library is large; load it only when Reports is opened.
const ReportsPage = lazy(() => import('./components/ReportsPage'));

export default function App() {
  const [auth, setAuth] = useState<{ setUp: boolean; authed: boolean } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const check = () => api.get('/auth/status').then(setAuth).catch(() => setAuth({ setUp: true, authed: false }));
    setUnauthorizedHandler(check);
    check();
  }, []);

  if (!auth) return <div className="center-screen"><div className="spinner" /></div>;
  if (!auth.authed) return <AuthScreen setUp={auth.setUp} onDone={() => setAuth({ setUp: true, authed: true })} />;

  return (
    <AppProvider>
      <div className={`layout ${sidebarOpen ? 'sidebar-open' : ''}`}>
        <Sidebar onNavigate={() => setSidebarOpen(false)} onLogout={() => setAuth({ setUp: true, authed: false })} />
        {sidebarOpen && <div className="drawer-backdrop" onClick={() => setSidebarOpen(false)} />}
        <main className="main">
          <Routes>
            <Route path="/" element={<Navigate to="/budget" replace />} />
            <Route path="/budget" element={<BudgetPage />} />
            <Route path="/budget/:month" element={<BudgetPage />} />
            <Route path="/review" element={<AccountPage review />} />
            <Route path="/accounts" element={<AccountPage />} />
            <Route path="/accounts/:accountId" element={<AccountPage />} />
            <Route path="/reports" element={<Suspense fallback={<div className="spinner" />}><ReportsPage /></Suspense>} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/payees" element={<PayeesPage />} />
            <Route path="/scheduled" element={<ScheduledPage />} />
            <Route path="/plan" element={<PlanPage />} />
            <Route path="/oauth-return" element={<PlaidOAuthReturn />} />
            <Route path="*" element={<Navigate to="/budget" replace />} />
          </Routes>
        </main>
        <MobileNav accountsOpen={sidebarOpen} onAccounts={() => setSidebarOpen((o) => !o)} />
      </div>
    </AppProvider>
  );
}
