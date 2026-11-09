import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './api';
import { configureFormat } from './format';
import type { Bootstrap } from './types';

interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

interface Ctx {
  data: Bootstrap;
  refresh: () => Promise<void>;
  /** Incremented after every mutation so pages can refetch their own data. */
  version: number;
  bump: () => void;
  toast: (text: string, kind?: Toast['kind']) => void;
  run: <T>(fn: () => Promise<T>, success?: string) => Promise<T | undefined>;
}

const AppContext = createContext<Ctx | null>(null);

export function useApp(): Ctx {
  const c = useContext(AppContext);
  if (!c) throw new Error('useApp outside provider');
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Bootstrap | null>(null);
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const b = await api.get<Bootstrap>('/bootstrap');
      configureFormat(b.settings);
      setData(b);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toast = useCallback((text: string, kind: Toast['kind'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);

  const bump = useCallback(() => {
    setVersion((v) => v + 1);
    refresh();
  }, [refresh]);

  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string) => {
      try {
        const r = await fn();
        bump();
        if (success) toast(success, 'success');
        return r;
      } catch (e) {
        toast((e as Error).message, 'error');
        return undefined;
      }
    },
    [bump, toast],
  );

  const value = useMemo(() => (data ? { data, refresh, version, bump, toast, run } : null), [data, refresh, version, bump, toast, run]);

  if (!value) {
    return (
      <div className="center-screen">
        {loadError ? (
          <div className="card">
            <p>Could not load your budget: {loadError}</p>
            <button className="btn" onClick={refresh}>
              Retry
            </button>
          </div>
        ) : (
          <div className="spinner" />
        )}
      </div>
    );
  }
  return (
    <AppContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
