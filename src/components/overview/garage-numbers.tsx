import Link from 'next/link';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { formatMoney } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import type { GarageSummary } from '@/lib/overview/garage';
import { Change } from '@/components/overview/kpi';
import { cn } from '@/lib/utils';

/*
 * "How the garage is doing" on the dashboard, read the way an owner reads
 * it: the profit worked out step by step — revenue, less the parts, less
 * the expenses — with a bar showing where each dirham of revenue went; and
 * beside it the money: what is in hand, what came in, what is owed both
 * ways. A comparison shows only when there is an earlier period to compare
 * with. Sized by its own width (@container): side by side on a desk,
 * stacked on a phone.
 */

type Profit = NonNullable<GarageSummary['profit']>;
type Money = GarageSummary['money'];

/** Signed fils from a money string ("-12.50" → -1250). */
function fils(value: string | null | undefined) {
  if (!value) return 0;
  const negative = value.startsWith('-');
  return toFils(value.replace('-', '')) * (negative ? -1 : 1);
}

const percent = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

export function GarageNumbers({ summary }: { summary: GarageSummary }) {
  const { profit, money, compareLabel } = summary;
  return (
    <div className="@container">
      <div className={cn('grid gap-4', profit && '@4xl:grid-cols-5')}>
        {profit ? <ProfitPanel profit={profit} compareLabel={compareLabel} /> : null}
        <MoneyPanel money={money} wide={!profit} />
      </div>
    </div>
  );
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-5 rounded-2xl border border-border bg-card p-5 shadow-card sm:p-6',
        className,
      )}
    >
      {children}
    </section>
  );
}

function CardHead({ title, href, link }: { title: string; href: string; link: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      <Link
        href={href}
        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover"
      >
        {link}
        <ArrowRight className="size-4" />
      </Link>
    </div>
  );
}

/** Only when there is something to compare with — never a line of "nothing to compare". */
function Moved({
  change,
  label,
  lowerIsBetter,
}: {
  change: number | null;
  label: string;
  lowerIsBetter?: boolean;
}) {
  return change === null ? null : (
    <Change change={change} label={label} lowerIsBetter={lowerIsBetter} />
  );
}

