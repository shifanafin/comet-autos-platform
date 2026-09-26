import { FileText } from 'lucide-react';
import { requireUser } from '@/lib/auth/authorize';
import { getWorkQueues } from '@/lib/workshop/workspace';
import { PageHeader, Section, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { JobQueue } from '@/components/workshop/job-queue';
import { EstimateTable } from '@/components/workshop/estimate-table';

export default async function EstimatesPage() {
  const user = await requireUser();
  const queues = await getWorkQueues(user);
  const drafts = queues.estimates.filter((e) => e.status === 'DRAFT');
  const others = queues.estimates.filter((e) => e.status !== 'DRAFT');

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Workshop"
        title="Quotation queue"
        description="Job cards in the detailed workflow that need pricing, and quotations in progress. Every quotation is also on the Quotations page."
      />
      <JobQueue
        title="Needs a quotation"
        description="Diagnosis recorded — price the recommended work."
        jobs={queues.needsEstimate}
        actionLabel="Create quotation"
        hrefFor={(job) => `/job-cards/${job.id}/estimate`}
        empty="Every diagnosed job card has a quotation."
      />
      <Section title={`Drafts (${drafts.length})`} description="Not yet sent to the customer.">
        {drafts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">No drafts.</p>
        ) : (
          <EstimateTable estimates={drafts} dateLabel="updated" />
        )}
      </Section>
      <Section title="Sent and decided" description="The current version of every quotation that has been sent.">
        {others.length === 0 ? (
          <EmptyState icon={FileText} title="No quotations sent yet" description="Sent estimates appear here with their approval status." />
        ) : (
          <EstimateTable estimates={others} dateLabel="sent" />
        )}
      </Section>
    </Stack>
  );
}
