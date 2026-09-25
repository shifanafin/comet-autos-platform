import Link from 'next/link';
import { FilePlus2, FileText } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { listQuotations, type QuotationListItem } from '@/lib/workshop/quotations';
import { formatCalendarDate, formatDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EstimateStatusPill } from '@/components/workshop/status-pills';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { SearchField } from '@/components/shared/search-field';
import { cn } from '@/lib/utils';

/*
 * Every quotation in one place — raised on their own or from a work order.
 * Cards on a phone, a table once there is room to compare columns.
 */

const FILTERS = [
  { key: '', label: 'All' },
  { key: 'draft', label: 'Drafts' },
  { key: 'awaiting', label: 'Awaiting customer' },
  { key: 'approved', label: 'Approved' },
] as const;

export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const { quotations, status } = await listQuotations(user, params);
  const canCreate = hasPermission(user, 'job_card.edit', {
    branchId: user.primaryBranchId ?? undefined,
  });

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Documents"
        title="Quotations"
        description="What you have quoted, what the customer has not answered yet, and what they approved."
        actions={
          <>
            <ListDataActions
              entity="quotations"
              label="quotations"
              search={new URLSearchParams(
                Object.entries(params).filter(([, value]) => Boolean(value)) as [string, string][],
              ).toString()}
            />
            {canCreate ? (
              <LinkButton href="/quotations/new" size="lg" className="w-full sm:w-auto">
                <FilePlus2 />
                New quotation
              </LinkButton>
            ) : null}
          </>
        }
      />

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <SearchField
          initialQuery={params.q ?? ''}
          placeholder="Quotation number, customer, registration"
        />
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
          {FILTERS.map((filter) => {
            const search = new URLSearchParams();
            if (params.q) search.set('q', params.q);
            if (filter.key) search.set('status', filter.key);
            return (
              <Link
                key={filter.label}
                href={`/quotations${search.size ? `?${search}` : ''}`}
                aria-current={status === filter.key ? 'page' : undefined}
                className={cn(
                  'inline-flex h-10 shrink-0 items-center rounded-full border px-4 text-sm font-medium transition-colors',
                  status === filter.key
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-card hover:bg-muted',
                )}
              >
                {filter.label}
              </Link>
            );
          })}
        </div>
      </div>

      {quotations.length === 0 ? (
        <EmptyState
          icon={FileText}
          title={params.q ? 'No quotation matches that search' : 'No quotations yet'}
          description={
            params.q
              ? 'Try the customer’s name, mobile number or the registration.'
              : 'Quote a customer for the work they asked about — a work order is not needed first.'
          }
          action={
            canCreate ? (
              <LinkButton href="/quotations/new">
                <FilePlus2 />
                New quotation
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Panel padding="none" className="overflow-hidden">
          <RecordList>
            {quotations.map((quotation) => (
              <RecordCard
                key={quotation.id}
                title={
                  <Link href={`/quotations/${quotation.id}`} className="after:absolute after:inset-0">
                    {quotation.estimateNumber}
                  </Link>
                }
                subtitle={quotation.customer.name}
                amount={formatMoney(quotation.totalAmount)}
                status={
                  <EstimateStatusPill status={quotation.status} expired={quotation.expired} />
                }
                className="relative"
                details={[
                  {
                    label: 'Vehicle',
                    value: quotation.vehicle
                      ? `${quotation.vehicle.plateNumber} · ${quotation.vehicle.make} ${quotation.vehicle.model}`
                      : 'No vehicle',
                  },
                  {
                    label: 'Work order',
                    value: quotation.jobCard?.jobNumber ?? 'Not linked',
                  },
                  { label: 'Date', value: dateFor(quotation) },
                ]}
              />
            ))}
          </RecordList>

          <TableWrap>
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Quotation</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Work order</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {quotations.map((quotation) => (
                  <TableRow key={quotation.id} className="relative">
                    <TableCell>
                      <Link
                        href={`/quotations/${quotation.id}`}
                        className="font-medium after:absolute after:inset-0"
                      >
                        {quotation.estimateNumber}
                      </Link>
                      {quotation.version > 1 ? (
                        <span className="block text-xs text-muted-foreground">
                          version {quotation.version}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {quotation.customer.name}
                      <span className="block text-xs text-muted-foreground">
                        {quotation.customer.phone}
                      </span>
                    </TableCell>
                    <TableCell>
                      {quotation.vehicle ? (
                        <span className="flex items-center gap-2">
                          <VehiclePlate
                            plateNumber={quotation.vehicle.plateNumber}
                            className="px-2 py-0.5 text-xs"
                          />
                          <span className="text-xs text-muted-foreground">
                            {quotation.vehicle.make} {quotation.vehicle.model}
                          </span>
                        </span>
                      ) : (
                        <span className="text-sm text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {quotation.jobCard?.jobNumber ?? '—'}
                    </TableCell>
                    <TableCell>
                      <EstimateStatusPill status={quotation.status} expired={quotation.expired} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{dateFor(quotation)}</TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(quotation.totalAmount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableWrap>
        </Panel>
      )}
    </Stack>
  );
}

/** Sent quotations are judged by their validity date; drafts by when they were started. */
function dateFor(quotation: QuotationListItem): string {
  if (quotation.status === 'SENT' && quotation.validUntil) {
    return `${quotation.expired ? 'Expired' : 'Valid until'} ${formatCalendarDate(quotation.validUntil)}`;
  }
  return formatDate(quotation.sentAt ?? quotation.createdAt);
}
