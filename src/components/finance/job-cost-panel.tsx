import Link from 'next/link';
import type { JobCost } from '@/lib/finance/job-costing';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { filsToString } from '@/lib/money';
import { Panel } from '@/components/layout/primitives';
import { cn } from '@/lib/utils';

/** "−1,234.50" / "1,234.50" from signed fils. */
const signed = (value: number) =>
  `${value < 0 ? '−' : ''}${formatMoney(filsToString(Math.abs(value)))}`;

/**
 * What the job cost the workshop and what it made: sales before VAT, the
 * parts at cost, other costs entered against the job, and the profit
 * (lib/finance/job-costing.ts).
 */
export function JobCostPanel({ cost }: { cost: JobCost }) {
  const loss = cost.profitFils < 0;
  const row = 'flex items-baseline justify-between gap-4 text-sm';
  return (
    <Panel className="flex flex-col gap-3">
      <dl className="flex flex-col gap-2">
        <div className={row}>
          <dt className="text-muted-foreground">Sales, before VAT</dt>
          <dd className="tabular-nums">{signed(cost.salesFils)}</dd>
        </div>
        <div className={row}>
          <dt className="text-muted-foreground">Parts, at cost</dt>
          <dd className="tabular-nums">−{formatMoney(filsToString(cost.partsFils))}</dd>
        </div>
        <div className={row}>
          <dt className="text-muted-foreground">Other job costs</dt>
          <dd className="tabular-nums">−{formatMoney(filsToString(cost.otherFils))}</dd>
        </div>
        {cost.expenses.length ? (
          <ul className="flex flex-col gap-1 border-l-2 border-border pl-3">
            {cost.expenses.map((expense) => (
              <li key={expense.id} className="flex items-baseline justify-between gap-3 text-xs">
                <Link
                  href={`/finance/expenses/${expense.id}`}
                  className="min-w-0 truncate text-muted-foreground hover:text-foreground hover:underline"
                >
                  {expense.description}
                  {expense.vendorName ? ` · ${expense.vendorName}` : ''} ·{' '}
                  {formatCalendarDate(expense.expenseDate)}
                </Link>
                <span className="shrink-0 tabular-nums">
                  {formatMoney(filsToString(expense.costFils))}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className={cn(row, 'border-t border-border pt-2 text-base font-semibold')}>
          <dt>{loss ? 'Loss' : 'Profit'}</dt>
          <dd className={cn('tabular-nums', loss && 'text-destructive')}>
            {signed(cost.profitFils)}
            {cost.margin !== null ? (
              <span className="ml-2 text-xs font-medium text-muted-foreground">
                {cost.margin}%
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {cost.uncostedLines > 0 ? (
        <p className="text-xs text-warning">
          {cost.uncostedLines} parts line{cost.uncostedLines === 1 ? ' has' : 's have'} no cost
          (typed before parts were tied to stock), so the profit shown is higher than it really
          was.{' '}
          <Link
            href={`/reports/job-profit/old-parts?invoice=${cost.invoiceId}`}
            className="font-medium underline underline-offset-2"
          >
            Give {cost.uncostedLines === 1 ? 'it its' : 'them their'} cost
          </Link>
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Outside work, towing or materials for this car: record them as an expense and choose this
        job under &ldquo;For a job&rdquo;. Wages are not spread over jobs.
      </p>
    </Panel>
  );
}
