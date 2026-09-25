import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowRight,
  Camera,
  ClipboardCheck,
  FileText,
  Stethoscope,
  Wrench,
  Receipt,
  type LucideIcon,
} from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { formatCalendarDate, formatDateTime, formatMoney } from '@/lib/format';
import { getJobWorkspace, getNextAction } from '@/lib/workshop/workspace';
import { getSecondaryNextStatuses } from '@/lib/workshop/job-status';
import { employeeName, listWorkshopEmployees } from '@/lib/workshop/assignment';
import { Grid, Panel, Section, Stack } from '@/components/layout/primitives';
import { JobHero } from '@/components/workshop/job-hero';
import { JobQuickActions } from '@/components/workshop/job-quick-actions';
import { NextActionPanel } from '@/components/workshop/next-action-panel';
import { TechnicianForm } from '@/components/workshop/technician-form';
import { EstimateStatusPill, InspectionResultPill } from '@/components/workshop/status-pills';
import { StatusPill } from '@/components/shared/status-pill';
import { WorkflowProgress } from '@/components/shared/workflow-progress';
import { StatusTimeline } from '@/components/shared/status-timeline';
import { JobPhotos } from '@/components/media/job-photos';
import { JobSignatures } from '@/components/media/job-signatures';
import { listJobPhotos, listJobSignatures } from '@/lib/media/photos';
import { defaultMediaStage } from '@/lib/media/stages';
import { cn } from '@/lib/utils';
import { getRepairWorkspace } from '@/lib/workshop/repair';
import type { WorkflowStatus } from '@/lib/workshop/stages';
import { RepairSections } from './repair/repair-sections';
import { BillingSections } from './billing/billing-sections';
import { getBillingPreview, getJobInvoice } from '@/lib/billing/invoice';
import { getJobDocuments, type JobDocuments } from '@/lib/documents/build';
import { CreateEstimateButton } from '@/components/workshop/quotation-controls';
import { CustomerCommunication } from '@/components/documents/customer-communication';
import { usesDetailedJobCards } from '@/lib/organization/settings';
import { MinimalJobCard } from './minimal-job-card';

const BILLING_PHASE: WorkflowStatus[] = ['READY', 'INVOICED', 'PAID', 'DELIVERED'];
const REPAIR_PHASE: WorkflowStatus[] = [
  'APPROVED',
  'REPAIR',
  'QUALITY_CHECK',
  'READY',
  'INVOICED',
  'PAID',
  'DELIVERED',
];
/** Stages only the standard job card's steps lead into, or out of. */
const STANDARD_ONLY: WorkflowStatus[] = [
  'INSPECTION',
  'DIAGNOSIS',
  'REPAIR',
  'QUALITY_CHECK',
  'READY',
  'ON_HOLD',
];

