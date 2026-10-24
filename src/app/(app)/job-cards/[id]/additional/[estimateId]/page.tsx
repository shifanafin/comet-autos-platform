import { getTaxCodeOptions } from '@/lib/accounting/tax-codes';
import { notFound } from 'next/navigation';
import type { ApprovalMethod } from '@/generated/prisma/enums';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { formatCalendarDate, formatDateTime, localDateString } from '@/lib/format';
import { getJobWorkspace } from '@/lib/workshop/workspace';
import { getAdditionalEstimate } from '@/lib/workshop/estimates';
import { resolveDefaultVatRate } from '@/lib/tax';
import { Grid, Panel, Section, Stack } from '@/components/layout/primitives';
import { JobContextHeader } from '@/components/workshop/job-context-header';
import { EstimateStatusPill } from '@/components/workshop/status-pills';
import { EstimateLines } from '@/components/workshop/estimate-lines';
import { editableBill, editableLine } from '@/lib/billing/editable-lines';
import { cn } from '@/lib/utils';
import { QuotationBuilder } from '@/components/workshop/quotation-builder';
import { NewLinkButton, RecordDecisionForm } from '@/components/workshop/quotation-controls';

const METHOD_LABEL: Record<ApprovalMethod, string> = {
  IN_PERSON: 'in person',
  PHONE: 'by phone',
  EMAIL: 'by email',
  SMS: 'by SMS / WhatsApp',
  DIGITAL_SIGNATURE: 'by signature',
  ONLINE: 'online, on the secure quotation link',
};

/** An ADDITIONAL work request: priced, sent and decided separately from the approved quotation. */
export default async function AdditionalWorkPage({
  params,
}: {
  params: Promise<{ id: string; estimateId: string }>;
}) {
  const user = await requireUser();
  const { id, estimateId } = await params;
  let workspace;
  let estimate;
  try {
    workspace = await getJobWorkspace(user, id);
    estimate = await getAdditionalEstimate(user, id, estimateId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { jobCard, status } = workspace;
  const canEdit = hasPermission(user, 'quotation.edit', { branchId: jobCard.branchId });
  const customer = jobCard.customer;
  const decision = estimate.approvals[0];
  const expired =
    estimate.status === 'SENT' &&
    estimate.validUntil !== null &&
    estimate.validUntil.toISOString().slice(0, 10) < localDateString();
  const defaultVatRate = await resolveDefaultVatRate(user.organizationId);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <JobContextHeader jobCard={jobCard} section="Additional work" />

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Section
          title={
            <span className="flex flex-wrap items-center gap-3">
              {estimate.estimateNumber}
              <EstimateStatusPill status={estimate.status} expired={expired} />
            </span>
          }
          description={
            estimate.status === 'DRAFT'
              ? `Additional work request · draft prepared by ${estimate.preparedBy.fullName}`
              : `Sent ${estimate.sentAt ? formatDateTime(estimate.sentAt) : ''}${estimate.sentBy ? ` by ${estimate.sentBy.fullName}` : ''}${estimate.validUntil ? ` · valid until ${formatCalendarDate(estimate.validUntil)}` : ''}`
          }
          className="xl:col-span-8"
        >
          <Panel className="border-warning/30 bg-warning/5">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              Found during the repair
            </p>
            <p className="mt-2 text-sm whitespace-pre-wrap">{estimate.notes}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              This is separate from the approved quotation. Nothing here is charged or becomes
              approved work until the customer approves it.
            </p>
          </Panel>

          {estimate.status === 'DRAFT' && canEdit && status === 'REPAIR' ? (
            <Panel className="sm:p-8">
              <QuotationBuilder
                estimateId={estimate.id}
                customerName={customer.name}
                recommendation={null}
                defaultVatRate={defaultVatRate}
                taxCodes={await getTaxCodeOptions(user.organizationId, 'sales')}
                initialValidUntil={
                  estimate.validUntil
                    ? estimate.validUntil.toISOString().slice(0, 10)
                    : localDateString()
                }
                minValidUntil={localDateString()}
                initialBill={editableBill(estimate)}
                initialLines={estimate.items
                  .filter((item) => item.itemType !== 'OTHER')
                  .map((item) => editableLine(item, item.id, defaultVatRate))}
              />
            </Panel>
          ) : estimate.items.length > 0 ? (
            <EstimateLines estimate={estimate} />
          ) : (
            <Panel>
              <p className="text-sm text-muted-foreground">No lines were priced on this request.</p>
            </Panel>
          )}
        </Section>

        <Stack gap="xl" className="xl:col-span-4">
          {decision ? (
            <Section title="Customer decision">
              <Panel
                className={cn(
                  decision.status === 'APPROVED'
                    ? 'border-success/30 bg-success/5'
                    : 'border-danger/30 bg-danger/5',
                )}
              >
                <p
                  className={cn(
                    'text-lg font-semibold',
                    decision.status === 'APPROVED' ? 'text-success' : 'text-danger',
                  )}
                >
                  {decision.status === 'APPROVED'
                    ? 'Approved — added to the approved work'
                    : 'Rejected — not to be done'}
                </p>
                <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Decided by</dt>
                  <dd>{decision.customer.name} (customer)</dd>
                  <dt className="text-muted-foreground">How</dt>
                  <dd>{METHOD_LABEL[decision.approvalMethod]}</dd>
                  <dt className="text-muted-foreground">When</dt>
                  <dd>{formatDateTime(decision.decidedAt)}</dd>
                  <dt className="text-muted-foreground">Sent by</dt>
                  <dd>{estimate.sentBy?.fullName ?? '—'}</dd>
                  {decision.recordedBy ? (
                    <>
                      <dt className="text-muted-foreground">Recorded by</dt>
                      <dd>{decision.recordedBy.fullName}</dd>
                    </>
                  ) : null}
                </dl>
              </Panel>
            </Section>
          ) : null}

          {estimate.status === 'SENT' && canEdit && !expired ? (
            <>
              <Section
                title="Waiting for the customer"
                description={`${customer.name} can approve or reject on their secure link.`}
              >
                <Panel>
                  <NewLinkButton estimateId={estimate.id} customerName={customer.name} />
                </Panel>
              </Section>
              <Section
                title="Record the decision"
                description="If the customer answers in person, by phone or by message."
              >
                <Panel>
                  <RecordDecisionForm estimateId={estimate.id} customerName={customer.name} />
                </Panel>
              </Section>
            </>
          ) : null}
        </Stack>
      </Grid>
    </Stack>
  );
}
