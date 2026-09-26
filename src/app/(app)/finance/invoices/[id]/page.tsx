import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Ban, Car, ClipboardList, Info, Pencil, User } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getInvoiceDetail } from '@/lib/billing/invoice';
import { invoiceEditBlocker, invoiceVoidBlocker } from '@/lib/billing/invoice-changes';
import {
  formatCalendarDate,
  formatDateTime,
  formatMoney,
  toLocalDateTimeInput,
} from '@/lib/format';
import { PAYMENT_METHOD_LABEL } from '@/lib/documents/build';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { StatusPill } from '@/components/shared/status-pill';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { DocumentLinesView } from '@/components/workshop/estimate-lines';
import { StaffDocumentActions } from '@/components/documents/document-actions';
import { InvoicePaymentForm } from '@/components/finance/invoice-payment-form';
import { ReversePaymentButton, VoidInvoiceButton } from '@/components/finance/invoice-corrections';

/*
 * One invoice: what was billed, what has been paid, and the receipt for each
 * payment. The job card, when there is one, is a link beside the customer
 * rather than the thing the page is about.
 */

const STATE_TONE = {
  UNPAID: 'warning',
  PARTIALLY_PAID: 'warning',
  PAID: 'success',
} as const;

const STATE_LABEL = {
  UNPAID: 'Unpaid',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid',
} as const;

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  let invoice;
  try {
    invoice = await getInvoiceDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const { customer, vehicle, jobCard } = invoice;
  const branch = { branchId: invoice.branchId };
  const isVoid = invoice.status === 'VOID';
  const canPay = !isVoid && hasPermission(user, 'payment.create', branch);
  const editBlocker = invoiceEditBlocker(invoice);
  const canEditInvoice = hasPermission(user, 'invoice.create', branch) && !editBlocker;
  const canVoid = hasPermission(user, 'invoice.cancel', branch) && !invoiceVoidBlocker(invoice);
  const canReverse = !isVoid && hasPermission(user, 'payment.reverse', branch);
  // A reversed payment, and the payment it reversed, are not receipts.
  const reversals = new Map(
    invoice.payments
      .filter((payment) => payment.reversalOfPaymentId)
      .map((payment) => [payment.reversalOfPaymentId!, payment]),
  );
  const receipts = invoice.payments.filter(
    (payment) =>
      payment.status === 'COMPLETED' && !payment.reversalOfPaymentId && !reversals.has(payment.id),
  );
  const reversedPayments = invoice.payments.filter((payment) => reversals.has(payment.id));

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            Invoice
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
            {invoice.invoiceNumber}
            {isVoid ? (
              <StatusPill tone="danger">Void</StatusPill>
            ) : (
              <StatusPill tone={STATE_TONE[invoice.paymentState]}>
                {STATE_LABEL[invoice.paymentState]}
              </StatusPill>
            )}
          </span>
        }
        description={`For ${customer.name} · issued ${formatCalendarDate(invoice.issueDate)}`}
        leading={vehicle ? <VehiclePlate plateNumber={vehicle.plateNumber} /> : undefined}
        actions={
          isVoid ? undefined : (
            <span className="flex flex-wrap items-center gap-2">
              {canEditInvoice ? (
                <Link
                  href={`/finance/invoices/${invoice.id}/edit`}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted"
                >
                  <Pencil className="size-4" />
                  Edit
                </Link>
              ) : null}
              {canVoid ? (
                <VoidInvoiceButton
                  invoiceId={invoice.id}
                  invoiceNumber={invoice.invoiceNumber}
                  hasWorkOrder={Boolean(jobCard)}
                />
              ) : null}
              <StaffDocumentActions
                pdfUrl={`/documents/invoice/${invoice.id}`}
                target={{ kind: 'invoice', id: invoice.id }}
                canShare={Boolean(vehicle)}
              />
            </span>
          )
        }
      />

      {isVoid ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-sm sm:px-6"
        >
          <Ban className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <p className="font-semibold">
              Voided{invoice.voidedAt ? ` ${formatDateTime(invoice.voidedAt)}` : ''}
            </p>
            {invoice.voidReason ? (
              <p className="whitespace-pre-wrap text-muted-foreground">{invoice.voidReason}</p>
            ) : null}
            <p className="text-muted-foreground">
              Kept on record only. It is not owed and is not counted in any total.
            </p>
          </div>
        </div>
      ) : null}

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Stack gap="xl" className="xl:col-span-8">
          <Section title="What was billed">
            <DocumentLinesView
              lines={invoice.items}
              totals={[
                { label: 'Total excl. VAT', amount: invoice.subtotal },
                { label: 'VAT', amount: invoice.taxAmount },
                { label: 'Total', amount: invoice.totalAmount, strong: true },
                { label: 'Paid', amount: invoice.paidAmount },
                { label: 'Balance due', amount: invoice.balanceDue, strong: true },
              ]}
            />
          </Section>

          <Section
            title="Payments"
            description="Money received against this invoice, with a receipt for each."
          >
            <Panel padding="none">
              {receipts.length > 0 ? (
                <ul className="divide-y divide-border">
                  {receipts.map((payment) => (
                    <li
                      key={payment.id}
                      className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm font-medium">
                          {formatMoney(payment.amount)} · {PAYMENT_METHOD_LABEL[payment.method]}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {payment.paymentNumber ? `${payment.paymentNumber} · ` : ''}
                          {formatDateTime(payment.receivedAt)}
                          {payment.receivedBy ? ` · ${payment.receivedBy.fullName}` : ''}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        {canReverse ? (
                          <ReversePaymentButton
                            invoiceId={invoice.id}
                            paymentId={payment.id}
                            label={`${formatMoney(payment.amount)} ${PAYMENT_METHOD_LABEL[payment.method].toLowerCase()}`}
                          />
                        ) : null}
                        <StaffDocumentActions
                          pdfUrl={`/documents/receipt/${payment.id}`}
                          target={{ kind: 'receipt', id: payment.id }}
                          canShare={Boolean(vehicle)}
                        />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">No payments yet.</p>
              )}
              {reversedPayments.length > 0 ? (
                <ul className="divide-y divide-border border-t border-border bg-muted/20">
                  {reversedPayments.map((payment) => {
                    const reversal = reversals.get(payment.id)!;
                    return (
                      <li key={payment.id} className="flex flex-col gap-0.5 px-4 py-3 sm:px-6">
                        <span className="text-sm text-muted-foreground line-through">
                          {formatMoney(payment.amount)} · {PAYMENT_METHOD_LABEL[payment.method]}
                          {payment.paymentNumber ? ` · ${payment.paymentNumber}` : ''}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Reversed {formatDateTime(reversal.receivedAt)}
                          {reversal.receivedBy ? ` by ${reversal.receivedBy.fullName}` : ''}
                          {reversal.notes ? ` — ${reversal.notes}` : ''}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              {invoice.paymentState !== 'PAID' && canPay ? (
                <div className="border-t border-border bg-muted/20 px-4 py-6 sm:px-6">
                  <InvoicePaymentForm
                    key={invoice.balanceDue}
                    invoiceId={invoice.id}
                    balance={invoice.balanceDue}
                    now={toLocalDateTimeInput(new Date())}
                  />
                </div>
              ) : null}
            </Panel>
          </Section>
        </Stack>

        <Stack gap="xl" className="xl:col-span-4">
          <Section title="This invoice is for">
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
                      No vehicle on this invoice, so it can&apos;t be sent as a secure customer
                      link. The PDF prints and the invoice takes payment as normal.
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

          <Section title="Invoice details">
            <Panel>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Issued</dt>
                <dd className="text-right">
                  {invoice.issuedAt ? formatDateTime(invoice.issuedAt) : '—'}
                </dd>
                <dt className="text-muted-foreground">Issued by</dt>
                <dd className="text-right">{invoice.issuedBy?.fullName ?? '—'}</dd>
                <dt className="text-muted-foreground">Seller TRN</dt>
                <dd className="text-right">{invoice.sellerTaxNumber ?? '—'}</dd>
                <dt className="text-muted-foreground">Customer TRN</dt>
                <dd className="text-right">{invoice.customerTaxNumber ?? '—'}</dd>
              </dl>
              {invoice.notes ? (
                <p className="mt-4 border-t border-border pt-4 text-sm whitespace-pre-wrap">
                  {invoice.notes}
                </p>
              ) : null}
              {!isVoid && editBlocker && hasPermission(user, 'invoice.create', branch) ? (
                <p className="mt-4 flex items-start gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  {editBlocker}
                </p>
              ) : null}
            </Panel>
          </Section>
        </Stack>
      </Grid>
    </Stack>
  );
}