export default async function JobCardWorkspacePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;

  let workspace;
  try {
    workspace = await getJobWorkspace(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  // The minimal job card unless the workshop chose the standard one — or
  // this job is already part-way through the standard steps, which only
  // the standard job card can finish.
  const standard = STANDARD_ONLY.includes(workspace.status) || (await usesDetailedJobCards(user));
  if (!standard) return <MinimalJobCard user={user} workspace={workspace} />;

  const {
    jobCard,
    status,
    primaryTechnician,
    inspection,
    diagnosis,
    estimate,
    estimateExpired,
    effectiveStatus,
  } = workspace;
  const next = getNextAction(workspace);
  const secondary = getSecondaryNextStatuses(jobCard.status);
  const canEdit = hasPermission(user, 'job_card.edit', { branchId: jobCard.branchId });
  const canAssign = hasPermission(user, 'job_card.assign', { branchId: jobCard.branchId });
  const canIssueParts = hasPermission(user, 'inventory.issue', { branchId: jobCard.branchId });
  const canPay = hasPermission(user, 'payment.create', { branchId: jobCard.branchId });
  const repairPhase = REPAIR_PHASE.includes(status);
  const billingPhase = BILLING_PHASE.includes(status);
  // Independent reads, fetched together rather than one after another.
  const [employees, repair, invoice, documents, photos, signatures] = await Promise.all([
    canAssign || canEdit ? listWorkshopEmployees(user) : Promise.resolve([]),
    repairPhase ? getRepairWorkspace(user, jobCard.id) : Promise.resolve(null),
    billingPhase ? getJobInvoice(user, jobCard.id) : Promise.resolve(null),
    getJobDocuments(user, jobCard.id),
    listJobPhotos(user, jobCard.id),
    listJobSignatures(user, jobCard.id),
  ]);
  const preview = billingPhase && !invoice ? await getBillingPreview(user, jobCard.id) : null;
  const hasDocuments = documents.quotations.length > 0 || documents.invoice !== null;
  const employeeOptions = employees.map((e) => ({
    id: e.id,
    name: employeeName(e),
    jobTitle: e.jobTitle,
  }));
  const isFinished = status === 'DELIVERED' || status === 'CANCELLED';
  const base = `/job-cards/${jobCard.id}`;

  const flagged = inspection?.items.filter((item) => item.result !== 'OK') ?? [];

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <JobHero
        jobCard={jobCard}
        technician={primaryTechnician ? employeeName(primaryTechnician) : null}
      />

      {/* The documents first: quote it, bill it, photograph it. */}
      <WorkOrderDocuments
        jobCardId={jobCard.id}
        status={status}
        estimate={estimate}
        invoice={documents.invoice}
        canQuote={canEdit && !isFinished}
        canInvoice={
          !isFinished && hasPermission(user, 'invoice.create', { branchId: jobCard.branchId })
        }
        canPhoto={canEdit && !isFinished}
      />

      {/*
       * The detailed lifecycle — technician, inspection, diagnosis, repair,
       * quality check, delivery. Available on every work order, required on
       * none: the documents above work at any stage.
       */}
      <Section
        title="Detailed workflow"
        description="Optional. Use it when a job goes through inspection, repair and quality check."
      >
        <Stack gap="lg">
          <NextActionPanel
            jobCardId={jobCard.id}
            status={jobCard.status}
            next={next}
            canHold={canEdit && secondary.includes('ON_HOLD')}
            canCancel={canEdit && secondary.includes('CANCELLED')}
          />
          <Panel>
            <WorkflowProgress effectiveStatus={effectiveStatus} />
          </Panel>
        </Stack>
      </Section>

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        {/* Main column: the work itself, in workflow order */}
        <Stack gap="2xl" className="xl:col-span-8">
          {billingPhase ? (
            <BillingSections
              workspace={workspace}
              status={status}
              invoice={invoice}
              preview={preview}
              canInvoice={hasPermission(user, 'invoice.create', { branchId: jobCard.branchId })}
              canPay={canPay}
              canDeliver={hasPermission(user, 'job_card.close', { branchId: jobCard.branchId })}
            />
          ) : null}
          {repair ? (
            <RepairSections
              workspace={workspace}
              repair={repair}
              status={status}
              canEdit={canEdit}
              canIssueParts={canIssueParts}
              employees={employeeOptions}
            />
          ) : null}
          <Section
            title={repairPhase ? 'Before the repair' : 'Workshop progress'}
            description={
              repairPhase
                ? 'Inspection, diagnosis and the approved quotation.'
                : 'Each step of the job, in order.'
            }
          >
            <Panel padding="none">
              <ul className="divide-y divide-border">
                <ProgressRow
                  icon={ClipboardCheck}
                  title="Inspection"
                  href={`${base}/inspection`}
                  status={
                    inspection ? (
                      inspection.status === 'COMPLETED' ? (
                        <StatusPill tone="success">Complete</StatusPill>
                      ) : (
                        <StatusPill tone="info">In progress</StatusPill>
                      )
                    ) : (
                      <StatusPill tone="neutral">Not started</StatusPill>
                    )
                  }
                  linkLabel={
                    inspection
                      ? 'Open inspection'
                      : status === 'ARRIVED'
                        ? 'Start inspection'
                        : undefined
                  }
                >
                  {inspection ? (
                    <div className="flex flex-col gap-3">
                      <p className="text-sm text-muted-foreground">
                        By {employeeName(inspection.inspectedByEmployee)} ·{' '}
                        {inspection.items.length} checkpoint
                        {inspection.items.length === 1 ? '' : 's'} recorded
                        {inspection.status === 'COMPLETED'
                          ? ` · ${formatDateTime(inspection.inspectedAt)}`
                          : ''}
                      </p>
                      {flagged.length > 0 ? (
                        <ul className="flex flex-col gap-2">
                          {flagged.slice(0, 4).map((item) => (
                            <li key={item.id} className="flex items-start gap-3 text-sm">
                              <InspectionResultPill result={item.result} />
                              <span className="min-w-0">
                                <span className="font-medium">{item.description}</span>
                                {item.notes ? (
                                  <span className="text-muted-foreground"> — {item.notes}</span>
                                ) : null}
                              </span>
                            </li>
                          ))}
                        </ul>
                      ) : inspection.items.length > 0 ? (
                        <p className="text-sm text-success">No problems found.</p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      The technician checks the vehicle against the standard checklist.
                    </p>
                  )}
                </ProgressRow>

                <ProgressRow
                  icon={Stethoscope}
                  title="Diagnosis"
                  href={`${base}/diagnosis`}
                  status={
                    diagnosis ? (
                      <StatusPill tone="success">Recorded</StatusPill>
                    ) : (
                      <StatusPill tone="neutral">Not recorded</StatusPill>
                    )
                  }
                  linkLabel={
                    diagnosis
                      ? 'View diagnosis'
                      : inspection?.status === 'COMPLETED'
                        ? 'Record diagnosis'
                        : undefined
                  }
                >
                  {diagnosis ? (
                    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[9rem_1fr]">
                      <dt className="text-muted-foreground">Diagnosis</dt>
                      <dd className="whitespace-pre-wrap">{diagnosis.findings}</dd>
                      <dt className="text-muted-foreground">Recommendation</dt>
                      <dd className="whitespace-pre-wrap">{diagnosis.recommendedAction ?? '—'}</dd>
                    </dl>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      What is wrong, and the work recommended to fix it.
                    </p>
                  )}
                </ProgressRow>

                <ProgressRow
                  icon={FileText}
                  title="Quotation & approval"
                  href={estimate ? `/quotations/${estimate.id}` : `${base}/estimate`}
                  status={
                    estimate ? (
                      <EstimateStatusPill status={estimate.status} expired={estimateExpired} />
                    ) : (
                      <StatusPill tone="neutral">Not created</StatusPill>
                    )
                  }
                  linkLabel={
                    estimate
                      ? 'Open quotation'
                      : QUOTABLE.includes(status)
                        ? 'Create quotation'
                        : undefined
                  }
                >
                  {estimate ? (
                    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
                      <span className="font-medium">
                        {estimate.estimateNumber}
                        {estimate.version > 1 ? (
                          <span className="text-muted-foreground">
                            {' '}
                            · version {estimate.version}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-base font-semibold tabular-nums">
                        {formatMoney(estimate.totalAmount)}
                      </span>
                      <span className="text-muted-foreground">
                        {estimate.approvals[0]
                          ? `${estimate.approvals[0].status === 'APPROVED' ? 'Approved' : 'Rejected'} ${formatDateTime(estimate.approvals[0].decidedAt)} by ${estimate.approvals[0].customer.name}${estimate.approvals[0].approvalMethod === 'ONLINE' ? ' online' : ''}`
                          : estimate.sentAt
                            ? `Sent ${formatDateTime(estimate.sentAt)}${estimate.validUntil ? ` · valid until ${formatCalendarDate(estimate.validUntil)}` : ''}`
                            : `${estimate.items.length} line${estimate.items.length === 1 ? '' : 's'} · draft`}
                      </span>
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Labour and parts priced with VAT, sent to the customer to approve. Inspection
                      and diagnosis are optional — a work order can be quoted straight away.
                    </p>
                  )}
                </ProgressRow>

                {!repairPhase ? (
                  <ProgressRow
                    icon={Wrench}
                    title="Repair & quality check"
                    status={<StatusPill tone="neutral">After approval</StatusPill>}
                  >
                    <p className="text-sm text-muted-foreground">
                      Parts, labour and the quality check are recorded once the customer approves.
                    </p>
                  </ProgressRow>
                ) : null}
                {!billingPhase ? (
                  <ProgressRow
                    icon={Receipt}
                    title="Invoice & delivery"
                    status={
                      documents.invoice ? (
                        <StatusPill tone={documents.invoice.status.tone}>
                          {documents.invoice.status.label}
                        </StatusPill>
                      ) : (
                        <StatusPill tone="neutral">Not invoiced</StatusPill>
                      )
                    }
                  >
                    <p className="text-sm text-muted-foreground">
                      {documents.invoice
                        ? `Invoiced as ${documents.invoice.number}.`
                        : 'The work order can be invoiced at any stage from the documents above, or after the quality check from the repair records.'}
                    </p>
                  </ProgressRow>
                ) : null}
              </ul>
            </Panel>
          </Section>

          <section id="photos" className="flex scroll-mt-24 flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold tracking-tight">Photos</h2>
              <p className="text-sm text-muted-foreground">
                What the vehicle looked like at each stage — evidence for the customer and for the
                workshop.
              </p>
            </div>
            <JobPhotos
              jobCardId={jobCard.id}
              photos={photos.map((photo) => ({
                id: photo.id,
                stage: photo.stage,
                description: photo.description,
                createdAt: formatDateTime(photo.createdAt),
                uploadedBy: photo.uploadedBy?.fullName ?? 'Workshop',
              }))}
              defaultStage={defaultMediaStage(jobCard.status)}
              canEdit={canEdit && !isFinished}
            />
          </section>

          <Section title="Signatures" description="Signed approvals and handovers on this job.">
            <Panel padding="none">
              <JobSignatures signatures={signatures} />
            </Panel>
          </Section>
        </Stack>

        {/* Side column: who, what, when */}
        <Stack gap="xl" className="xl:col-span-4">
          {hasDocuments ? (
            <Section
              title="Customer communication"
              description="Send documents to the customer on WhatsApp."
            >
              <CustomerCommunication documents={documents} canShareQuotation={canEdit} />
            </Section>
          ) : null}

          <Section title="Visit">
            <Panel>
              <dl className="flex flex-col gap-4 text-sm">
                <DetailRow label="Customer complaint">
                  <span className="whitespace-pre-wrap">{jobCard.customerComplaint ?? '—'}</span>
                </DetailRow>
                <DetailRow label="Mileage at check-in">
                  {jobCard.odometerReading !== null
                    ? `${jobCard.odometerReading.toLocaleString('en-AE')} km`
                    : '—'}
                </DetailRow>
                <DetailRow label="Checked in">
                  {formatDateTime(jobCard.openedAt)} by {jobCard.createdBy.fullName}
                </DetailRow>
                <DetailRow label="Arrived as">
                  {jobCard.appointment
                    ? `Appointment (${formatDateTime(jobCard.appointment.scheduledAt)})`
                    : 'Walk-in'}
                </DetailRow>
                {jobCard.closedAt ? (
                  <DetailRow label="Closed">{formatDateTime(jobCard.closedAt)}</DetailRow>
                ) : null}
              </dl>
            </Panel>
          </Section>

          <Section title="Vehicle & owner">
            <Panel padding="none">
              <ul className="divide-y divide-border text-sm">
                <li>
                  <Link
                    href={`/vehicles/${jobCard.vehicle.id}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/60 sm:px-6"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">
                        {jobCard.vehicle.make} {jobCard.vehicle.model} {jobCard.vehicle.year ?? ''}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {jobCard.vehicle.plateNumber}
                        {jobCard.vehicle.vin ? ` · VIN ${jobCard.vehicle.vin}` : ''} · Service
                        history
                      </span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
                <li>
                  <Link
                    href={`/customers/${jobCard.customer.id}`}
                    className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/60 sm:px-6"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">{jobCard.customer.name}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        {jobCard.customer.phone}
                        {jobCard.customer.email ? ` · ${jobCard.customer.email}` : ''}
                      </span>
                    </span>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              </ul>
            </Panel>
          </Section>

          <section id="technician" className="flex scroll-mt-24 flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold tracking-tight">Technician</h2>
              <p className="text-sm text-muted-foreground">
                {primaryTechnician
                  ? `${employeeName(primaryTechnician)} is responsible for this job.`
                  : 'Nobody is assigned yet.'}
              </p>
            </div>
            {canAssign && !isFinished ? (
              <Panel>
                <TechnicianForm
                  jobCardId={jobCard.id}
                  currentEmployeeId={primaryTechnician?.id ?? null}
                  employees={employees.map((e) => ({
                    id: e.id,
                    name: employeeName(e),
                    jobTitle: e.jobTitle,
                  }))}
                />
              </Panel>
            ) : null}
          </section>

          <Section title="History" description="Every status change on this job.">
            <Panel>
              <StatusTimeline entries={jobCard.statusHistory} />
            </Panel>
          </Section>
        </Stack>
      </Grid>

      {!isFinished ? (
        <JobQuickActions
          jobCardId={jobCard.id}
          status={status}
          canEdit={canEdit}
          canIssueParts={canIssueParts}
          canPay={canPay}
        />
      ) : null}
    </Stack>
  );
}

function ProgressRow({
  icon: Icon,
  title,
  status,
  href,
  linkLabel,
  children,
}: {
  icon: LucideIcon;
  title: string;
  status: React.ReactNode;
  href?: string;
  linkLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4 px-4 py-5 sm:px-6">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold">{title}</h3>
            {status}
          </div>
          {href && linkLabel ? (
            <Link
              href={href}
              className={cn(
                'inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover md:min-h-0',
              )}
            >
              {linkLabel}
              <ArrowRight className="size-4" />
            </Link>
          ) : null}
        </div>
        {children}
      </div>
    </li>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Stages a work order can be quoted from — mirrors QUOTABLE_STATUSES in lib/workshop/estimates.ts. */
const QUOTABLE: WorkflowStatus[] = ['ARRIVED', 'INSPECTION', 'DIAGNOSIS'];

/**
 * The work order's documents as three cards: its quotation, its invoice and
 * its photos. Each one offers the next thing to do with it, whatever stage
 * the detailed workflow below has or hasn't reached.
 */
function WorkOrderDocuments({
  jobCardId,
  status,
  estimate,
  invoice,
  canQuote,
  canInvoice,
  canPhoto,
}: {
  jobCardId: string;
  status: WorkflowStatus;
  estimate: {
    id: string;
    estimateNumber: string;
    status: string;
    totalAmount: { toString(): string };
  } | null;
  invoice: JobDocuments['invoice'];
  canQuote: boolean;
  canInvoice: boolean;
  canPhoto: boolean;
}) {
  const approved = estimate?.status === 'APPROVED' || estimate?.status === 'PARTIALLY_APPROVED';
  // A job that went through repair and QC is billed from its repair records.
  const billFromRepair = status === 'READY';

  const card =
    'flex min-h-28 flex-col justify-between gap-3 rounded-xl border border-border bg-card p-4 sm:p-5';
  const primary =
    'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-hover';
  const secondary =
    'inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium transition-colors hover:bg-muted';

  return (
    <section aria-label="Documents" className="grid gap-3 sm:grid-cols-3">
      <div className={card}>
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <FileText className="size-4 text-muted-foreground" />
            Quotation
          </span>
          {estimate ? (
            <span className="text-sm font-semibold tabular-nums">
              {formatMoney(estimate.totalAmount)}
            </span>
          ) : null}
        </div>
        {estimate ? (
          <Link href={`/quotations/${estimate.id}`} className={secondary}>
            Open {estimate.estimateNumber}
            <ArrowRight className="size-4" />
          </Link>
        ) : canQuote && QUOTABLE.includes(status) ? (
          <CreateEstimateButton jobCardId={jobCardId} compact />
        ) : (
          <p className="text-sm text-muted-foreground">No quotation on this work order.</p>
        )}
      </div>

      <div className={card}>
        <div className="flex items-start justify-between gap-3">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Receipt className="size-4 text-muted-foreground" />
            Invoice
          </span>
          {invoice ? (
            <StatusPill tone={invoice.status.tone}>{invoice.status.label}</StatusPill>
          ) : null}
        </div>
        {invoice ? (
          <Link href={`/finance/invoices/${invoice.id}`} className={secondary}>
            Open {invoice.number}
            <ArrowRight className="size-4" />
          </Link>
        ) : canInvoice && billFromRepair ? (
          <a href="#invoice" className={primary}>
            <Receipt className="size-4" />
            Invoice the repair
          </a>
        ) : canInvoice ? (
          <Link
            href={
              approved && estimate
                ? `/finance/invoices/new?quotation=${estimate.id}`
                : `/finance/invoices/new?workOrder=${jobCardId}`
            }
            className={estimate && !approved ? secondary : primary}
          >
            <Receipt className="size-4" />
            {approved ? 'Invoice the quotation' : 'Create invoice'}
          </Link>
        ) : (
          <p className="text-sm text-muted-foreground">Not invoiced yet.</p>
        )}
      </div>

      <div className={card}>
        <span className="flex items-center gap-2 text-sm font-medium">
          <Camera className="size-4 text-muted-foreground" />
          Photos
        </span>
        {canPhoto ? (
          <a href="#photos" className={secondary}>
            <Camera className="size-4" />
            Take or add photos
          </a>
        ) : (
          <a href="#photos" className={secondary}>
            View photos
          </a>
        )}
      </div>
    </section>
  );
}
