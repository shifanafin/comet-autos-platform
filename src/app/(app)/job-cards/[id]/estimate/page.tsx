import { notFound, redirect } from 'next/navigation';
import { FileText } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getJobWorkspace, type JobWorkspace } from '@/lib/workshop/workspace';
import { Panel, Section, Stack } from '@/components/layout/primitives';
import { JobContextHeader } from '@/components/workshop/job-context-header';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { CreateEstimateButton } from '@/components/workshop/quotation-controls';

/*
 * The job card's quotation. A quotation is the same document wherever it
 * was raised, so once one exists this hands over to /quotations/<id> rather
 * than keeping a second copy of that screen. What stays here is the one
 * thing that only makes sense from a job card: opening its first
 * quotation.
 */

/** Stages a job card can still be quoted from — mirrors QUOTABLE_STATUSES in lib/workshop/estimates.ts. */
const QUOTABLE = ['ARRIVED', 'INSPECTION', 'DIAGNOSIS'];

export default async function JobQuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  let workspace: JobWorkspace;
  try {
    workspace = await getJobWorkspace(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { jobCard, status, diagnosis, estimate } = workspace;
  if (estimate) redirect(`/quotations/${estimate.id}`);

  const canEdit = hasPermission(user, 'job_card.edit', { branchId: jobCard.branchId });

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <JobContextHeader jobCard={jobCard} section="Quotation" />
      {QUOTABLE.includes(status) && canEdit ? (
        <Section
          title="Quote this job card"
          description="Price the work with labour and parts. VAT is calculated per line from your organization's settings."
        >
          <Panel className="flex flex-col gap-6 sm:p-8">
            {diagnosis?.recommendedAction ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Recommended work
                </p>
                <p className="text-sm whitespace-pre-wrap">{diagnosis.recommendedAction}</p>
              </div>
            ) : jobCard.customerComplaint ? (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Work requested
                </p>
                <p className="text-sm whitespace-pre-wrap">{jobCard.customerComplaint}</p>
              </div>
            ) : null}
            <CreateEstimateButton jobCardId={jobCard.id} />
          </Panel>
        </Section>
      ) : (
        <EmptyState
          icon={FileText}
          title="No quotation on this job card"
          description="This job card has moved past the quotation stage."
          action={
            <LinkButton href={`/job-cards/${jobCard.id}`} variant="outline">
              Back to job card
            </LinkButton>
          }
        />
      )}
    </Stack>
  );
}
