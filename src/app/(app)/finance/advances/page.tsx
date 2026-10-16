import Link from 'next/link';
import { HandCoins } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { ADVANCE_STATUS_LABEL, listCustomerAdvances } from '@/lib/billing/advances';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { pageFrom, slicePage } from '@/lib/pagination';
import { Grid, PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { Pagination } from '@/components/shared/pagination';
import { StatusPill } from '@/components/shared/status-pill';
import { cn } from '@/lib/utils';

export const metadata = { title: 'Customer advances' };
export const dynamic = 'force-dynamic';

const TONE = {
  OPEN: 'warning',
  PARTIALLY_APPLIED: 'warning',
  FULLY_APPLIED: 'success',
  REFUNDED: 'neutral',
  CANCELLED: 'neutral',
} as const;

/**
 * Every customer advance — taken on a job card, a quotation or here — and
 * what is still held for the customer. A new one is always for a job card
 * (lib/billing/advances.ts).
 */
export default async function CustomerAdvancesPage({
  searchParams,
}: {
  searchParams: Promise<{ show?: string; page?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const show = params.show === 'all' ? 'all' : 'held';
  let list;
  try {
    list = await listCustomerAdvances(user, { show });
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="customer advances" />;
    throw error;
  }
  const { rows, info } = slicePage(list.advances, pageFrom(params.page));

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        title="Customer advances"
        description="Money customers paid before their invoice, for a job. It is held for them until it is applied to the job's invoice — or paid back."
        actions={
          list.canReceive ? (
            <LinkButton href="/finance/advances/new" className="h-11">
              <HandCoins />
              Receive advance
            </LinkButton>
          ) : null
        }
      />

      <Grid className="sm:grid-cols-2">
        <Panel>
          <p className="text-sm text-muted-foreground">Held for customers</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{formatMoney(list.held)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {`${list.heldCount} advance${list.heldCount === 1 ? '' : 's'} with money left`}
          </p>
        </Panel>
        <Panel>
          <p className="text-sm text-muted-foreground">Advances taken</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{list.total}</p>
          <p className="mt-1 text-xs text-muted-foreground">Since the books began</p>
        </Panel>
      </Grid>

      <div className="flex gap-2" role="tablist" aria-label="Which advances">
        {(
          [
            ['held', 'Money left'],
            ['all', 'All'],
          ] as const
        ).map(([value, label]) => (
          <Link
            key={value}
            href={value === 'held' ? '/finance/advances' : '/finance/advances?show=all'}
            role="tab"
            aria-selected={show === value}
            className={cn(
              'inline-flex h-10 items-center rounded-lg border px-4 text-sm font-medium transition-colors',
              show === value ? 'border-primary bg-primary/5 text-primary' : 'border-border bg-card hover:bg-muted',
            )}
          >
            {label}
          </Link>
        ))}
      </div>

      {rows.length === 0 ? (
        <EmptyState
          icon={HandCoins}
          title={show === 'held' ? 'No money held for customers' : 'No advances yet'}
          description="An advance taken on a job card — or here — is listed with what is left of it."
        />
      ) : (
        <Panel padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-180 text-sm">
              <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <tr>
                  <th className="w-36 px-4 py-3 pl-6">Advance</th>
                  <th className="px-2 py-3">Customer</th>
                  <th className="w-32 px-2 py-3">Job card</th>
                  <th className="w-32 px-2 py-3">Status</th>
                  <th className="w-32 px-2 py-3 text-right">Received</th>
                  <th className="w-32 px-4 py-3 pr-6 text-right">Left</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id} className="relative hover:bg-muted/40">
                    <td className="px-4 py-3 pl-6">
                      <Link
                        href={`/finance/advances/${row.id}`}
                        className="row-link font-medium hover:underline"
                      >
                        {row.advanceNumber}
                      </Link>
                      <span className="block text-xs text-muted-foreground tabular-nums">
                        {formatCalendarDate(row.receivedOn)}
                      </span>
                    </td>
                    <td className="max-w-64 px-2 py-3">
                      <span className="block truncate">{row.customer.name}</span>
                      {row.plate ? (
                        <span className="block text-xs text-muted-foreground">{row.plate}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-3">
                      {row.jobCard ? (
                        <Link
                          href={`/job-cards/${row.jobCard.id}`}
                          className="relative z-10 text-primary hover:underline"
                        >
                          {row.jobCard.jobNumber}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-2 py-3">
                      <StatusPill tone={TONE[row.status]}>{ADVANCE_STATUS_LABEL[row.status]}</StatusPill>
                    </td>
                    <td
                      className={cn(
                        'px-2 py-3 text-right tabular-nums',
                        row.status === 'CANCELLED' && 'text-muted-foreground line-through',
                      )}
                    >
                      {formatMoney(row.amount)}
                    </td>
                    <td className="px-4 py-3 pr-6 text-right font-semibold tabular-nums">
                      {formatMoney(row.left)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination info={info} basePath="/finance/advances" params={params} noun="advances" />
        </Panel>
      )}
    </Stack>
  );
}
