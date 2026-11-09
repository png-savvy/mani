// Loads Plaid Link (the bank-login popup) on demand and runs it.

declare global {
  interface Window {
    Plaid?: {
      create: (cfg: Record<string, unknown>) => { open: () => void; exit: (o?: unknown) => void; destroy: () => void };
    };
  }
}

let loading: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.Plaid) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
      s.onload = () => resolve();
      s.onerror = () => {
        loading = null;
        reject(new Error('Could not load Plaid Link. Check your internet connection or ad blocker.'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

export interface PlaidSuccess {
  publicToken: string;
  institution: string;
}

const STORAGE_KEY = 'mani.plaid.pending';

/** Opens Plaid Link. Resolves with the public token, or null if the user closed it. */
export async function openPlaidLink(linkToken: string, opts: { connectionId?: number; receivedRedirectUri?: string } = {}): Promise<PlaidSuccess | null> {
  await loadScript();
  // Remember the token so the OAuth redirect page (/oauth-return) can resume the same Link session.
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ linkToken, connectionId: opts.connectionId ?? null }));
  } catch {
    /* storage unavailable */
  }
  return new Promise((resolve, reject) => {
    const handler = window.Plaid!.create({
      token: linkToken,
      receivedRedirectUri: opts.receivedRedirectUri,
      onSuccess: (publicToken: string, metadata: any) => {
        clearPendingLink();
        resolve({ publicToken, institution: metadata?.institution?.name ?? '' });
        handler.destroy();
      },
      onExit: (err: any) => {
        clearPendingLink();
        handler.destroy();
        if (err) reject(new Error(err.display_message || err.error_message || 'Bank connection was not completed'));
        else resolve(null);
      },
    });
    handler.open();
  });
}

export function pendingLink(): { linkToken: string; connectionId: number | null } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearPendingLink() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
