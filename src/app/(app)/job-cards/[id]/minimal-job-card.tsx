import Link from 'next/link';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  FileText,
  KeyRound,
  Receipt,
  TriangleAlert,
  Wallet,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission } from '@/lib/auth/authorize';
import { formatDateTime, formatKm, formatMoney, toLocalDateTimeInput } from '@/lib/format';
import type { JobWorkspace } from '@/lib/workshop/workspace';
import { getSecondaryNextStatuses } from '@/lib/workshop/job-status';
import type { WorkflowStatus } from '@/lib/workshop/stages';
import { getJobInvoice } from '@/lib/billing/invoice';
import { getJobDocuments } from '@/lib/documents/build';
import { listJobPhotos } from '@/lib/media/photos';
import { defaultMediaStage } from '@/lib/media/stages';
import { cn } from '@/lib/utils';
import { JobDetailsEditor } from '@/components/workshop/job-details-editor';
import { Grid, Panel, Section, Stack } from '@/components/layout/primitives';
import { JobHero } from '@/components/workshop/job-hero';
import { JobQuickActions } from '@/components/workshop/job-quick-actions';
import { CancelJobButton } from '@/components/workshop/cancel-job-button';
import { CreateEstimateButton } from '@/components/workshop/quotation-controls';
import { EstimateStatusPill } from '@/components/workshop/status-pills';
import { StatusPill } from '@/components/shared/status-pill';
import { StatusTimeline } from '@/components/shared/status-timeline';
import { JobPhotos } from '@/components/media/job-photos';
import { InvoicePaymentForm } from '@/components/finance/invoice-payment-form';
import { CustomerCommunication } from '@/components/documents/customer-communication';
import { DeliveryForm } from './billing/billing-forms';

/*
 * The minimal job card: for a workshop where one person takes the vehicle
 * in, does the work, bills it and hands it back. One card says what to do
 * next — invoice, take the payment, hand over — and nothing asks for an
 * inspection, a diagnosis, a technician or a quality check.
 *
 * It runs on the same short path the state machine already allows
 * (ARRIVED → INVOICED → PAID → DELIVERED, optionally through a quotation),
 * so switching the workshop to the standard job card later loses nothing.
 */

/** Stages a job card can be quoted from — mirrors QUOTABLE_STATUSES in lib/workshop/estimates.ts. */
const QUOTABLE: WorkflowStatus[] = ['ARRIVED', 'INSPECTION', 'DIAGNOSIS'];

const BUTTON =
  'inline-flex h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors';
const PRIMARY = `${BUTTON} bg-primary text-primary-foreground hover:bg-primary-hover`;
const SECONDARY = `${BUTTON} border border-border bg-card hover:bg-muted`;

const TONE = {
  action: { box: 'border-primary/25 bg-accent/40', icon: 'bg-primary text-primary-foreground' },
  waiting: { box: 'border-warning/30 bg-warning/5', icon: 'bg-warning/15 text-warning' },
  done: { box: 'border-success/30 bg-card', icon: 'bg-success/15 text-success' },
  closed: { box: 'border-border bg-card', icon: 'bg-muted text-muted-foreground' },
} as const;

