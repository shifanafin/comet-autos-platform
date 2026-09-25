import Link from 'next/link';
import { ClipboardList, Plus } from 'lucide-react';
import { requireUser } from '@/lib/auth/authorize';
import { usesDetailedJobCards } from '@/lib/organization/settings';
import { countJobCards, listJobCards } from '@/lib/workshop/job-card-list';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { JobStatusBadge } from '@/components/shared/job-status-badge';
import { EmptyState } from '@/components/shared/empty-state';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { JobCardFilters } from './job-card-filters';

const PAGE_SIZE = 25;

export default async function JobCardsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; status?: string; q?: string }>;
}) {
  const user = await requireUser();
  const { page: pageParam, status, q } = await searchParams;
  const page = Math.max(1, Number(pageParam) || 1);
  const query = q?.trim() ?? '';

  const filters = { q: query, status };
  const [jobCards, total, unfilteredTotal, detailed] = await Promise.all([
    listJobCards(user, filters, PAGE_SIZE, (page - 1) * PAGE_SIZE),
    countJobCards(user, filters),
    countJobCards(user, {}),
    usesDetailedJobCards(user),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Paging keeps the filters the user set, rather than dropping them on page 2.
  const pageLink = (target: number) =>
    new URLSearchParams({
      ...(status ? { status } : {}),
      ...(query ? { q: query } : {}),
      page: String(target),
    }).toString();
  const isFiltered = Boolean(status || query);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Workshop"
        title="Work Orders"
        description={
          isFiltered
            ? `Showing ${total} of ${unfilteredTotal} work orders.`
            : `${unfilteredTotal} work order${unfilteredTotal === 1 ? '' : 's'} in total.`
        }
        actions={
          <>
            <ListDataActions
              entity="work-orders"
              label="work orders"
              search={new URLSearchParams({
                ...(query ? { q: query } : {}),
                ...(status ? { status } : {}),
              }).toString()}
            />
            <Button
              size="lg"
              className="w-full sm:w-auto"
              nativeButton={false}
              render={<Link href="/check-in" />}
            >
              <Plus />
              New work order
            </Button>
          </>
        }
      />

      <Stack gap="base">
        <JobCardFilters status={status ?? ''} q={query} detailed={detailed} />

        {jobCards.length === 0 ? (
          isFiltered ? (
            <EmptyState
              icon={ClipboardList}
              title="No work orders match your filters"
              description="Try a different search or clear the status filter."
            />
          ) : (
            <EmptyState
              icon={ClipboardList}
              title="No work orders yet"
              description="Open one for a customer's vehicle — just who, which car, and what needs doing."
              action={
                <Button nativeButton={false} render={<Link href="/check-in" />}>
                  <Plus />
                  New work order
                </Button>
              }
            />
          )
        ) : (
          <>
            <Panel padding="none" className="overflow-hidden">
              {/* Phone: one tappable card per job — plate first, then who and where it stands. */}
              <ul className="divide-y divide-border md:hidden">
                {jobCards.map((jobCard) => (
                  <li key={jobCard.id}>
                    <Link
                      href={`/job-cards/${jobCard.id}`}
                      className="flex flex-col gap-2 px-4 py-4 active:bg-muted"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <VehiclePlate
                          plateNumber={jobCard.vehicle.plateNumber}
                          className="px-2 py-0.5 text-sm"
                        />
                        <JobStatusBadge status={jobCard.status} />
                      </div>
                      <span className="text-sm font-medium">
                        {jobCard.vehicle.make} {jobCard.vehicle.model}
                      </span>
                      <span className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                        <span className="truncate">
                          <span className="font-mono">{jobCard.jobNumber}</span> ·{' '}
                          {jobCard.customer.name}
                        </span>
                        <span className="tabular-nums">
                          {jobCard.openedAt.toLocaleString('en-AE', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block">
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Job #</TableHead>
                      <TableHead>Vehicle</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Opened</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobCards.map((jobCard) => (
                      <TableRow key={jobCard.id} className="relative cursor-pointer">
                        <TableCell>
                          <Link
                            href={`/job-cards/${jobCard.id}`}
                            className="font-medium after:absolute after:inset-0 hover:underline"
                          >
                            {jobCard.jobNumber}
                          </Link>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <VehiclePlate
                              plateNumber={jobCard.vehicle.plateNumber}
                              className="px-2 py-0.5 text-xs"
                            />
                            <span className="text-sm text-muted-foreground">
                              {jobCard.vehicle.make} {jobCard.vehicle.model}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>{jobCard.customer.name}</TableCell>
                        <TableCell>
                          <JobStatusBadge status={jobCard.status} />
                        </TableCell>
                        <TableCell className="text-muted-foreground tabular-nums">
                          {jobCard.openedAt.toLocaleString('en-AE', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Panel>

            {totalPages > 1 ? (
              <div className="flex items-center justify-end gap-4 text-sm text-muted-foreground">
                {page > 1 ? (
                  <Link href={`/job-cards?${pageLink(page - 1)}`} className="hover:underline">
                    Previous
                  </Link>
                ) : null}
                <span>
                  Page {page} of {totalPages}
                </span>
                {page < totalPages ? (
                  <Link href={`/job-cards?${pageLink(page + 1)}`} className="hover:underline">
                    Next
                  </Link>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </Stack>
    </Stack>
  );
}
