import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * The phone form of a table. A workshop table is never scrolled sideways on
 * a phone: the same rows are shown as cards, with the heading of each column
 * beside its value, so nothing is dropped to make it fit. The table itself
 * is kept for tablets and desktops, where columns can be compared at a
 * glance.
 */

/** The cards that replace a table's rows below `md`. */
export function RecordList({ children, className }: { children: ReactNode; className?: string }) {
  return <ul className={cn('divide-y divide-border md:hidden', className)}>{children}</ul>;
}

/** One row of a table, as a card: what it is, what it costs, and its details. */
export function RecordCard({
  title,
  subtitle,
  amount,
  status,
  details,
  footer,
  className,
  children,
  select,
  action,
}: {
  /** A tick box before the title, for choosing rows (see RecordSelection). */
  select?: ReactNode;
  /** A small action after the amount, e.g. the row's delete button. */
  action?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  amount?: ReactNode;
  status?: ReactNode;
  /** Label/value pairs — the table's other columns. Empty values are dropped. */
  details?: { label: string; value: ReactNode }[];
  footer?: ReactNode;
  className?: string;
  children?: ReactNode;
}) {
  const shown = (details ?? []).filter(
    (detail) => detail.value !== null && detail.value !== undefined,
  );
  return (
    <li className={cn('flex flex-col gap-3 px-4 py-4', className)}>
      <div className="flex items-start justify-between gap-3">
        {select ? <span className="flex h-5 items-center">{select}</span> : null}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-sm font-medium">{title}</span>
          {subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {amount ? <span className="text-sm font-semibold tabular-nums">{amount}</span> : null}
          {status}
        </div>
        {action ? <span className="-mt-2 -mr-2 flex">{action}</span> : null}
      </div>
      {shown.length > 0 ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          {shown.map((detail) => (
            <div key={detail.label} className="contents">
              <dt className="text-muted-foreground">{detail.label}</dt>
              <dd className="text-right tabular-nums">{detail.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {children}
      {footer ? <div className="text-xs text-muted-foreground">{footer}</div> : null}
    </li>
  );
}

/** Wraps a table so it only shows from `md` upward, next to a `RecordList`. */
export function TableWrap({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('hidden overflow-x-auto md:block', className)}>{children}</div>;
}
