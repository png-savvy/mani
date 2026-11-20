import type { Txn } from '../types';

/** A memo Mani wrote from Amazon data (as opposed to one you typed). Mirrors AUTO_MEMO in server/amazon.ts. */
const AUTO_MEMO = /^Amazon( refund)?( \(charge (\d+) of (\d+)\))?(: .*)?$/;

/** The memo to show next to a transaction: yours if you wrote one; Mani's Amazon summary is replaced by the full item list. */
export function displayMemo(t: Txn): string {
  return t.amazon?.items.length && AUTO_MEMO.test(t.memo) ? '' : t.memo;
}

/** Full Amazon item names for a transaction matched to an Amazon order (nothing otherwise). */
export default function AmazonItems({ t, className = '' }: { t: Txn; className?: string }) {
  if (!t.amazon?.items.length) return null;
  const part = AUTO_MEMO.exec(t.memo);
  const partNote = part?.[3] ? ` · charge ${part[3]} of ${part[4]}` : '';
  return (
    <div className={`amz-items ${className}`}>
      <span className="amz-label">
        Amazon{t.amount > 0 ? ' refund' : ''}
        {partNote}
      </span>
      <ul>
        {t.amazon.items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
