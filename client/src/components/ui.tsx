import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../store';
import { moneyInput } from '../format';
import { evalArithmetic } from '../../../shared/util';

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  dismissOnBackdrop = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  dismissOnBackdrop?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Rendered at the end of <body> so sticky/positioned parents can never draw on top of it.
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => dismissOnBackdrop && e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-header">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Parses a money entry ("12.5", "1,000", "20+5") into cents; null when blank/invalid. */
export function parseCents(s: string): number | null {
  const cleaned = s.replace(/[^\d.+\-*/()]/g, '');
  if (!cleaned) return null;
  const v = evalArithmetic(cleaned);
  return v === null || !Number.isFinite(v) ? null : Math.round(v * 100);
}

/**
 * Text input for money that supports math. Commits on blur/Enter.
 * A leading + or - (when `relative`) adds to / subtracts from the current value.
 */
export function MoneyField({
  value,
  onCommit,
  relative,
  autoFocus,
  className,
  placeholder,
  ariaLabel,
  allowNegative = true,
}: {
  value: number;
  onCommit: (cents: number) => void;
  relative?: boolean;
  autoFocus?: boolean;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  allowNegative?: boolean;
}) {
  const [text, setText] = useState(moneyInput(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(moneyInput(value));
  }, [value, focused]);
  const commit = () => {
    const raw = text.trim();
    let next: number | null;
    if (raw === '') next = 0;
    else if (relative && /^[+-]/.test(raw) && value !== 0) {
      const delta = parseCents(raw.slice(1));
      next = delta === null ? null : raw[0] === '+' ? value + delta : value - delta;
    } else next = parseCents(raw);
    if (next === null || (!allowNegative && next < 0)) {
      setText(moneyInput(value));
      return;
    }
    if (next !== value) onCommit(next);
    setText(moneyInput(next));
  };
  return (
    <input
      className={`money-input ${className ?? ''}`}
      value={text}
      inputMode="decimal"
      autoFocus={autoFocus}
      placeholder={placeholder ?? '0.00'}
      aria-label={ariaLabel}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setText(moneyInput(value));
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
      onChange={(e) => setText(e.target.value)}
    />
  );
}

/** Grouped category <select>. Shows Ready to Assign first; hides credit card payment categories. */
export function CategorySelect({
  value,
  onChange,
  allowNone = true,
  noneLabel = 'Uncategorized',
  includeIncome = true,
  includeHidden = false,
  className,
  id,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  allowNone?: boolean;
  noneLabel?: string;
  includeIncome?: boolean;
  includeHidden?: boolean;
  className?: string;
  id?: string;
}) {
  const { data } = useApp();
  const groups = useMemo(
    () =>
      data.groups
        .filter((g) => g.system !== 'credit_card_payments')
        .map((g) => ({
          g,
          cats: data.categories.filter(
            (c) =>
              c.groupId === g.id &&
              c.kind !== 'cc_payment' &&
              (includeIncome || c.kind !== 'income') &&
              (includeHidden || !c.hidden || c.id === value || c.kind === 'income'),
          ),
        }))
        .filter((x) => x.cats.length),
    [data, includeIncome, includeHidden, value],
  );
  return (
    <select
      id={id}
      className={className}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      {allowNone && <option value="">{noneLabel}</option>}
      {groups.map(({ g, cats }) =>
        g.system === 'internal' ? (
          cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))
        ) : (
          <optgroup key={g.id} label={g.name}>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.hidden ? ' (hidden)' : ''}
              </option>
            ))}
          </optgroup>
        ),
      )}
    </select>
  );
}

export const TRANSFER_PREFIX = 'Transfer : ';

/** Free-text payee box with suggestions for existing payees and "Transfer : <account>" entries. */
export function PayeeField({
  value,
  onChange,
  excludeAccountId,
  autoFocus,
  listId,
}: {
  value: string;
  onChange: (v: string) => void;
  excludeAccountId?: number;
  autoFocus?: boolean;
  listId: string;
}) {
  const { data } = useApp();
  return (
    <>
      <input
        list={listId}
        value={value}
        autoFocus={autoFocus}
        placeholder="Payee"
        aria-label="Payee"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {data.accounts
          .filter((a) => !a.closed && a.id !== excludeAccountId)
          .map((a) => (
            <option key={'a' + a.id} value={TRANSFER_PREFIX + a.name} />
          ))}
        {data.payees
          .filter((p) => p.name !== 'Starting Balance' && p.name !== 'Reconciliation Balance Adjustment')
          .map((p) => (
            <option key={p.id} value={p.name} />
          ))}
      </datalist>
    </>
  );
}

export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const fn = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, [onOutside]);
  return ref;
}

export function Confirm({
  title,
  message,
  confirmLabel = 'Confirm',
  danger,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div>{message}</div>
    </Modal>
  );
}

/** Full-screen panel on phones (slides up), centered dialog on larger screens. */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return createPortal(
    <div className="sheet-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-header">
          <button className="sheet-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
          <h2>{title}</h2>
          <span className="sheet-header-spacer" />
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
