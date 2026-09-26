import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeftRight, CalendarDays, History, LogIn, Pencil } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getVehicleDetail } from '@/lib/vehicles/service';
import { OPEN_JOB_STATUSES } from '@/lib/workshop/check-in';
import { formatDate, formatDateTime, formatKm, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { JobStatusBadge } from '@/components/shared/job-status-badge';
import { LinkButton } from '@/components/shared/link-button';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { EstimateStatusPill } from '@/components/workshop/status-pills';
import { StatusPill } from '@/components/shared/status-pill';
import {
  DeleteVehicleButton,
  RestoreVehicleButton,
} from '@/components/workshop/record-archive-controls';

export default async function VehicleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let vehicle;
  try {
    vehicle = await getVehicleDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const openJob = vehicle.jobCards.find((job) => OPEN_JOB_STATUSES.includes(job.status));
  const canEdit = hasPermission(user, 'vehicle.edit');

  const specs: [string, React.ReactNode][] = [
    ['Registration', vehicle.plateNumber],
    ['Emirate', vehicle.plateEmirate ?? '—'],
    ['VIN', vehicle.vin ? <span className="font-mono">{vehicle.vin}</span> : '—'],
    ['Make', vehicle.make],
    ['Model', vehicle.model],
    ['Year', vehicle.year ?? '—'],
    ['Colour', vehicle.color ?? '—'],
    [
      'Last mileage',
      vehicle.lastMileage !== null ? `${formatKm(vehicle.lastMileage)}` : '—',
    ],
  ];

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/vehicles" className="tracking-normal normal-case hover:text-foreground">
            ← Vehicles
          </Link>
        }
        leading={
          <VehiclePlate plateNumber={vehicle.plateNumber} className="px-3 py-1.5 text-base" />
        }
        title={
          <span>
            {vehicle.make} {vehicle.model}
            {vehicle.year ? (
              <span className="font-normal text-muted-foreground"> {vehicle.year}</span>
            ) : null}
          </span>
        }
        description={
          <>
            Owner{' '}
            <Link
              href={`/customers/${vehicle.customer.id}`}
              className="font-medium text-foreground hover:underline"
            >
              {vehicle.customer.name}
            </Link>{' '}
            · {vehicle.customer.phone}
          </>
        }
        actions={
          !vehicle.isActive ? (
            canEdit ? (
              <RestoreVehicleButton vehicleId={vehicle.id} plate={vehicle.plateNumber} />
            ) : undefined
          ) : (
            <>
              {canEdit ? (
                <LinkButton href={`/vehicles/${vehicle.id}/edit`} variant="outline" size="lg">
                  <Pencil />
                  Edit
                </LinkButton>
              ) : null}
              {canEdit && !openJob ? (
                <DeleteVehicleButton vehicleId={vehicle.id} plate={vehicle.plateNumber} />
              ) : null}
              {canEdit ? (
                <LinkButton href={`/vehicles/${vehicle.id}/transfer`} variant="outline" size="lg">
                  <ArrowLeftRight />
                  Change owner
                </LinkButton>
              ) : null}
              <LinkButton
                href={`/appointments/new?vehicle=${vehicle.id}`}
                variant="outline"
                size="lg"
              >
                <CalendarDays />
                Book appointment
              </LinkButton>
              {openJob ? (
                <LinkButton href={`/job-cards/${openJob.id}`} size="lg">
                  Open {openJob.jobNumber}
                </LinkButton>
              ) : (
                <LinkButton href={`/check-in?vehicle=${vehicle.id}`} size="lg">
                  <LogIn />
                  Check in
                </LinkButton>
              )}
            </>
          )
        }
      />

      {!vehicle.isActive ? (
        <Panel className="border-destructive/30 bg-destructive/5 text-sm">
          This vehicle is deleted. It doesn&apos;t appear in lists, search or pickers; its service
          history below is kept.
        </Panel>
      ) : null}

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Section
          title="Service history"
          description={`${vehicle.jobCards.length} visit${vehicle.jobCards.length === 1 ? '' : 's'}`}
          className="xl:col-span-8"
        >
          {vehicle.jobCards.length === 0 ? (
            <EmptyState
              icon={History}
              title="No visits yet"
              description="Each job card is added to this vehicle's history."
            />
          ) : (
            <Panel padding="none">
              <ol className="divide-y divide-border">
                {vehicle.jobCards.map((job) => (
                  <li key={job.id}>
                    <Link
                      href={`/job-cards/${job.id}`}
                      className="flex flex-col gap-3 px-4 py-5 hover:bg-muted/60 sm:px-6"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <span className="font-medium">{job.jobNumber}</span>
                          <JobStatusBadge status={job.status} />
                          {job.customerId !== vehicle.customerId ? (
                            <StatusPill tone="neutral">
                              Previous owner · {job.customer.name}
                            </StatusPill>
                          ) : null}
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {formatDate(job.openedAt)}
                          {job.odometerReading !== null
                            ? ` · ${formatKm(job.odometerReading)}`
                            : ''}
                        </span>
                      </div>
                      <p className="text-sm">
                        <span className="text-muted-foreground">Complaint: </span>
                        {job.customerComplaint ?? '—'}
                      </p>
                      {job.diagnoses[0] ? (
                        <p className="text-sm">
                          <span className="text-muted-foreground">Diagnosis: </span>
                          {job.diagnoses[0].findings}
                        </p>
                      ) : null}
                      {job.estimates[0] ? (
                        <div className="flex items-center gap-3 text-sm">
                          <span className="text-muted-foreground">
                            {job.estimates[0].estimateNumber}
                          </span>
                          <span className="font-medium tabular-nums">
                            {formatMoney(job.estimates[0].totalAmount)}
                          </span>
                          <EstimateStatusPill status={job.estimates[0].status} />
                        </div>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ol>
            </Panel>
          )}
        </Section>

        <Stack gap="xl" className="xl:col-span-4">
          <Section title="Vehicle details">
            <Panel>
              <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-3 text-sm">
                {specs.map(([label, value]) => (
                  <div key={label} className="contents">
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="min-w-0 break-words">{value}</dd>
                  </div>
                ))}
              </dl>
            </Panel>
          </Section>
          {vehicle.appointments.length > 0 ? (
            <Section title="Upcoming appointments">
              <Panel padding="none">
                <ul className="divide-y divide-border">
                  {vehicle.appointments.map((appointment) => (
                    <li
                      key={appointment.id}
                      className="flex flex-col gap-1 px-4 py-3 text-sm sm:px-6"
                    >
                      <span className="font-medium">{formatDateTime(appointment.scheduledAt)}</span>
                      {appointment.notes ? (
                        <span className="text-muted-foreground">{appointment.notes}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </Panel>
            </Section>
          ) : null}
        </Stack>
      </Grid>
    </Stack>
  );
}
