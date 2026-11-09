export interface Account {
  id: number;
  name: string;
  type: string;
  onBudget: boolean;
  closed: boolean;
  note: string;
  lastReconciledAt: string | null;
  linked: boolean;
  connectionId: number | null;
  provider: 'plaid' | 'simplefin' | null;
  institution: string | null;
  connectionStatus: string | null;
  connectionError: string | null;
  lastImportAt: string | null;
  bankBalance: number | null;
  importStart: string | null;
  balance: number;
  clearedBalance: number;
  unclearedBalance: number;
  unapprovedCount: number;
}

export interface Group {
  id: number;
  name: string;
  hidden: number;
  system: string | null;
  sort: number;
}

export interface Category {
  id: number;
  groupId: number;
  name: string;
  hidden: number;
  kind: 'normal' | 'income' | 'cc_payment';
  linkedAccountId: number | null;
  sort: number;
}

export interface Payee {
  id: number;
  name: string;
  lastCategoryId: number | null;
}

export interface Settings {
  budgetName: string;
  currency: string;
  locale: string;
  dateFormat: string;
  syncIntervalHours: number;
  budgetMode: 'rolling' | 'monthly';
}

export interface Bootstrap {
  settings: Settings;
  accounts: Account[];
  groups: Group[];
  categories: Category[];
  payees: Payee[];
  plaid: { configured: boolean; env: string };
  unmappedConnections: number;
}

export interface Sub {
  id?: number;
  amount: number;
  categoryId: number | null;
  categoryName?: string | null;
  memo: string;
}

export interface Txn {
  id: number;
  accountId: number;
  accountName: string;
  date: string;
  amount: number;
  payeeId: number | null;
  payeeName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  counterpartCategoryId: number | null;
  counterpartCategoryName: string | null;
  memo: string;
  cleared: 'uncleared' | 'cleared' | 'reconciled';
  approved: boolean;
  flag: string | null;
  transferAccountId: number | null;
  transferAccountName: string | null;
  transferTxnId: number | null;
  isSplit: boolean;
  subtransactions: Sub[];
  importId: string | null;
  importedPayee: string | null;
  matched: boolean;
}

export interface TargetStatus {
  needed: number;
  funded: number;
  underfunded: number;
  complete: boolean;
  description: string;
}

export interface BudgetCategory {
  id: number;
  groupId: number;
  name: string;
  hidden: boolean;
  note: string;
  kind: 'normal' | 'income' | 'cc_payment';
  linkedAccountId: number | null;
  target: { type: string; amount: number; date: string | null } | null;
  targetStatus: TargetStatus | null;
  carry: number;
  assigned: number;
  activity: number;
  available: number;
  cashOverspent: number;
  creditOverspent: number;
}

export interface BudgetGroup {
  id: number;
  name: string;
  hidden: boolean;
  system: string | null;
  categories: BudgetCategory[];
}

export interface BudgetMonth {
  mode: 'rolling' | 'monthly';
  month: string;
  firstMonth: string;
  readyToAssign: {
    total: number;
    leftOver: number;
    incomeThisMonth: number;
    overspentPrev: number;
    assignedThisMonth: number;
    assignedFuture: number;
    rolling?: { total: number; income: number; assignedAll: number; cashOverspent: number; creditOverspent: number; trulyFree: number };
  };
  groups: BudgetGroup[];
  uncategorizedCount: number;
  ageOfMoney: number | null;
}

export interface Scheduled {
  id: number;
  accountId: number;
  accountName: string;
  nextDate: string;
  frequency: string;
  amount: number;
  payeeId: number | null;
  payeeName: string | null;
  categoryId: number | null;
  categoryName: string | null;
  transferAccountId: number | null;
  transferAccountName: string | null;
  memo: string;
  flag: string | null;
}

export interface Connection {
  id: number;
  provider: 'plaid' | 'simplefin';
  institution: string;
  status: 'ok' | 'error' | 'reauth';
  error: string | null;
  created_at: string;
  last_sync_at: string | null;
  accounts: {
    externalId: string;
    name: string;
    mask: string | null;
    kind: string | null;
    subtype: string | null;
    balance: number | null;
    localAccountId: number | null;
    localAccountName: string | null;
  }[];
}
