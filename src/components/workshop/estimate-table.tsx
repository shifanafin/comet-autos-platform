import Link from 'next/link';
import { Panel } from '@/components/layout/primitives';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { EstimateStatusPill } from '@/components/workshop/status-pills';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatCalendarDate, formatDateTime, formatMoney, localDateString } from '@/lib/format';
import type { getWorkQueues } from '@/lib/workshop/workspace';

export type QueueEstimate = Awaited<ReturnType<typeof getWorkQueues>>['estimates'][number];

/**
 * Where a quotation opens. Additional-work requests live on their work
 * order's own screen; every other quotation — with a job card or without —
 * opens on the one quotation page.
 */
export function quotationHref(estimate: {
  id: string;
  kind: string;
  jobCard: { id: string } | null;
}): string {
  return estimate.kind === 'ADDITIONAL' && estimate.jobCard
    ? `/job-cards/${estimate.jobCard.id}/additional/${estimate.id}`
    : `/quotations/${estimate.id}`;
}

export function isExpired(estimate: QueueEstimate): boolean {
  return (
    estimate.status === 'SENT' &&
    estimate.validUntil !== null &&
    estimate.validUntil.toISOString().slice(0, 10) < localDateString()
  );
}

/** Estimates as a scannable table: which vehicle, which quote, how much, and where it stands. */
export function EstimateTable({ estimates, dateLabel }: { estimates: QueueEstimate[]; dateLabel: 'sent' | 'updated' | 'decided' }) {
  return (
    <Panel padding="none" className="overflow-hidden">
      <Table>
        <TableHeader className="bg-muted/40">
          <TableRow className="hover:bg-transparent">
            <TableHead>Vehicle</TableHead>
            <TableHead>Quotation</TableHead>
            <TableHead>Customer</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>{dateLabel === 'sent' ? 'Sent · valid until' : dateLabel === 'decided' ? 'Decided' : 'Last updated'}</TableHead>
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {estimates.map((estimate) => (
            <TableRow key={estimate.id} className="relative">
              <TableCell>
                <Link href={quotationHref(estimate)} className="after:absolute after:inset-0">
                  {estimate.vehicle ? (
                    <VehiclePlate plateNumber={estimate.vehicle.plateNumber} className="px-2 py-0.5 text-xs" />
                  ) : (
                    <span className="text-sm text-muted-foreground">No vehicle</span>
                  )}
                </Link>
              </TableCell>
              <TableCell>
                <span className="font-medium">{estimate.estimateNumber}</span>
                <span className="block text-xs text-muted-foreground">
                  {estimate.jobCard?.jobNumber ?? 'No job card'}
                  {estimate.version > 1 ? ` · v${estimate.version}` : ''}
                  {estimate.kind === 'ADDITIONAL' ? ' · additional work' : ''}
                </span>
              </TableCell>
              <TableCell>
                {estimate.customer.name}
                <span className="block text-xs text-muted-foreground">{estimate.customer.phone}</span>
              </TableCell>
              <TableCell>
                <EstimateStatusPill status={estimate.status} expired={isExpired(estimate)} />
              </TableCell>
              <TableCell className="text-muted-foreground">
                {dateLabel === 'sent' && estimate.sentAt
                  ? `${formatDateTime(estimate.sentAt)}${estimate.validUntil ? ` · ${formatCalendarDate(estimate.validUntil)}` : ''}`
                  : dateLabel === 'decided' && estimate.approvals[0]
                    ? formatDateTime(estimate.approvals[0].decidedAt)
                    : formatDateTime(estimate.updatedAt)}
              </TableCell>
              <TableCell className="text-right font-medium tabular-nums">{formatMoney(estimate.totalAmount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
