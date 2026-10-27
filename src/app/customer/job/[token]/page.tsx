import type { Metadata, Viewport } from 'next';
import type { LucideIcon } from 'lucide-react';
import { Check, CircleCheck, CirclePause, Clock, Link2Off, Wrench } from 'lucide-react';
import { CUSTOMER_STEPS, getJobAccess, loadCustomerJob } from '@/lib/customer-access/job';
import { formatAed } from '@/lib/documents/model';
import { formatCalendarDate } from '@/lib/format';
import {
  CUSTOMER_BAR_COLOR,
  CUSTOMER_TONE,
  CustomerNotice,
  CustomerShell,
  type CustomerTone,
} from '@/components/customer/customer-shell';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { cn } from '@/lib/utils';

export const viewport: Viewport = { themeColor: CUSTOMER_BAR_COLOR };

const STAGE_ICON: Record<CustomerTone, LucideIcon> = {
  done: CircleCheck,
  moving: Wrench,
  waiting: Clock,
  stopped: CirclePause,
};

// A private link: never listed by search engines.
export const metadata: Metadata = { title: 'Your job card', robots: { index: false } };

/**
 * A job card as its customer sees it: where the job is now and the work
 * they approved, with its total (lib/customer-access/job.ts). Read-only.
 */
export default async function CustomerJobPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const access = await getJobAccess(token);

  if (access.state === 'invalid') {
    return (
      <CustomerShell label="Job card">
        <CustomerNotice icon={Link2Off} title="This link is not valid">
          It may have been copied incompletely. Please contact the workshop for an up-to-date link.
        </CustomerNotice>
      </CustomerShell>
    );
  }
  if (access.state === 'expired') {
    return (
      <CustomerShell organization={access.organization} label="Job card">
        <CustomerNotice icon={Clock} title="This link has expired">
          Please contact us for a new one
          {access.organization.phone ? ` — call ${access.organization.phone}` : ''}.
        </CustomerNotice>
      </CustomerShell>
    );
  }
  const job = await loadCustomerJob(token);
  if (!job) {
    return (
      <CustomerShell organization={access.organization} label="Job card">
        <CustomerNotice icon={Link2Off} title="This link is not valid">
          Please contact the workshop for an up-to-date link.
        </CustomerNotice>
      </CustomerShell>
    );
  }
  const { vehicle, stage } = job;
  const lines = job.estimates.flatMap((estimate) => estimate.items);
  const tone = CUSTOMER_TONE[stage.tone];
  const finished = stage.step === CUSTOMER_STEPS.length - 1;
  const StageIcon = STAGE_ICON[stage.tone];

  return (
    <CustomerShell organization={access.organization} label="Job card">
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Job card · {job.jobNumber}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">Hello {job.customer.name},</h1>
          <p className="text-muted-foreground">
            Here is where your vehicle&apos;s job is now, and the work you approved.
          </p>
        </header>

        <section className={cn('flex flex-col gap-5 rounded-2xl px-5 py-5', tone.card)}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              <span className={cn('text-xs font-medium tracking-wide uppercase', tone.accent)}>
                Now
              </span>
              <span className="text-2xl font-semibold tracking-tight">{stage.label}</span>
              <span className="text-sm text-muted-foreground">{stage.note}</span>
            </div>
            <StageIcon className={cn('size-7 shrink-0', tone.accent)} />
          </div>
          {stage.step >= 0 ? (
            <ol className="grid grid-cols-6 gap-1" aria-label="Job progress">
              {CUSTOMER_STEPS.map((step, index) => {
                // The last step, once reached, is done too: nothing is left open.
                const done = index < stage.step || (finished && index === stage.step);
                const current = index === stage.step && !finished;
                return (
                  <li
                    key={step}
                    aria-current={current ? 'step' : undefined}
                    className="flex flex-col items-center gap-1.5 text-center"
                  >
                    <span
                      className={cn(
                        'flex size-6 items-center justify-center rounded-full text-[11px] font-semibold',
                        done
                          ? tone.solid
                          : current
                            ? cn('bg-background ring-2', tone.ring, tone.accent)
                            : 'bg-foreground/10 text-muted-foreground',
                      )}
                    >
                      {done ? <Check className="size-3.5" /> : index + 1}
                    </span>
                    <span
                      className={cn(
                        'text-[10px] leading-tight sm:text-xs',
                        index <= stage.step ? 'font-medium' : 'text-muted-foreground',
                      )}
                    >
                      {step}
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Your vehicle</h2>
          <div className="flex flex-wrap items-center gap-3">
            <VehiclePlate plateNumber={vehicle.plateNumber} />
            <span className="font-medium">
              {[vehicle.make, vehicle.model, vehicle.year].filter(Boolean).join(' ')}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {`Received ${formatCalendarDate(job.openedAt)}`}
            {job.deliveredAt ? ` · delivered ${formatCalendarDate(job.deliveredAt)}` : ''}
          </p>
          {job.customerComplaint ? (
            <div className="rounded-xl bg-muted px-4 py-3 text-sm">
              <p className="text-xs font-medium text-muted-foreground">
                What you asked us to look at
              </p>
              <p className="mt-1 whitespace-pre-line">{job.customerComplaint}</p>
            </div>
          ) : null}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold">Work you approved</h2>
          {lines.length ? (
            <div className="overflow-hidden rounded-xl border border-border">
              <ul className="divide-y divide-border">
                {lines.map((line, index) => (
                  <li
                    key={index}
                    className="flex items-start justify-between gap-4 px-4 py-3 text-sm"
                  >
                    <span className="min-w-0">
                      <span className="block">{line.description}</span>
                      {Number(line.quantity) !== 1 ? (
                        <span className="text-xs text-muted-foreground">
                          {`Quantity ${Number(line.quantity.toString())}`}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 tabular-nums">
                      {formatAed(line.lineTotal.toString())}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="flex items-center justify-between gap-4 bg-muted/50 px-4 py-3 text-sm font-semibold">
                <span>Total, VAT included</span>
                <span className="tabular-nums">{formatAed(job.approvedTotal)}</span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing approved yet. When we send you a quotation, the work you approve shows here.
            </p>
          )}
        </section>
      </div>
    </CustomerShell>
  );
}
