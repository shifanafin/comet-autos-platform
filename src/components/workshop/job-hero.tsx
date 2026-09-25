import Link from 'next/link';
import { ChevronRight, Gauge, Phone, UserRound, Wrench } from 'lucide-react';
import type { JobCardStatus } from '@/generated/prisma/enums';
import { JobStatusBadge } from '@/components/shared/job-status-badge';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { formatDateTime } from '@/lib/format';

/**
 * The top of the job card: which vehicle, whose, which job and where it
 * stands — readable at arm's length on a tablet and first on a phone.
 * Vehicle and registration are the headline; the customer is one tap from a
 * call; technician, mileage and check-in time are secondary.
 */
export function JobHero({
  jobCard,
  technician,
  showTechnician = true,
}: {
  jobCard: {
    id: string;
    jobNumber: string;
    status: JobCardStatus;
    openedAt: Date;
    odometerReading: number | null;
    vehicle: {
      id: string;
      plateNumber: string;
      make: string;
      model: string;
      year: number | null;
    };
    customer: { id: string; name: string; phone: string };
  };
  technician: string | null;
  /** Off on the minimal job card, where nobody is assigned. */
  showTechnician?: boolean;
}) {
  const { vehicle } = jobCard;
  return (
    <header className="flex flex-col gap-4 border-b border-border pb-6 sm:pb-8">
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 text-xs text-muted-foreground"
      >
        <Link
          href="/job-cards"
          className="inline-flex min-h-9 items-center hover:text-foreground md:min-h-0"
        >
          Work Orders
        </Link>
        <ChevronRight className="size-3.5" />
        <span className="font-medium text-foreground">{jobCard.jobNumber}</span>
      </nav>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-sm font-semibold tracking-wide text-muted-foreground">
              {jobCard.jobNumber}
            </span>
            <JobStatusBadge status={jobCard.status} size="lg" />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="text-2xl leading-tight font-semibold tracking-tight sm:text-3xl">
              {vehicle.make} {vehicle.model}
              {vehicle.year ? (
                <span className="font-normal text-muted-foreground"> {vehicle.year}</span>
              ) : null}
            </h1>
            <Link href={`/vehicles/${vehicle.id}`} aria-label={`Vehicle ${vehicle.plateNumber}`}>
              <VehiclePlate plateNumber={vehicle.plateNumber} className="px-3 py-1 text-base" />
            </Link>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 lg:justify-end">
          <Link
            href={`/customers/${jobCard.customer.id}`}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted"
          >
            <UserRound className="size-4 text-muted-foreground" />
            {jobCard.customer.name}
          </Link>
          <a
            href={`tel:${jobCard.customer.phone.replace(/[^\d+]/g, '')}`}
            className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium tabular-nums hover:bg-muted"
            aria-label={`Call ${jobCard.customer.name}`}
          >
            <Phone className="size-4 text-muted-foreground" />
            {jobCard.customer.phone}
          </a>
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-6 gap-y-1.5 text-sm text-muted-foreground">
        {showTechnician ? (
          <div className="flex items-center gap-1.5">
            <Wrench className="size-4" />
            <dt className="sr-only">Technician</dt>
            <dd className={technician ? 'text-foreground' : undefined}>
              {technician ?? 'No technician assigned'}
            </dd>
          </div>
        ) : null}
        {jobCard.odometerReading !== null ? (
          <div className="flex items-center gap-1.5">
            <Gauge className="size-4" />
            <dt className="sr-only">Mileage at check-in</dt>
            <dd className="tabular-nums">{jobCard.odometerReading.toLocaleString('en-AE')} km</dd>
          </div>
        ) : null}
        <div className="flex items-center gap-1.5">
          <dt>Checked in</dt>
          <dd>{formatDateTime(jobCard.openedAt)}</dd>
        </div>
      </dl>
    </header>
  );
}
