import Link from 'next/link';
import { ClipboardList, Plus } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getAllowedNextStatuses } from '@/lib/workshop/job-status';
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
import {
  RecordSelection,
  RemoveCell,
  RemoveHead,
  RowCheckbox,
  RowRemoveButton,
  SelectCell,
  SelectHead,
} from '@/components/shared/record-selection';
import { REMOVAL } from '@/lib/records/removal';
import { WORKSHOP_LOCALE } from '@/lib/format';

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

  const canRemove = hasPermission(
    user,
    REMOVAL['job-cards'].permission,
    user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined,
  );
  // Cancel is offered only where the job card could be cancelled today —
  // not once it is invoiced or handed over. The server checks again.
  const removable = (jobCard: (typeof jobCards)[number]) =>
    getAllowedNextStatuses(jobCard.status).includes('CANCELLED');
  const removableRows = jobCards
    .filter(removable)
    .map((jobCard) => ({ id: jobCard.id, label: jobCard.jobNumber }));

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
        title="Job Cards"
        description={
          isFiltered
            ? `Showing ${total} of ${unfilteredTotal} job cards.`
            : `${unfilteredTotal} job card${unfilteredTotal === 1 ? '' : 's'} in total.`
        }
        actions={
          <>
            <ListDataActions
              entity="work-orders"
              label="job cards"
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
              New job card
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
              title="No job cards match your filters"
              description="Try a different search or clear the status filter."
            />
          ) : (
            <EmptyState
              icon={ClipboardList}
              title="No job cards yet"
              description="Open one for a customer's vehicle — just who, which car, and what needs doing."
              action={
                <Button nativeButton={false} render={<Link href="/check-in" />}>
                  <Plus />
                  New job card
                </Button>
              }
            />
          )
        ) : (
          <RecordSelection entity="job-cards" enabled={canRemove}>
            <Panel padding="none" className="overflow-hidden">
              {/* Phone: one tappable card per job — plate first, then who and where it stands. */}
              <ul className="divide-y divide-border md:hidden">
                {jobCards.map((jobCard) => (
                  <li key={jobCard.id} className="flex items-start">
                    {removable(jobCard) ? (
                      <RowCheckbox
                        id={jobCard.id}
                        label={jobCard.jobNumber}
                        className="mt-5 ml-4"
                      />
                    ) : null}
                    <Link
                      href={`/job-cards/${jobCard.id}`}
                      className="flex min-w-0 flex-1 flex-col gap-2 px-4 py-4 active:bg-muted"
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
                          {jobCard.openedAt.toLocaleString(WORKSHOP_LOCALE, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </span>
                      </span>
                    </Link>
                    {removable(jobCard) ? (
                      <RowRemoveButton
                        id={jobCard.id}
                        label={jobCard.jobNumber}
                        className="mt-auto mr-2 mb-2"
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className="hidden md:block">
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <SelectHead rows={removableRows} />
                      <TableHead>Job #</TableHead>
                      <TableHead>Vehicle</TableHead>
                      <TableHead>Customer</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Opened</TableHead>
                      <RemoveHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobCards.map((jobCard) => (
                      <TableRow key={jobCard.id} className="relative cursor-pointer">
                        <SelectCell
                          id={jobCard.id}
                          label={jobCard.jobNumber}
                          removable={removable(jobCard)}
                        />
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
                          {jobCard.openedAt.toLocaleString(WORKSHOP_LOCALE, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </TableCell>
                        <RemoveCell
                          id={jobCard.id}
                          label={jobCard.jobNumber}
                          removable={removable(jobCard)}
                        />
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
          </RecordSelection>
        )}
      </Stack>
    </Stack>
  );
}
