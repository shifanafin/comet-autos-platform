import Link from 'next/link';
import type { ItemState, VatPeriodRow } from '@/lib/compliance/calendar';
import { formatCalendarDate } from '@/lib/format';
import { Panel } from '@/components/layout/primitives';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import { RecordFiledElsewhereButton } from '@/components/compliance/record-filed-elsewhere';
import { cn } from '@/lib/utils';

const STATE: Record<ItemState, { label: string; tone: PillTone }> = {
  done: { label: 'Done', tone: 'success' },
  todo: { label: 'To do', tone: 'warning' },
  late: { label: 'Late', tone: 'danger' },
  upcoming: { label: 'Coming up', tone: 'info' },
  none: { label: 'Nothing to do', tone: 'neutral' },
  missing: { label: 'Needs setting up', tone: 'warning' },
};

const ROW =
  'flex flex-col gap-2 px-4 py-3 @md:flex-row @md:items-center @md:justify-between sm:px-6';

/**
 * Every VAT period from the certificate, newest first: where its return
 * stands, when it is due, and a click to open its figures. A period from
 * before these books has no figures here, so it offers to record the return
 * as filed in EmaraTax instead.
 */
export function VatPeriodList({
  periods,
  selected,
  canRecord,
}: {
  periods: VatPeriodRow[];
  /** The period on screen, marked in the list. */
  selected?: { from: string; to: string };
  canRecord: boolean;
}) {
  const rows = [...periods].reverse();
  return (
    <Panel padding="none" className="@container overflow-hidden">
      <ul className="divide-y divide-border">
        {rows.map((period) => {
          const current = selected?.from === period.from && selected?.to === period.to;
          const label = (
            <span className="flex flex-col gap-0.5">
              <span className="font-medium tabular-nums">
                {formatCalendarDate(period.from)} – {formatCalendarDate(period.to)}
                {current ? (
                  <span className="ml-2 text-xs font-normal text-primary">On screen</span>
                ) : null}
              </span>
              <span className="text-sm text-muted-foreground">{period.status}</span>
            </span>
          );
          const due = (
            <>
              <span className="text-sm tabular-nums text-muted-foreground">
                Due {formatCalendarDate(period.due)}
              </span>
              <StatusPill tone={STATE[period.state].tone}>{STATE[period.state].label}</StatusPill>
            </>
          );
          return period.beforeBooks ? (
            <li key={period.to} className={ROW}>
              {label}
              <span className="flex flex-wrap items-center gap-3">
                {due}
                {period.netVat === null && canRecord ? (
                  <RecordFiledElsewhereButton from={period.from} to={period.to} />
                ) : null}
              </span>
            </li>
          ) : (
            <li key={period.to}>
              <Link
                href={period.href}
                aria-current={current ? 'true' : undefined}
                className={cn(ROW, 'hover:bg-muted/40', current && 'bg-primary/5')}
              >
                {label}
                <span className="flex items-center gap-3">{due}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
