import type { Metadata, Viewport } from 'next';
import { CheckCircle2, Clock, Link2Off, XCircle } from 'lucide-react';
import { getQuoteAccess, loadCustomerQuote } from '@/lib/customer-access/quote';
import { browserProof } from '@/lib/customer-access/verify-browser';
import { getQuotationDocumentForLink } from '@/lib/documents/build';
import { formatAed } from '@/lib/documents/model';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import { CUSTOMER_BAR_COLOR, CustomerNotice, CustomerShell } from '@/components/customer/customer-shell';
import { VerifyForm } from '@/components/customer/verify-form';
import {
  DocumentItems,
  DocumentStatus,
  DocumentTotals,
} from '@/components/documents/document-body';
import { CustomerDocumentActions } from '@/components/documents/share-menu';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { cn } from '@/lib/utils';
import { verifyQuoteAction } from './actions';
import { DecisionBar } from './quote-forms';

export const viewport: Viewport = { themeColor: CUSTOMER_BAR_COLOR };

export const metadata: Metadata = {
  title: 'Your quotation — Comet Autos',
  robots: { index: false, follow: false },
  // Keep the secret link out of Referer headers sent to other sites.
  referrer: 'no-referrer',
};

export default async function CustomerQuotePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const access = await getQuoteAccess(token, await browserProof(token, 'ESTIMATE'));

  if (access.state === 'invalid') {
    return (
      <CustomerShell label="Quotation">
        <CustomerNotice icon={Link2Off} title="This link is not valid">
          The quotation link may have been replaced by a newer one, or copied incompletely. Please
          contact the workshop for an up-to-date link.
        </CustomerNotice>
      </CustomerShell>
    );
  }
  if (access.state === 'expired') {
    return (
      <CustomerShell organization={access.organization} label="Quotation">
        <CustomerNotice icon={Clock} title="This quotation has expired">
          Quotation prices are only held for a limited time. Please contact us and we&apos;ll send
          you an updated quotation
          {access.organization.phone ? ` — call ${access.organization.phone}` : ''}.
        </CustomerNotice>
      </CustomerShell>
    );
  }
  if (access.state === 'needs_verification') {
    return (
      <CustomerShell organization={access.organization} label="Quotation">
        <VerifyForm action={verifyQuoteAction.bind(null, token)} documentName="quotation" />
      </CustomerShell>
    );
  }

  const [quote, document] = await Promise.all([
    loadCustomerQuote(token),
    getQuotationDocumentForLink(access.organizationId, access.resourceId),
  ]);
  if (!quote || !document) {
    return (
      <CustomerShell organization={access.organization} label="Quotation">
        <CustomerNotice icon={Link2Off} title="This link is not valid">
          Please contact the workshop for an up-to-date link.
        </CustomerNotice>
      </CustomerShell>
    );
  }

  // The quotation names its own customer and vehicle. The work order, when
  // there is one behind it, adds the job number, the mileage and what the
  // technician found.
  const { jobCard, customer, vehicle } = quote;
  const decision = quote.approvals[0];
  const inspection = jobCard?.inspections[0];
  const recommendation = jobCard?.diagnoses[0]?.recommendedAction;
  const awaiting = !decision && quote.status === 'SENT' && !quote.expired;
  const additional = quote.kind === 'ADDITIONAL';

  return (
    <CustomerShell organization={access.organization} label="Quotation">
      <div className={cn('flex flex-col gap-8', awaiting && 'pb-24 sm:pb-0')}>
        <header className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {document.title} · {document.number}
            </p>
            <DocumentStatus status={document.status} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Hello {customer.name},</h1>
          <p className="text-muted-foreground">
            {additional
              ? 'While repairing your vehicle we found more work that needs doing. It is not part of the work you already approved — please review it and let us know if we should go ahead.'
              : 'Here is the work we recommend for your vehicle. Please review it and let us know if we can go ahead.'}
          </p>
        </header>

        {decision ? (
          <div
            role="status"
            className={cn(
              'flex items-start gap-4 rounded-2xl px-5 py-5',
              decision.status === 'APPROVED' ? 'bg-success/10' : 'bg-danger/10',
            )}
          >
            {decision.status === 'APPROVED' ? (
              <CheckCircle2 className="size-6 shrink-0 text-success" />
            ) : (
              <XCircle className="size-6 shrink-0 text-danger" />
            )}
            <div className="flex flex-col gap-1">
              <p className="font-semibold">
                {decision.status === 'APPROVED'
                  ? 'Quotation approved successfully.'
                  : 'Quotation rejected.'}
              </p>
              <p className="text-sm text-muted-foreground">
                {formatDateTime(decision.decidedAt)}.{' '}
                {decision.status === 'APPROVED'
                  ? "Thank you — we'll get started and keep you updated."
                  : "We've let the workshop know. They may contact you with other options."}
              </p>
            </div>
          </div>
        ) : null}

        <section className="flex items-center justify-between gap-4 rounded-2xl bg-sidebar px-5 py-5 text-sidebar-foreground">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium tracking-wide text-sidebar-foreground/60 uppercase">
              Quotation total
            </span>
            <span className="text-3xl font-semibold tracking-tight tabular-nums">
              {formatAed(quote.totalAmount.toString())}
            </span>
            <span className="text-xs text-sidebar-foreground/60">
              Including VAT
              {quote.validUntil ? ` · valid until ${formatCalendarDate(quote.validUntil)}` : ''}
            </span>
          </div>
        </section>

        {vehicle ? (
          <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4">
            <VehiclePlate plateNumber={vehicle.plateNumber} />
            <div className="min-w-0">
              <p className="truncate font-medium">
                {vehicle.make} {vehicle.model} {vehicle.year ?? ''}
              </p>
              {jobCard ? (
                <p className="text-sm text-muted-foreground">
                  Job {jobCard.jobNumber}
                  {jobCard.odometerReading !== null
                    ? ` · ${jobCard.odometerReading.toLocaleString('en-AE')} km`
                    : ''}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {(additional ? quote.notes : jobCard?.customerComplaint) ? (
          <Block title={additional ? 'What we found during the repair' : 'Work requested'}>
            <p className="whitespace-pre-wrap">
              {additional ? quote.notes : jobCard?.customerComplaint}
            </p>
          </Block>
        ) : null}

        {!additional && inspection && inspection.items.length > 0 ? (
          <Block title="What our technician found">
            <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-card">
              {inspection.items.map((item, index) => (
                <li key={index} className="flex items-start gap-3 px-4 py-3">
                  <span
                    className={cn(
                      'mt-0.5 inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-xs font-medium',
                      item.result === 'FAILED'
                        ? 'bg-danger/10 text-danger'
                        : 'bg-warning/10 text-warning',
                    )}
                  >
                    {item.result === 'FAILED' ? 'Needs repair' : 'Attention'}
                  </span>
                  <span className="min-w-0 text-sm">
                    <span className="font-medium">{item.description}</span>
                    {item.notes ? (
                      <span className="block text-muted-foreground">{item.notes}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        ) : null}

        {!additional && recommendation ? (
          <Block title="Our recommendation">
            <p className="whitespace-pre-wrap">{recommendation}</p>
          </Block>
        ) : null}

        <Block title="Your quotation">
          <div className="flex flex-col gap-4">
            <DocumentItems document={document} />
            <DocumentTotals document={document} />
          </div>
        </Block>

        <CustomerDocumentActions
          pdfUrl={`/customer/quote/${token}/pdf`}
          shareText={`${document.title} ${document.number}`}
        />

        {awaiting ? (
          <section className="flex flex-col gap-3 sm:border-t sm:border-border sm:pt-8">
            <h2 className="hidden text-lg font-semibold tracking-tight sm:block">
              Can we go ahead?
            </h2>
            <DecisionBar
              token={token}
              total={formatAed(quote.totalAmount.toString())}
              quotationNumber={quote.estimateNumber}
            />
          </section>
        ) : !decision ? (
          <CustomerNotice icon={Clock} title="This quotation can no longer be answered online">
            Please contact the workshop
            {access.organization.phone ? ` on ${access.organization.phone}` : ''}.
          </CustomerNotice>
        ) : null}
      </div>
    </CustomerShell>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <div className="text-sm leading-relaxed">{children}</div>
    </section>
  );
}
