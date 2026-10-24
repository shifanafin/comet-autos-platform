import Link from 'next/link';
import { getTaxCodeOptions } from '@/lib/accounting/tax-codes';
import { draftDeleteBlocker } from '@/lib/workshop/estimates';
import { DeleteDraftQuotationButton } from '@/components/workshop/delete-draft-quotation';
import { notFound } from 'next/navigation';
import { ArrowRight, Car, ClipboardList, Receipt, User } from 'lucide-react';
import type { ApprovalMethod } from '@/generated/prisma/enums';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { formatCalendarDate, formatDateTime, formatMoney, localDateString } from '@/lib/format';
import { getQuotation } from '@/lib/workshop/quotations';
import { approvedChangeBlocker, isOpenVersion } from '@/lib/workshop/estimates';
import { prisma } from '@/lib/prisma';
import { resolveDefaultVatRate } from '@/lib/tax';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { EstimateStatusPill } from '@/components/workshop/status-pills';
import { EstimateLines } from '@/components/workshop/estimate-lines';
import { editableBill, editableLine } from '@/lib/billing/editable-lines';
import { QuotationBuilder } from '@/components/workshop/quotation-builder';
import {
  NewLinkButton,
  RecordDecisionForm,
  ReopenVersionButton,
  SwitchVersionForm,
} from '@/components/workshop/quotation-controls';
import {
  ChangeQuotationPartyButton,
  QuotationHeaderActions,
} from '@/components/workshop/quotation-menu';
import { partyChangeBlocker } from '@/lib/workshop/quotation-copy';
import { getCustomerOptions } from '@/lib/customers/picker';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { LinkButton } from '@/components/shared/link-button';
import { StaffDocumentActions } from '@/components/documents/document-actions';
import { cn } from '@/lib/utils';
import { JobAdvances } from '@/components/finance/job-advances';
import { CLOSED_JOB_STATUSES } from '@/lib/workshop/stages';

/*
 * The quotation screen — one page for every quotation, whether it was raised
 * straight for a customer or opened from a job card. The job card, when
 * there is one, appears as a link beside the customer and the vehicle rather
 * than as the thing the page is about.
 */

const METHOD_LABEL: Record<ApprovalMethod, string> = {
  IN_PERSON: 'in person',
  PHONE: 'by phone',
  EMAIL: 'by email',
  SMS: 'by SMS / WhatsApp',
  DIGITAL_SIGNATURE: 'by signature',
  ONLINE: 'online, on the secure quotation link',
};

