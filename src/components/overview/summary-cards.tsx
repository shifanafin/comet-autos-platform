import Link from 'next/link';
import { Car, HandCoins, Landmark, TrendingUp, Wallet, type LucideIcon } from 'lucide-react';
import { formatMoney } from '@/lib/format';
import { toFils } from '@/lib/money';
import type { GarageSummary } from '@/lib/overview/garage';
import { Change } from '@/components/overview/kpi';
import { cn } from '@/lib/utils';

/*
 * The garage at a glance, first thing on the dashboard: each figure a card
 * that opens the list behind it. Only figures the person may see are given —
 * the summary leaves the others out — and the row is sized by its own width,
 * so a long amount wraps rather than breaking the card.
 */

type Tone = 'primary' | 'info' | 'success' | 'warning' | 'danger';

const TONE: Record<Tone, { badge: string; line: string }> = {
  primary: { badge: 'bg-primary/10 text-primary', line: 'text-primary' },
  info: { badge: 'bg-info/10 text-info', line: 'text-info' },
  success: { badge: 'bg-success/10 text-success', line: 'text-success' },
  warning: { badge: 'bg-warning/10 text-warning', line: 'text-warning' },
  danger: { badge: 'bg-danger/10 text-danger', line: 'text-danger' },
};

interface SummaryCard {
  key: string;
  label: string;
  value: string;
  icon: LucideIcon;
  tone: Tone;
  hint?: string;
  change?: number | null;
  href?: string;
  /** Twelve months of the figure, oldest first. */
  trend?: number[];
}

/** Fils from a decimal string that may be below zero. */
const signedFils = (value: string) =>
  value.startsWith('-') ? -toFils(value.slice(1)) : toFils(value);

export function SummaryCards({
  summary,
  menu,
}: {
  summary: GarageSummary;
  /** Whether the workshop shows this menu: a hidden one isn't linked to. */
  menu: (href: string) => boolean;
}) {
  const { workshopNow, profit, money, trend, compareLabel, period } = summary;
  const link = (href: string) => (menu(href) ? href : undefined);
  const receivables = money.receivables;
  const overdue = receivables ? toFils(receivables.overdue) > 0 : false;
  const net = profit ? signedFils(profit.netProfit) : 0;
  const sales = profit?.revenue ?? money.invoiced;

  const cards: SummaryCard[] = [
    ...(workshopNow
      ? [
          {
            key: 'cars',
            label: 'In the workshop',
            value: `${workshopNow.inNow} car${workshopNow.inNow === 1 ? '' : 's'}`,
            icon: Car,
            tone: 'primary' as const,
            hint: `${workshopNow.appointmentsToday} appointment${workshopNow.appointmentsToday === 1 ? '' : 's'} today`,
            href: link('/live'),
          },
        ]
      : []),
    ...(sales !== null
      ? [
          {
            key: 'sales',
            label: 'Sales',
            value: formatMoney(sales),
            icon: TrendingUp,
            tone: 'info' as const,
            hint: `${period.label}, excl. VAT`,
            change: profit?.revenueGrowth ?? money.invoicedGrowth,
            href: profit ? '/finance/accounting?view=profit' : link('/sales'),
            trend: trend?.map((month) => month.revenueFils),
          },
        ]
      : []),
    ...(profit
      ? [
          {
            key: 'profit',
            label: net < 0 ? 'Net loss' : 'Net profit',
            value: formatMoney(profit.netProfit),
            icon: Wallet,
            tone: net < 0 ? ('danger' as const) : ('success' as const),
            hint: profit.netMargin !== null ? `${profit.netMargin}% of sales` : period.label,
            change: profit.netGrowth,
            href: '/finance/accounting?view=profit',
            trend: trend?.map((month) => month.netFils),
          },
        ]
      : []),
    ...(receivables
      ? [
          {
            key: 'owed',
            label: 'Customers owe',
            value: formatMoney(receivables.balance),
            icon: HandCoins,
            tone: overdue ? ('danger' as const) : ('warning' as const),
            hint: overdue
              ? `${formatMoney(receivables.overdue)} overdue`
              : receivables.count
                ? 'None overdue'
                : 'Nothing unpaid',
            href: link('/finance/outstanding'),
          },
        ]
      : []),
    ...(money.inHand !== null
      ? [
          {
            key: 'money',
            label: 'Cash & bank',
            value: formatMoney(money.inHand),
            icon: Landmark,
            tone: 'primary' as const,
            hint: 'In hand right now',
            href: link('/finance/money'),
          },
        ]
      : []),
  ];
  if (cards.length === 0) return null;

  return (
    <div className="@container">
      <ul className="grid gap-3 @md:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-5">
        {cards.map((card) => (
          <li key={card.key} className="min-w-0">
            <Card card={card} compareLabel={compareLabel} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function Card({ card, compareLabel }: { card: SummaryCard; compareLabel: string }) {
  const Icon = card.icon;
  const tone = TONE[card.tone];
  const body = (
    <>
      <span className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-muted-foreground">{card.label}</span>
        <span
          className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', tone.badge)}
        >
          <Icon className="size-[18px]" />
        </span>
      </span>
      <span className="text-2xl leading-tight font-semibold tracking-tight tabular-nums [overflow-wrap:anywhere]">
        {card.value}
      </span>
      {card.trend ? <Sparkline points={card.trend} className={tone.line} /> : null}
      <span className="mt-auto flex flex-col gap-1.5">
        {card.hint ? <span className="text-xs text-muted-foreground">{card.hint}</span> : null}
        {card.change !== undefined && card.change !== null ? (
          <Change change={card.change} label={compareLabel} />
        ) : null}
      </span>
    </>
  );
  const className =
    'flex h-full flex-col gap-2.5 rounded-2xl border border-border/70 bg-card p-4 shadow-card';
  return card.href ? (
    <Link
      href={card.href}
      className={cn(
        className,
        'outline-none transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-raised focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transform-none motion-reduce:transition-none',
      )}
    >
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
}

/** The shape of the last twelve months, decoration only: the figures are in the chart below. */
function Sparkline({ points, className }: { points: number[]; className?: string }) {
  // A line needs at least two months with something in them.
  if (points.filter((point) => point !== 0).length < 2) return null;
  const min = Math.min(...points);
  const range = Math.max(...points) - min || 1;
  const WIDTH = 120;
  const HEIGHT = 32;
  const line = points
    .map((point, index) => {
      const x = (index / (points.length - 1)) * WIDTH;
      const y = HEIGHT - 2 - ((point - min) / range) * (HEIGHT - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      className={cn('h-8 w-full', className)}
    >
      <polygon
        points={`0,${HEIGHT} ${line} ${WIDTH},${HEIGHT}`}
        fill="currentColor"
        opacity={0.1}
      />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
