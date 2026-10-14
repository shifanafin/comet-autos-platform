import Link from 'next/link';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { visibleStages, type WorkflowStatus } from '@/lib/workshop/stages';
import { cn } from '@/lib/utils';

/*
 * The dashboard's live parts: where every car is now, stage by stage, and
 * the few things someone should act on. Neither depends on the period
 * picked — they are today. Tiles are sized by their own row's width
 * (@container), so they sit in one line on a desk and wrap on a phone.
 */

/** Stages where a car waits on someone at the workshop: shown in amber while any are there. */
const WAITING_ON_US: WorkflowStatus[] = ['READY', 'PAID'];
const WAITING_ON_CUSTOMER: WorkflowStatus[] = ['WAITING_APPROVAL', 'INVOICED'];

export function WorkshopNow({
  stages,
  detailed,
}: {
  stages: { key: string; label: string; status: WorkflowStatus; count: number }[];
  /** The workshop uses the detailed job card (inspection, diagnosis, quality check). */
  detailed: boolean;
}) {
  // Delivered cars have gone home: not part of "now".
  const shown = visibleStages(
    stages.filter((stage) => stage.status !== 'DELIVERED'),
    detailed,
  );
  return (
    <div className="@container">
      <ol className="grid grid-cols-3 gap-2 @xl:grid-cols-4 @3xl:grid-cols-6 @6xl:auto-cols-fr @6xl:grid-flow-col @6xl:grid-cols-none">
        {shown.map((stage) => {
          const busy = stage.count > 0;
          const tone = !busy
            ? 'idle'
            : WAITING_ON_US.includes(stage.status)
              ? 'us'
              : WAITING_ON_CUSTOMER.includes(stage.status)
                ? 'customer'
                : 'moving';
          return (
            <li key={stage.key} className="min-w-0">
              <Link
                href={`/job-cards?status=${stage.status}`}
                className={cn(
                  'flex h-full min-h-20 flex-col justify-between gap-1 rounded-xl border bg-card p-3 transition-colors hover:bg-muted/50',
                  tone === 'idle' && 'border-border',
                  tone === 'moving' && 'border-primary/30',
                  tone === 'us' && 'border-warning/50 bg-warning/5',
                  tone === 'customer' && 'border-info/40 bg-info/5',
                )}
              >
                <span
                  className={cn(
                    'text-2xl leading-none font-semibold tabular-nums',
                    tone === 'idle' && 'text-muted-foreground/50',
                    tone === 'us' && 'text-warning',
                    tone === 'customer' && 'text-info',
                  )}
                >
                  {stage.count}
                </span>
                <span
                  className={cn(
                    'text-xs leading-snug',
                    busy ? 'font-medium text-foreground' : 'text-muted-foreground',
                  )}
                >
                  {stage.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <Legend className="border-info/40 bg-info/5">Waiting on the customer</Legend>
        <Legend className="border-warning/50 bg-warning/5">Waiting on us</Legend>
      </p>
    </div>
  );
}

function Legend({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden className={cn('size-3 rounded border', className)} />
      {children}
    </span>
  );
}

export interface AttentionItem {
  href: string;
  icon: LucideIcon;
  /** The figure: a count or an amount. */
  value: string;
  label: string;
  tone: 'danger' | 'warning' | 'info';
}

/** What someone should act on now, most urgent first; each opens the list behind it. */
export function AttentionList({ items }: { items: AttentionItem[] }) {
  return (
    <div className="@container">
      <ul className="grid gap-2 @xl:grid-cols-2 @4xl:grid-cols-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.href} className="min-w-0">
              <Link
                href={item.href}
                className={cn(
                  'group flex h-full min-h-16 items-center gap-3 rounded-xl border bg-card px-4 py-3 transition-colors hover:bg-muted/50',
                  item.tone === 'danger' && 'border-danger/40',
                  item.tone === 'warning' && 'border-warning/40',
                  item.tone === 'info' && 'border-border',
                )}
              >
                <span
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg',
                    item.tone === 'danger' && 'bg-danger/10 text-danger',
                    item.tone === 'warning' && 'bg-warning/10 text-warning',
                    item.tone === 'info' && 'bg-info/10 text-info',
                  )}
                >
                  <Icon className="size-4.5" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-base font-semibold tabular-nums">
                    {item.value}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{item.label}</span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
