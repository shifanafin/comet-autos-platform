import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CalendarDays, Car, ClipboardList, LogIn, Pencil, Plus, Receipt } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getCustomerDetail } from '@/lib/customers/service';
import { OPEN_JOB_STATUSES } from '@/lib/workshop/check-in';
import { formatCalendarDate, formatDate, formatDateTime, formatKm, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { JobStatusBadge } from '@/components/shared/job-status-badge';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DeleteCustomerButton,
  RestoreCustomerButton,
} from '@/components/workshop/record-archive-controls';

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let detail;
  try {
    detail = await getCustomerDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { customer, jobCards } = detail;
  const openJobs = jobCards.filter((job) => OPEN_JOB_STATUSES.includes(job.status));
  const canEdit = hasPermission(user, 'customer.edit');
  const canAddVehicle = hasPermission(user, 'vehicle.create');

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/customers" className="tracking-normal normal-case hover:text-foreground">
            ← Customers
          </Link>
        }
        title={customer.name}
        description={
          <>
            {customer.phone}
            {customer.email ? ` · ${customer.email}` : ''}
            {customer.taxNumber ? ` · TRN ${customer.taxNumber}` : ''}
            {` · customer since ${formatDate(customer.createdAt)}`}
          </>
        }
        actions={
          !customer.isActive ? (
            canEdit ? (
              <RestoreCustomerButton customerId={customer.id} name={customer.name} />
            ) : undefined
          ) : (
            <>
              {canEdit ? (
                <LinkButton href={`/customers/${customer.id}/edit`} variant="outline" size="lg">
                  <Pencil />
                  Edit details
                </LinkButton>
              ) : null}
              {canEdit ? (
                <DeleteCustomerButton customerId={customer.id} name={customer.name} />
              ) : null}
              {canAddVehicle ? (
                <LinkButton href={`/customers/${customer.id}/vehicles/new`} size="lg">
                  <Plus />
                  Add vehicle
                </LinkButton>
              ) : null}
            </>
          )
        }
      />

      {!customer.isActive ? (
        <Panel className="border-destructive/30 bg-destructive/5 text-sm">
          This customer is deleted. They don&apos;t appear in lists, search or pickers; their
          history below is kept.
        </Panel>
      ) : null}

      {openJobs.length > 0 ? (
        <Panel className="border-primary/25 bg-accent/40">
          <p className="text-sm font-medium">
            {openJobs.length === 1
              ? 'A vehicle is in the workshop right now:'
              : `${openJobs.length} vehicles are in the workshop right now:`}
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {openJobs.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/job-cards/${job.id}`}
                  className="flex flex-wrap items-center gap-3 text-sm hover:underline"
                >
                  <VehiclePlate
                    plateNumber={job.vehicle.plateNumber}
                    className="px-2 py-0.5 text-xs"
                  />
                  <span className="font-medium">{job.jobNumber}</span>
                  <JobStatusBadge status={job.status} />
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Section title="Vehicles" description={`${customer.vehicles.length} on file`}>
        {customer.vehicles.length === 0 ? (
          <EmptyState
            icon={Car}
            title="No vehicles yet"
            description="Add the customer's vehicle to check it in or book an appointment."
            action={
              canAddVehicle ? (
                <LinkButton href={`/customers/${customer.id}/vehicles/new`}>
                  <Plus />
                  Add vehicle
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <Grid gap="base" className="md:grid-cols-2 xl:grid-cols-3">
            {customer.vehicles.map((vehicle) => {
              const open = openJobs.find((job) => job.vehicle.id === vehicle.id);
              return (
                <Panel key={vehicle.id} className="flex flex-col gap-4">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={`/vehicles/${vehicle.id}`}
                      className="flex min-w-0 flex-col gap-2 hover:underline"
                    >
                      <VehiclePlate plateNumber={vehicle.plateNumber} className="self-start" />
                      <span className="font-medium">
                        {vehicle.make} {vehicle.model} {vehicle.year ?? ''}
                      </span>
                    </Link>
                    {open ? <StatusPill tone="warning">In workshop</StatusPill> : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {vehicle.lastMileage !== null
                      ? `${formatKm(vehicle.lastMileage)} last recorded`
                      : 'No mileage recorded'}
                    {vehicle.vin ? ` · VIN ${vehicle.vin}` : ''}
                  </p>
                  <div className="mt-auto flex flex-wrap gap-2 border-t border-border pt-4">
                    {open ? (
                      <LinkButton href={`/job-cards/${open.id}`} size="sm">
                        Open {open.jobNumber}
                      </LinkButton>
                    ) : (
                      <LinkButton href={`/check-in?vehicle=${vehicle.id}`} size="sm">
                        <LogIn />
                        Check in
                      </LinkButton>
                    )}
                    <LinkButton
                      href={`/appointments/new?vehicle=${vehicle.id}`}
                      size="sm"
                      variant="outline"
                    >
                      <CalendarDays />
                      Book
                    </LinkButton>
                    <LinkButton href={`/vehicles/${vehicle.id}`} size="sm" variant="ghost">
                      History
                    </LinkButton>
                  </div>
                </Panel>
              );
            })}
          </Grid>
        )}
      </Section>

      {customer.appointments.length > 0 ? (
        <Section title="Upcoming appointments">
          <Panel padding="none">
            <ul className="divide-y divide-border">
              {customer.appointments.map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm sm:px-6"
                >
                  <span className="flex items-center gap-3">
                    <CalendarDays className="size-4 text-muted-foreground" />
                    <span className="font-medium">{formatDateTime(appointment.scheduledAt)}</span>
                    {appointment.vehicle ? (
                      <VehiclePlate
                        plateNumber={appointment.vehicle.plateNumber}
                        className="px-2 py-0.5 text-xs"
                      />
                    ) : null}
                  </span>
                  <span className="text-muted-foreground">{appointment.notes}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </Section>
      ) : null}

      <Section title="Job history" description="Every visit, newest first.">
        {jobCards.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No visits yet"
            description="Job cards appear here once one is opened for this customer."
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Job</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Complaint</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Checked in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobCards.map((job) => (
                  <TableRow key={job.id} className="relative">
                    <TableCell>
                      <Link
                        href={`/job-cards/${job.id}`}
                        className="font-medium after:absolute after:inset-0 hover:underline"
                      >
                        {job.jobNumber}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <VehiclePlate
                        plateNumber={job.vehicle.plateNumber}
                        className="px-2 py-0.5 text-xs"
                      />
                    </TableCell>
                    <TableCell className="max-w-xs truncate text-muted-foreground">
                      {job.customerComplaint ?? '—'}
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDate(job.openedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        )}
      </Section>

      <Section title="Invoices">
        {customer.invoices.length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No invoices yet"
            description="Invoices for this customer will be listed here once invoicing is built."
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Invoice</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customer.invoices.map((invoice) => (
                  <TableRow key={invoice.id}>
                    <TableCell className="font-medium">{invoice.invoiceNumber}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatCalendarDate(invoice.issueDate)}
                    </TableCell>
                    <TableCell>
                      <StatusPill
                        tone={
                          invoice.status === 'PAID'
                            ? 'success'
                            : invoice.status === 'VOID' || invoice.status === 'CANCELLED'
                              ? 'neutral'
                              : 'warning'
                        }
                      >
                        {invoice.status.replace('_', ' ').toLowerCase()}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(invoice.totalAmount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        )}
      </Section>
    </Stack>
  );
}
