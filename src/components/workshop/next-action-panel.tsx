'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { ArrowRight, CheckCircle2, Clock, PauseCircle, TriangleAlert, XCircle } from 'lucide-react';
import type { JobCardStatus } from '@/generated/prisma/enums';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/shared/confirm-action';
import { JobStatusBadge } from '@/components/shared/job-status-badge';
import { changeJobStatusAction, startRepairAction } from '@/app/(app)/job-cards/[id]/actions';
import type { NextAction } from '@/lib/workshop/workspace';
import type { WorkflowStatus } from '@/lib/workshop/stages';
import { cn } from '@/lib/utils';

const TONE = {
  action: { box: 'border-primary/25 bg-accent/40', icon: ArrowRight, iconClass: 'bg-primary text-primary-foreground' },
  waiting: { box: 'border-warning/30 bg-warning/5', icon: Clock, iconClass: 'bg-warning/15 text-warning' },
  warning: { box: 'border-warning/30 bg-warning/5', icon: TriangleAlert, iconClass: 'bg-warning/15 text-warning' },
  done: { box: 'border-border bg-card', icon: CheckCircle2, iconClass: 'bg-muted text-muted-foreground' },
} as const;

/** "Current status → next action" — the most prominent block on every job card. */
export function NextActionPanel({
  jobCardId,
  status,
  next,
  canHold,
  canCancel,
}: {
  jobCardId: string;
  status: JobCardStatus;
  next: NextAction;
  canHold: boolean;
  canCancel: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const tone = TONE[next.tone];
  const Icon = tone.icon;

  function apply(toStatus: WorkflowStatus) {
    setError(null);
    startTransition(async () => {
      const result = await changeJobStatusAction(jobCardId, toStatus);
      if (!result.ok) setError(result.error ?? 'Could not change the status.');
    });
  }

  function startRepair() {
    setError(null);
    startTransition(async () => {
      const result = await startRepairAction(jobCardId);
      if (!result.ok) setError(result.error ?? 'Could not start the repair.');
    });
  }

  return (
    <section
      aria-label="Current status and next action"
      className={cn('rounded-xl border px-4 py-5 sm:px-6', tone.box)}
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-full', tone.iconClass)}>
            <Icon className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              <span>Current status</span>
              <JobStatusBadge status={status} className="normal-case tracking-normal" />
            </div>
            <p className="text-lg font-semibold tracking-tight">{next.title}</p>
            <p className="text-sm text-muted-foreground">{next.description}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 lg:justify-end">
          {canHold ? (
            <Button variant="outline" disabled={isPending} onClick={() => apply('ON_HOLD')}>
              <PauseCircle />
              Put on hold
            </Button>
          ) : null}
          {canCancel ? (
            <ConfirmAction
              trigger={
                <Button variant="ghost" disabled={isPending}>
                  <XCircle />
                  Cancel job
                </Button>
              }
              title="Cancel this job card?"
              description="This stops the job permanently. It can't be resumed — the vehicle would need to be checked in again."
              confirmLabel="Cancel job"
              onConfirm={async () => apply('CANCELLED')}
            />
          ) : null}
          {next.href && next.label ? (
            <Button size="lg" nativeButton={false} render={<Link href={next.href} />}>
              {next.label}
              <ArrowRight />
            </Button>
          ) : null}
          {next.workflowAction === 'START_REPAIR' && next.label ? (
            <ConfirmAction
              tone="default"
              trigger={
                <Button size="lg" disabled={isPending}>
                  {isPending ? 'Starting…' : next.label}
                  <ArrowRight />
                </Button>
              }
              title="Start the repair?"
              description="The job moves to Repair. The approved work becomes the job list for the technicians."
              confirmLabel="Start repair"
              onConfirm={async () => startRepair()}
            />
          ) : null}
          {next.manualStatus && next.label ? (
            <Button size="lg" disabled={isPending} onClick={() => apply(next.manualStatus!)}>
              {isPending ? 'Updating…' : next.label}
              <ArrowRight />
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