function ProfitPanel({ profit, compareLabel }: { profit: Profit; compareLabel: string }) {
  const revenue = fils(profit.revenue);
  const gross = fils(profit.grossProfit);
  const net = profit.netFils;
  const parts = revenue - gross;
  const expenses = gross - net;
  const loss = net < 0;
  // Where the revenue went. In a loss the costs are more than the revenue,
  // so the bar is drawn against the costs and the shortfall is said in words.
  const whole = loss ? Math.max(parts, 0) + Math.max(expenses, 0) : revenue;
  const segments = [
    { key: 'parts', label: 'Cost of parts', fils: parts, colour: 'bg-chart-3' },
    { key: 'expenses', label: 'Expenses', fils: expenses, colour: 'bg-chart-4' },
    ...(loss ? [] : [{ key: 'profit', label: 'Kept as profit', fils: net, colour: 'bg-success' }]),
  ].filter((segment) => segment.fils > 0);

  const steps: {
    key: string;
    sign: '' | '−' | '=';
    label: string;
    value: string;
    note?: string | null;
    strong?: boolean;
    change?: number | null;
    lowerIsBetter?: boolean;
    href?: string;
  }[] = [
    {
      key: 'revenue',
      sign: '',
      label: 'Revenue',
      note: 'sales booked, excl. VAT',
      value: profit.revenue,
      change: profit.revenueGrowth,
      href: '/finance/accounting?view=profit',
    },
    {
      key: 'parts',
      sign: '−',
      label: 'Cost of parts sold',
      value: filsToString(parts),
      href: '/finance/accounting?view=profit',
    },
    {
      key: 'gross',
      sign: '=',
      label: 'Gross profit',
      note: profit.grossMargin !== null ? `${profit.grossMargin}% of revenue` : null,
      value: profit.grossProfit,
      change: profit.grossGrowth,
      strong: true,
    },
    {
      key: 'expenses',
      sign: '−',
      label: 'Expenses',
      note: 'salaries, rent, utilities and the rest',
      value: filsToString(expenses),
      href: '/finance/expenses',
    },
  ];

  return (
    <Card className="@4xl:col-span-3">
      <CardHead title="Profit" href="/finance/accounting?view=profit" link="Profit & loss" />

      <div className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">Net profit</p>
        <p
          className={cn(
            'text-3xl leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-4xl',
            loss ? 'text-danger' : net > 0 ? 'text-success' : 'text-foreground',
          )}
        >
          {formatMoney(profit.netProfit)}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {profit.netMargin !== null ? (
            <span className="text-muted-foreground">
              {loss
                ? `a loss of ${Math.abs(profit.netMargin)}% of revenue`
                : `${profit.netMargin}% of revenue kept`}
            </span>
          ) : null}
          <Moved change={profit.netGrowth} label={compareLabel} />
        </div>
      </div>

      {segments.length ? (
        <div className="flex flex-col gap-3">
          <div
            className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={segments
              .map((segment) => `${segment.label} ${percent(segment.fils, whole) ?? 0}%`)
              .join(', ')}
          >
            {segments.map((segment) => (
              <span
                key={segment.key}
                className={cn('h-full', segment.colour)}
                style={{ width: `${percent(segment.fils, whole) ?? 0}%` }}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
            {segments.map((segment) => (
              <li key={segment.key} className="inline-flex items-center gap-1.5">
                <span aria-hidden className={cn('size-2.5 rounded-sm', segment.colour)} />
                {segment.label}
                <span className="font-medium text-foreground tabular-nums">
                  {percent(segment.fils, whole) ?? 0}%
                </span>
              </li>
            ))}
            {loss ? (
              <li className="text-danger">
                Costs are {formatMoney(filsToString(-net))} more than the revenue
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}

      <dl className="flex flex-col divide-y divide-border border-t border-border">
        {steps.map((step) => {
          const body = (
            <>
              <dt className="flex min-w-0 items-baseline gap-2">
                <span
                  aria-hidden
                  className="w-3 shrink-0 text-center font-medium text-muted-foreground"
                >
                  {step.sign}
                </span>
                <span className="flex min-w-0 flex-col">
                  <span className={cn('text-sm', step.strong && 'font-semibold')}>
                    {step.label}
                  </span>
                  {step.note ? (
                    <span className="truncate text-xs text-muted-foreground">{step.note}</span>
                  ) : null}
                </span>
              </dt>
              <dd className="flex shrink-0 flex-col items-end gap-1">
                <span
                  className={cn(
                    'text-sm tabular-nums',
                    step.strong ? 'font-semibold' : 'font-medium',
                  )}
                >
                  {formatMoney(step.value)}
                </span>
                <Moved change={step.change ?? null} label="" lowerIsBetter={step.lowerIsBetter} />
              </dd>
            </>
          );
          const row = 'flex items-start justify-between gap-4 py-3';
          return step.href ? (
            <Link
              key={step.key}
              href={step.href}
              className={cn(row, '-mx-2 rounded-md px-2 transition-colors hover:bg-muted/50')}
            >
              {body}
            </Link>
          ) : (
            <div key={step.key} className={row}>
              {body}
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

function MoneyPanel({
  money,
  wide,
}: {
  money: Money;
  /** Alone on the row (no profit to show): its figures sit side by side. */
  wide: boolean;
}) {
  const receivables = money.receivables;
  const overdue = receivables ? fils(receivables.overdue) : 0;
  const rows = [
    money.invoiced !== null && wide
      ? {
          key: 'invoiced',
          label: 'Invoiced',
          note: 'in the period, excl. VAT',
          value: money.invoiced,
          change: money.invoicedGrowth,
          href: '/finance/invoices',
        }
      : null,
    money.collected !== null
      ? {
          key: 'collected',
          label: 'Collected',
          note: 'payments received in the period, incl. VAT',
          value: money.collected,
          change: money.collectedGrowth,
          href: '/finance/payments',
        }
      : null,
    receivables
      ? {
          key: 'owe',
          label: 'Customers owe',
          note:
            overdue > 0
              ? `${formatMoney(receivables.overdue)} overdue on ${receivables.overdueCount} invoice${receivables.overdueCount === 1 ? '' : 's'}`
              : receivables.count
                ? `${receivables.count} unpaid invoice${receivables.count === 1 ? '' : 's'}, none overdue`
                : 'nothing outstanding',
          warn: overdue > 0,
          value: receivables.balance,
          href: '/finance/outstanding',
        }
      : null,
    money.payables
      ? {
          key: 'owed',
          label: 'We owe suppliers',
          note: money.payables.count
            ? `${money.payables.parties} supplier${money.payables.parties === 1 ? '' : 's'} · ${money.payables.count} bill${money.payables.count === 1 ? '' : 's'}`
            : 'nothing owed',
          value: money.payables.balance,
          href: '/finance/payables',
        }
      : null,
  ].filter((row) => row !== null);

  if (money.inHand === null && rows.length === 0) return null;

  return (
    <Card className="@4xl:col-span-2">
      <CardHead title="Money" href="/finance/money" link="Cash & bank" />
      {money.inHand !== null ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Cash and bank now</p>
          <p className="text-3xl leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-4xl">
            {formatMoney(money.inHand)}
          </p>
          <p className="text-sm text-muted-foreground">Cash on hand, petty cash and bank</p>
        </div>
      ) : null}
      {rows.length ? (
        <ul
          className={cn(
            'flex flex-col divide-y divide-border',
            money.inHand !== null && 'border-t border-border',
          )}
        >
          {rows.map((row) => (
            <li key={row.key}>
              <Link
                href={row.href}
                className="group -mx-2 flex items-center justify-between gap-3 rounded-md px-2 py-3 transition-colors hover:bg-muted/50"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm">{row.label}</span>
                  <span
                    className={cn(
                      'truncate text-xs',
                      'warn' in row && row.warn ? 'text-danger' : 'text-muted-foreground',
                    )}
                  >
                    {row.note}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="flex flex-col items-end gap-1">
                    <span className="text-sm font-semibold tabular-nums">
                      {formatMoney(row.value)}
                    </span>
                    {'change' in row ? <Moved change={row.change ?? null} label="" /> : null}
                  </span>
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