export async function MinimalJobCard({
  user,
  workspace,
}: {
  user: AuthenticatedUser;
  workspace: JobWorkspace;
}) {
  const { jobCard, status, estimate, estimateExpired } = workspace;
  const branch = { branchId: jobCard.branchId };
  const canEdit = hasPermission(user, 'job_card.edit', branch);
  const canSeeInvoice = hasPermission(user, 'invoice.view', branch);
  const canInvoice = hasPermission(user, 'invoice.create', branch);
  const canPay = hasPermission(user, 'payment.create', branch);
  const canDeliver = hasPermission(user, 'job_card.close', branch);
  const isFinished = status === 'DELIVERED' || status === 'CANCELLED';

  const [invoice, documents, photos] = await Promise.all([
    canSeeInvoice ? getJobInvoice(user, jobCard.id) : Promise.resolve(null),
    getJobDocuments(user, jobCard.id),
    listJobPhotos(user, jobCard.id),
  ]);
  const hasDocuments = documents.quotations.length > 0 || documents.invoice !== null;
  const canCancel =
    canEdit && !invoice && getSecondaryNextStatuses(jobCard.status).includes('CANCELLED');
  const approved = estimate?.status === 'APPROVED' || estimate?.status === 'PARTIALLY_APPROVED';
  const invoiceHref =
    approved && estimate
      ? `/finance/invoices/new?quotation=${estimate.id}`
      : `/finance/invoices/new?workOrder=${jobCard.id}`;

  // The one thing to do now.
  let step: {
    tone: keyof typeof TONE;
    icon: LucideIcon;
    title: string;
    description: string;
    body?: React.ReactNode;
  };
  if (status === 'CANCELLED') {
    step = {
      tone: 'closed',
      icon: XCircle,
      title: 'Cancelled',
      description: 'This job card was cancelled. Nothing was billed on it.',
    };
  } else if (status === 'DELIVERED') {
    step = {
      tone: 'done',
      icon: CheckCircle2,
      title: 'Done — vehicle handed back',
      description: `Delivered ${jobCard.deliveredAt ? formatDateTime(jobCard.deliveredAt) : ''}${
        jobCard.deliveredBy ? ` by ${jobCard.deliveredBy.fullName}` : ''
      }.`,
      body: jobCard.deliveryNotes ? (
        <p className="text-sm whitespace-pre-wrap">{jobCard.deliveryNotes}</p>
      ) : undefined,
    };
  } else if (invoice && invoice.paymentState !== 'PAID') {
    step = {
      tone: 'action',
      icon: Wallet,
      title: 'Take the payment',
      description: `${formatMoney(invoice.balanceDue)} to pay on ${invoice.invoiceNumber} (total ${formatMoney(invoice.totalAmount)}).`,
      body: canPay ? (
        <InvoicePaymentForm
          key={invoice.balanceDue}
          invoiceId={invoice.id}
          balance={invoice.balanceDue}
          now={toLocalDateTimeInput(new Date())}
        />
      ) : undefined,
    };
  } else if (invoice) {
    step = {
      tone: 'action',
      icon: KeyRound,
      title: 'Hand the vehicle back',
      description: `Paid in full — ${formatMoney(invoice.totalAmount)}. Record the handover to close the job card.`,
      body: canDeliver ? (
        <DeliveryForm jobCardId={jobCard.id} customerName={jobCard.customer.name} />
      ) : undefined,
    };
  } else if (status === 'REJECTED') {
    step = {
      tone: 'waiting',
      icon: TriangleAlert,
      title: 'Quotation turned down',
      description:
        'The customer did not accept the quotation. Revise it and send it again, or cancel the job card.',
      body: estimate ? (
        <Link href={`/quotations/${estimate.id}`} className={PRIMARY}>
          Open quotation
          <ArrowRight className="size-4" />
        </Link>
      ) : undefined,
    };
  } else if (!canSeeInvoice) {
    step = {
      tone: 'waiting',
      icon: Clock,
      title: 'Work in progress',
      description: 'The vehicle is in the workshop.',
    };
  } else {
    const waiting = status === 'WAITING_APPROVAL';
    step = {
      tone: waiting ? 'waiting' : 'action',
      icon: waiting ? Clock : Receipt,
      title: waiting
        ? 'Waiting for the customer'
        : approved
          ? 'Quotation approved — do the work, then invoice'
          : 'Do the work, then invoice',
      description: waiting
        ? 'The quotation has been sent. If the customer agreed in person, go ahead and invoice.'
        : 'When the job is done, create the invoice with the labour and parts used. A quotation first is optional.',
      body: (
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {canInvoice ? (
            <Link href={invoiceHref} className={waiting ? SECONDARY : PRIMARY}>
              <Receipt className="size-4" />
              {approved ? 'Invoice the quotation' : 'Create invoice'}
            </Link>
          ) : null}
          {estimate ? (
            <Link href={`/quotations/${estimate.id}`} className={waiting ? PRIMARY : SECONDARY}>
              <FileText className="size-4" />
              Open quotation
            </Link>
          ) : canEdit && QUOTABLE.includes(status) ? (
            <div className="sm:w-48">
              <CreateEstimateButton jobCardId={jobCard.id} compact />
            </div>
          ) : null}
        </div>
      ),
    };
  }
  const tone = TONE[step.tone];
  const StepIcon = step.icon;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <JobHero jobCard={jobCard} technician={null} showTechnician={false} />

      <section
        id="next-step"
        aria-label="Next step"
        className={cn(
          'flex scroll-mt-24 flex-col gap-5 rounded-xl border px-4 py-5 sm:px-6',
          tone.box,
        )}
      >
        <div className="flex items-start gap-4">
          <span
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-full',
              tone.icon,
            )}
          >
            <StepIcon className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-lg font-semibold tracking-tight">{step.title}</p>
            <p className="text-sm text-muted-foreground">{step.description}</p>
          </div>
        </div>
        {step.body ? <div className="sm:pl-14">{step.body}</div> : null}
        {canCancel ? (
          <div className="border-t border-border pt-3 sm:pl-14">
            <CancelJobButton jobCardId={jobCard.id} />
          </div>
        ) : null}
      </section>

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Stack gap="2xl" className="xl:col-span-8">
          <Section title="The job">
            <Panel>
              <JobDetailsEditor
                jobCardId={jobCard.id}
                complaint={jobCard.customerComplaint}
                mileage={jobCard.odometerReading}
                canEdit={canEdit && !isFinished}
              >
                <dl className="flex flex-col gap-4 text-sm">
                  <DetailRow label="What the customer asked for">
                    <span className="whitespace-pre-wrap">{jobCard.customerComplaint ?? '—'}</span>
                  </DetailRow>
                  <DetailRow label="Taken in">
                    {formatDateTime(jobCard.openedAt)} by {jobCard.createdBy.fullName}
                    {jobCard.odometerReading !== null
                      ? ` · ${formatKm(jobCard.odometerReading)}`
                      : ''}
                  </DetailRow>
                </dl>
              </JobDetailsEditor>
            </Panel>
          </Section>

          {estimate || invoice ? (
            <Section title="Paperwork">
              <Panel padding="none">
                <ul className="divide-y divide-border text-sm">
                  {estimate ? (
                    <PaperworkRow
                      href={`/quotations/${estimate.id}`}
                      icon={FileText}
                      label={`Quotation ${estimate.estimateNumber}`}
                      amount={formatMoney(estimate.totalAmount)}
                      pill={
                        <EstimateStatusPill status={estimate.status} expired={estimateExpired} />
                      }
                    />
                  ) : null}
                  {invoice ? (
                    <PaperworkRow
                      href={`/finance/invoices/${invoice.id}`}
                      icon={Receipt}
                      label={`Invoice ${invoice.invoiceNumber}`}
                      amount={formatMoney(invoice.totalAmount)}
                      pill={
                        documents.invoice ? (
                          <StatusPill tone={documents.invoice.status.tone}>
                            {documents.invoice.status.label}
                          </StatusPill>
                        ) : null
                      }
                    />
                  ) : null}
                </ul>
              </Panel>
            </Section>
          ) : null}

          <section id="photos" className="flex scroll-mt-24 flex-col gap-4">
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold tracking-tight">Photos</h2>
              <p className="text-sm text-muted-foreground">
                The vehicle as it came in and as it left.
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
        </Stack>

        <Stack gap="xl" className="xl:col-span-4">
          {hasDocuments ? (
            <Section title="Send to customer" description="Share documents on WhatsApp.">
              <CustomerCommunication documents={documents} canShareQuotation={canEdit} />
            </Section>
          ) : null}

          <details className="group rounded-xl border border-border bg-card">
            <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium sm:px-6">
              History
              <ArrowRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
            </summary>
            <div className="border-t border-border px-4 py-4 sm:px-6">
              <StatusTimeline entries={jobCard.statusHistory} />
            </div>
          </details>
        </Stack>
      </Grid>

      {!isFinished ? (
        <JobQuickActions
          jobCardId={jobCard.id}
          status={status}
          canEdit={canEdit}
          canIssueParts={false}
          canPay={canPay}
          minimal
        />
      ) : null}
    </Stack>
  );
}

function PaperworkRow({
  href,
  icon: Icon,
  label,
  amount,
  pill,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  amount: string;
  pill: React.ReactNode;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-muted/60 sm:px-6"
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="font-medium">{label}</span>
          {pill}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-semibold tabular-nums">
          {amount}
          <ArrowRight className="size-4 text-muted-foreground" />
        </span>
      </Link>
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