export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  let quotation;
  try {
    quotation = await getQuotation(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { customer, vehicle, jobCard, expired, isLatest, isOpenOption, versions } = quotation;
  const current = versions.find((version) => version.isCurrent);
  const canEdit = hasPermission(user, 'quotation.edit', { branchId: quotation.branchId });
  // Replaced (or not chosen) while nothing is approved yet: it can be opened again.
  const canReopen =
    canEdit &&
    quotation.status === 'SENT' &&
    Boolean(quotation.replacedAt) &&
    !expired &&
    (current?.status === 'SENT' || current?.status === 'DRAFT');
  const canInvoice = hasPermission(user, 'invoice.create', { branchId: quotation.branchId });
  const canApprove = hasPermission(user, 'quotation.approve', { branchId: quotation.branchId });
  const defaultVatRate = await resolveDefaultVatRate(user.organizationId);
  const decision = quotation.approvals[0];
  const isDraft = quotation.status === 'DRAFT';
  const editable = isDraft && isLatest && canEdit;
  const approved = quotation.status === 'APPROVED' || quotation.status === 'PARTIALLY_APPROVED';
  // A first draft has nothing in the side column, so the builder takes the full width.
  const fullWidth = editable && versions.length <= 1 && !decision;
  const recommendation = jobCard?.diagnoses[0]?.recommendedAction ?? null;
  const history = {
    status: quotation.status,
    jobCardId: quotation.jobCardId,
    previousVersionId: quotation.previousVersionId,
    nextVersions: isLatest ? 0 : 1,
  };
  // Sent or rejected: editing makes the next version. Approved: changing it
  // makes the next version too, for the customer to approve — while nothing
  // has been built on the approval yet (not invoiced, work not started).
  const changeBlocker =
    approved && isLatest && canEdit
      ? await approvedChangeBlocker(prisma, user.organizationId, quotation)
      : null;
  const canRevise =
    canEdit &&
    isLatest &&
    quotation.kind !== 'ADDITIONAL' &&
    (quotation.status === 'SENT' || quotation.status === 'REJECTED' || (approved && !changeBlocker));
  // Another version is approved and nothing is built on it yet: the
  // customer may still change their mind to this one.
  const currentApproved =
    current?.status === 'APPROVED' || current?.status === 'PARTIALLY_APPROVED';
  const switchBlocker =
    canApprove &&
    !isLatest &&
    currentApproved &&
    (quotation.status === 'SENT' || quotation.status === 'REJECTED') &&
    quotation.kind === 'ORIGINAL' &&
    !expired &&
    current
      ? await approvedChangeBlocker(prisma, user.organizationId, {
          id: current.id,
          kind: quotation.kind,
          jobCardId: quotation.jobCardId,
        })
      : undefined;
  const canSwitch = switchBlocker === null;
  // On the approved version: the other versions it may still be changed to.
  const switchable =
    approved && isLatest && !changeBlocker
      ? versions.filter(
          (version) =>
            version.id !== quotation.id &&
            (version.status === 'SENT' || version.status === 'REJECTED'),
        )
      : [];
  const canDuplicate = hasPermission(user, 'quotation.edit', {
    branchId: user.primaryBranchId ?? quotation.branchId,
  });
  const canChangeParty = canEdit && !partyChangeBlocker(history);
  // A deposit is taken while the work is still ahead: not on a rejected or
  // superseded quotation, nor once the job has gone home.
  const advanceOpen =
    isLatest &&
    quotation.status !== 'REJECTED' &&
    !(jobCard && CLOSED_JOB_STATUSES.includes(jobCard.status));
  const partyOption = canChangeParty
    ? ((await getCustomerOptions(user, [customer.id]))[0] ?? null)
    : null;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            Quotation
            {jobCard ? (
              <>
                <span aria-hidden>·</span>
                <Link href={`/job-cards/${jobCard.id}`} className="text-primary hover:underline">
                  {jobCard.jobNumber}
                </Link>
              </>
            ) : null}
          </span>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {quotation.estimateNumber}
            <EstimateStatusPill status={quotation.status} expired={expired} />
          </span>
        }
        description={
          isDraft
            ? `Draft for ${customer.name}, prepared by ${quotation.preparedBy.fullName}.`
            : `For ${customer.name} · sent ${quotation.sentAt ? formatDateTime(quotation.sentAt) : ''}${
                quotation.validUntil
                  ? ` · valid until ${formatCalendarDate(quotation.validUntil)}`
                  : ''
              }`
        }
        leading={vehicle ? <VehiclePlate plateNumber={vehicle.plateNumber} /> : undefined}
        actions={
          <>
            <QuotationHeaderActions
              estimateId={quotation.id}
              canRevise={canRevise}
              canDuplicate={canDuplicate}
              approved={approved}
              canKeepOpen={quotation.status === 'SENT' && !expired}
            />
            {canChangeParty ? (
              <ChangeQuotationPartyButton
                estimateId={quotation.id}
                current={partyOption}
                vehicleId={vehicle?.id ?? null}
              />
            ) : null}
            {canEdit && !draftDeleteBlocker(history) ? (
              <DeleteDraftQuotationButton estimateId={quotation.id} />
            ) : null}
            {!isDraft ? (
              <StaffDocumentActions
                pdfUrl={`/documents/quotation/${quotation.id}`}
                target={{ kind: 'quotation', id: quotation.id }}
                canShare={canEdit && Boolean(vehicle) && !expired}
              />
            ) : null}
            {approved && isLatest && canInvoice ? (
              <LinkButton
                href={`/finance/invoices/new?quotation=${quotation.id}`}
                size="lg"
                className="w-full sm:w-auto"
              >
                <Receipt />
                Create invoice
              </LinkButton>
            ) : null}
          </>
        }
      />

      {changeBlocker ? (
        <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Need to change this approved quotation? </span>
          {changeBlocker}
        </p>
      ) : null}

      {isOpenOption ? (
        <div className="rounded-lg border border-info/30 bg-info/5 px-4 py-3 text-sm">
          Version {quotation.version} is still open as an option beside{' '}
          <Link
            href={`/quotations/${current?.id ?? quotation.id}`}
            className="font-medium underline"
          >
            version {current?.version}
          </Link>
          . The customer can approve either one; approving one closes the other.
        </div>
      ) : !isLatest ? (
        <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning">
          You are viewing an older version.{' '}
          <Link
            href={`/quotations/${current?.id ?? quotation.id}`}
            className="font-medium underline"
          >
            See the current version
          </Link>
          .
        </div>
      ) : null}

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Stack gap="xl" className={fullWidth ? 'xl:col-span-12' : 'xl:col-span-8'}>
          {editable ? (
            <Panel className="sm:p-8">
              <QuotationBuilder
                estimateId={quotation.id}
                customerName={customer.name}
                recommendation={recommendation}
                initialValidUntil={
                  quotation.validUntil
                    ? quotation.validUntil.toISOString().slice(0, 10)
                    : localDateString()
                }
                minValidUntil={localDateString()}
                defaultVatRate={defaultVatRate}
                taxCodes={await getTaxCodeOptions(user.organizationId, 'sales')}
                initialBill={editableBill(quotation)}
                initialLines={quotation.items
                  .filter((item) => item.itemType !== 'OTHER')
                  .map((item) => editableLine(item, item.id, defaultVatRate))}
              />
            </Panel>
          ) : (
            <EstimateLines estimate={quotation} />
          )}
        </Stack>

        <Stack gap="xl" className={cn('xl:col-span-4', fullWidth && 'hidden')}>
          <Section title="This quotation is for">
            <Panel padding="none">
              <ul className="divide-y divide-border text-sm">
                <li>
                  <Link
                    href={`/customers/${customer.id}`}
                    className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 hover:bg-muted/60 sm:px-6"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <User className="size-4 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium">{customer.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {customer.phone}
                        </span>
                      </span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
                {vehicle ? (
                  <li>
                    <Link
                      href={`/vehicles/${vehicle.id}`}
                      className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 hover:bg-muted/60 sm:px-6"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <Car className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            {vehicle.make} {vehicle.model} {vehicle.year ?? ''}
                          </span>
                          <span className="truncate text-xs text-muted-foreground">
                            {vehicle.plateNumber}
                          </span>
                        </span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ) : (
                  <li className="flex items-start gap-3 px-4 py-3 text-sm text-muted-foreground sm:px-6">
                    <Car className="mt-0.5 size-4 shrink-0" />
                    <span>
                      No vehicle on this quotation. Add one to send the customer a secure link —
                      they confirm their registration number to open it.
                    </span>
                  </li>
                )}
                {jobCard ? (
                  <li>
                    <Link
                      href={`/job-cards/${jobCard.id}`}
                      className="flex min-h-14 items-center justify-between gap-4 px-4 py-3 hover:bg-muted/60 sm:px-6"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <ClipboardList className="size-4 shrink-0 text-muted-foreground" />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{jobCard.jobNumber}</span>
                          <span className="truncate text-xs text-muted-foreground">Job card</span>
                        </span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ) : null}
              </ul>
            </Panel>
          </Section>

          <JobAdvances
            user={user}
            open={advanceOpen}
            jobCard={jobCard ? { id: jobCard.id, branchId: quotation.branchId } : undefined}
            quotation={
              jobCard
                ? undefined
                : { customerId: customer.id, vehicleId: vehicle?.id ?? null, branchId: quotation.branchId }
            }
          />

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
                  {decision.status === 'APPROVED' ? 'Approved' : 'Rejected'}
                </p>
                <dl className="mt-4 grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2 text-sm">
                  <dt className="text-muted-foreground">Decided by</dt>
                  <dd>{decision.customer.name} (customer)</dd>
                  <dt className="text-muted-foreground">How</dt>
                  <dd>{METHOD_LABEL[decision.approvalMethod]}</dd>
                  <dt className="text-muted-foreground">When</dt>
                  <dd>{formatDateTime(decision.decidedAt)}</dd>
                  <dt className="text-muted-foreground">Sent by</dt>
                  <dd>{quotation.sentBy?.fullName ?? '—'}</dd>
                  {decision.recordedBy ? (
                    <>
                      <dt className="text-muted-foreground">Recorded by</dt>
                      <dd>{decision.recordedBy.fullName}</dd>
                    </>
                  ) : null}
                </dl>
                {decision.notes ? (
                  <p className="mt-4 border-t border-border pt-4 text-sm whitespace-pre-wrap">
                    “{decision.notes}”
                  </p>
                ) : null}
                {quotation.status === 'REJECTED' && canRevise ? (
                  <p className="mt-4 text-sm text-muted-foreground">
                    Use <span className="font-medium text-foreground">Edit</span> at the top to
                    change it and send a new version.
                  </p>
                ) : null}
              </Panel>
            </Section>
          ) : null}

          {quotation.status === 'SENT' && (isLatest || isOpenOption) && canEdit ? (
            <>
              <Section
                title={expired ? 'Quotation expired' : 'Waiting for the customer'}
                description={
                  expired
                    ? 'The validity date has passed. Use Edit at the top to send a fresh version.'
                    : `${customer.name} can approve or reject using their secure link. Lost the link? Create a new one.`
                }
              >
                <Panel className="flex flex-col gap-4">
                  {!expired ? (
                    <NewLinkButton estimateId={quotation.id} customerName={customer.name} />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Editing makes the next version; this one is kept.
                    </p>
                  )}
                </Panel>
              </Section>
              {!expired ? (
                <Section
                  title="Record the decision"
                  description="If the customer answers in person, by phone or by message."
                >
                  <Panel>
                    <RecordDecisionForm estimateId={quotation.id} customerName={customer.name} />
                  </Panel>
                </Section>
              ) : null}
            </>
          ) : null}

          {canSwitch && current ? (
            <Section
              title="Approve this version instead"
              description={`Version ${current.version} is approved, but nothing is invoiced or done on it yet. If the customer has changed their mind, approve this one instead — only one version stays approved.`}
            >
              <Panel>
                <SwitchVersionForm
                  estimateId={quotation.id}
                  version={quotation.version}
                  approvedVersion={current.version}
                />
              </Panel>
            </Section>
          ) : null}

          {switchable.length ? (
            <p className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              Customer changed their mind? Open{' '}
              {switchable.map((version, index) => (
                <span key={version.id}>
                  {index > 0 ? ' or ' : ''}
                  <Link href={`/quotations/${version.id}`} className="font-medium text-primary hover:underline">
                    version {version.version}
                  </Link>
                </span>
              ))}{' '}
              and approve it instead — until this one is invoiced or work starts.
            </p>
          ) : null}

          {canReopen ? (
            <Section
              title="This version was replaced"
              description={`Version ${current?.version} is the current one. If the customer may still want this one, open it again as an option.`}
            >
              <Panel>
                <ReopenVersionButton estimateId={quotation.id} version={quotation.version} />
              </Panel>
            </Section>
          ) : null}

          {versions.length > 1 ? (
            <Section title="Versions">
              <Panel padding="none">
                <ul className="divide-y divide-border">
                  {versions.map((version) => (
                    <li key={version.id}>
                      <Link
                        href={`/quotations/${version.id}`}
                        className={cn(
                          'flex min-h-14 items-center justify-between gap-4 px-4 py-3 text-sm hover:bg-muted/60 sm:px-6',
                          version.id === quotation.id && 'bg-muted/60',
                        )}
                      >
                        <span className="flex flex-col gap-0.5">
                          <span className="font-medium">
                            Version {version.version}
                            {version.isCurrent ? (
                              <span className="font-normal text-muted-foreground"> · current</span>
                            ) : isOpenVersion(version) ? (
                              <span className="font-normal text-muted-foreground">
                                {' '}
                                · open option
                              </span>
                            ) : null}
                          </span>
                          <span className="text-xs text-muted-foreground tabular-nums">
                            {formatMoney(version.totalAmount)}
                          </span>
                        </span>
                        {version.status === 'SENT' && version.replacedAt ? (
                          <span className="text-xs text-muted-foreground">Replaced</span>
                        ) : (
                          <EstimateStatusPill status={version.status as never} />
                        )}
                      </Link>
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
