import { db } from './db.ts';
import { saveTransaction } from './txns.ts';
import { connectionsToRetrySoon, syncAll, syncConnection, syncIntervalHours } from './banks.ts';
import { nextOccurrence, todayISO, type Frequency } from '../shared/util.ts';

interface ScheduledRow {
  id: number;
  account_id: number;
  next_date: string;
  anchor_day: number;
  frequency: Frequency;
  amount: number;
  payee_id: number | null;
  category_id: number | null;
  transfer_account_id: number | null;
  memo: string;
  flag: string | null;
}

/** Enters every scheduled transaction whose date has arrived, then advances it. */
export function enterDueScheduled() {
  const today = todayISO();
  const due = db.prepare(`SELECT * FROM scheduled WHERE next_date <= ?`).all(today) as ScheduledRow[];
  let entered = 0;
  for (const s of due) {
    db.transaction(() => {
      let date: string | null = s.next_date;
      let guard = 0;
      while (date && date <= today && guard++ < 1000) {
        saveTransaction({
          accountId: s.account_id,
          date,
          amount: s.amount,
          payeeId: s.payee_id,
          transferAccountId: s.transfer_account_id,
          categoryId: s.category_id,
          memo: s.memo,
          flag: s.flag,
          cleared: 'uncleared',
          approved: true,
        });
        entered++;
        date = nextOccurrence(date, s.frequency, s.anchor_day);
      }
      if (date) db.prepare(`UPDATE scheduled SET next_date = ? WHERE id = ?`).run(date, s.id);
      else db.prepare(`DELETE FROM scheduled WHERE id = ?`).run(s.id);
    })();
  }
  return entered;
}

let lastSync = 0;
let lastRetry = 0;
let earlyRetries = 0;
const RETRY_MINUTES = 15;
/** Early retries between two regular syncs; after that the regular interval takes over again. */
const MAX_EARLY_RETRIES = 8;

export function startScheduler() {
  const tick = async () => {
    try {
      enterDueScheduled();
    } catch (e) {
      console.error('Scheduled transaction error:', e);
    }
    const hours = syncIntervalHours();
    if (hours > 0 && Date.now() - lastSync >= hours * 3600000) {
      lastSync = Date.now();
      try {
        const r = await syncAll({ notify: true });
        if (Object.keys(r).length) console.log(new Date().toISOString(), 'Bank sync:', JSON.stringify(r, (k, v) => (k === 'newIds' ? undefined : v)));
      } catch (e) {
        console.error('Bank sync error:', e);
      }
      earlyRetries = 0;
      lastRetry = Date.now();
    } else if (hours > 0 && Date.now() - lastRetry >= RETRY_MINUTES * 60000 && earlyRetries < MAX_EARLY_RETRIES) {
      // A sync failed for a passing reason (bank/network trouble) or the bank is still sending history:
      // don't wait for the next full interval.
      const ids = connectionsToRetrySoon();
      if (ids.length) {
        earlyRetries++;
        lastRetry = Date.now();
        for (const id of ids) {
          try {
            const r = await syncConnection(id, { notify: true });
            console.log(new Date().toISOString(), `Bank sync retry (connection ${id}):`, JSON.stringify({ ...r, newIds: undefined }));
          } catch (e) {
            console.error(new Date().toISOString(), `Bank sync retry failed (connection ${id}):`, (e as Error).message);
          }
        }
      }
    }
  };
  // First run shortly after boot, then every 5 minutes (cheap: only acts when something is due).
  setTimeout(tick, 5000);
  setInterval(tick, 5 * 60000);
}
