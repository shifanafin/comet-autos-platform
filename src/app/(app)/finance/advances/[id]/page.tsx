import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Ban, Download, Info, MessageCircle, Printer } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import {
  ADVANCE_STATUS_LABEL,
  ADVANCE_VAT_LABEL,
  getCustomerAdvance,
} from '@/lib/billing/advances';
import { getAccountChoices } from '@/lib/accounting/reports';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { PAYMENT_METHOD_LABEL } from '@/lib/documents/build';
import { formatCalendarDate, formatDateTime, formatMoney, localDateString } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { StatusPill } from '@/components/shared/status-pill';
import { whatsAppUrl } from '@/lib/sharing/whatsapp';
import {
  ApplyAdvanceForm,
  CancelAdvanceButton,
  RefundAdvanceForm,
  ReverseRefundButton,
  UndoApplicationButton,
} from '@/components/finance/advance-forms';

const STATUS_TONE = {
  OPEN: 'warning',
  PARTIALLY_APPLIED: 'warning',
  FULLY_APPLIED: 'success',
  REFUNDED: 'neutral',
  CANCELLED: 'danger',
} as const;

/** One customer advance: what was received, where it went, and what is left. */
export default async function CustomerAdvancePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let advance;
  try {
    advance = await getCustomerAdvance(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthError) return <AccessDenied what="customer advances" />;
    throw error;
  }
  const isCancelled = advance.status === 'CANCELLED';
  const today = localDateString();
  // The receipt the customer is given — a tax invoice for the advance when it carries VAT.
  const receiptPdf = `/documents/advance/${advance.id}`;
  const vatFils =
    advance.vatTreatment === 'VAT_ON_RECEIPT' ? toFils(advance.vatAmount.toString()) : 0;
  const whatsApp = whatsAppUrl(
    advance.customer.phone,
    [
      `Hello ${advance.customer.name} 👋`,
      '',
      `We have received your advance of *${formatMoney(advance.amount.toString())}*${vatFils > 0 ? ` (including VAT ${formatMoney(filsToString(vatFils))})` : ''}.`,
      `• Receipt: ${advance.advanceNumber} · ${formatCalendarDate(advance.receivedOn)}`,
      ...(advance.jobCard
        ? [
            `• For job: ${advance.jobCard.jobNumber}${advance.vehicle ? ` · ${advance.vehicle.plateNumber}` : ''}`,
          ]
        : []),
      '',
      'It will be applied to your invoice when the work is billed. Your receipt is attached.',
      'Thank you!',
    ].join('\n'),
  );
  const [accounts, modes] = advance.can.refund
    ? await Promise.all([
        getAccountChoices(user),
        getPaymentModeOptions(user.organizationId, 'spending'),
      ])
    : [null, []];

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          // An advance belongs to its job (or its customer): back to where it was taken.
          advance.jobCard ? (
            <Link href={`/job-cards/${advance.jobCard.id}`} className="text-primary hover:underline">
              {`Advance · job ${advance.jobCard.jobNumber}`}
            </Link>
          ) : (
            <Link href={`/customers/${advance.customer.id}`} className="text-primary hover:underline">
              {`Advance · ${advance.customer.name}`}
            </Link>
          )
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {advance.advanceNumber}
            <StatusPill tone={STATUS_TONE[advance.status]}>
              {ADVANCE_STATUS_LABEL[advance.status]}
            </StatusPill>
          </span>
        }
        description={[
          `From ${advance.customer.name}`,
          `received ${formatCalendarDate(advance.receivedOn)}`,
          PAYMENT_METHOD_LABEL[advance.method].toLowerCase(),
          advance.notes,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <a
              href={receiptPdf}
              target="_blank"
              rel="noopener"
              className="inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              <Printer className="size-4" />
              Print receipt
            </a>
            <a
              href={`${receiptPdf}?download=1`}
              className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-muted"
            >
              <Download className="size-4" />
              Download
            </a>
            {!isCancelled ? (
              <a
                href={whatsApp}
                target="_blank"
                rel="noopener"
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-muted"
              >
                <MessageCircle className="size-4" />
                WhatsApp
              </a>
            ) : null}
            {advance.can.cancel && !advance.cancelBlocker ? (
              <CancelAdvanceButton advanceId={advance.id} label={advance.advanceNumber} />
            ) : null}
          </span>
        }
      />

      {isCancelled ? (
        <div
          role="status"
          className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-sm sm:px-6"
        >
          <Ban className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="flex flex-col gap-1">
            <p className="font-semibold">
              Cancelled{advance.cancelledAt ? ` ${formatDateTime(advance.cancelledAt)}` : ''}
              {advance.cancelledBy ? ` by ${advance.cancelledBy.fullName}` : ''}
            </p>
            {advance.cancelReason ? (
              <p className="whitespace-pre-wrap text-muted-foreground">{advance.cancelReason}</p>
            ) : null}
            <p className="text-muted-foreground">Kept on record only; its entry is reversed.</p>
          </div>
        </div>
      ) : null}

      <Panel className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: 'Received', value: advance.figures.amount },
          { label: 'Applied to invoices', value: advance.figures.applied },
          { label: 'Refunded', value: advance.figures.refunded },
          { label: 'Left for the customer', value: advance.figures.left, strong: true },
        ].map((item) => (
          <div key={item.label} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
            <span
              className={
                item.strong
                  ? 'text-2xl leading-none font-semibold tabular-nums'
                  : 'text-lg leading-none font-medium tabular-nums'
              }
            >
              {formatMoney(item.value)}
            </span>
          </div>
        ))}
      </Panel>

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Stack gap="xl" className="xl:col-span-8">
          {advance.can.apply ? (
            <Section
              title="Apply to an invoice"
              description="Settles the invoice by that much, like a payment. The invoice's sales and VAT stay exactly as issued."
            >
              <Panel>
                {advance.openInvoices.length ? (
                  <ApplyAdvanceForm
                    side="advance"
                    fixedId={advance.id}
                    fixedMax={advance.figures.left}
                    choices={advance.openInvoices.map((invoice) => ({
                      id: invoice.id,
                      label: `${invoice.invoiceNumber} · ${formatMoney(invoice.due)} due`,
                      hint: `Issued ${formatCalendarDate(invoice.issueDate)}${invoice.sameJob ? ' · this advance’s job card' : ''}`,
                      max: invoice.due,
                    }))}
                    defaultChoiceId={advance.openInvoices.find((invoice) => invoice.sameJob)?.id}
                    today={today}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {advance.customer.name} has no invoice with anything due. Apply the advance once
                    the job is invoiced — from here or from the invoice.
                  </p>
                )}
              </Panel>
            </Section>
          ) : null}

          <Section
            title="Applied to invoices"
            description="Where this advance went. A line below zero is money a credit note gave back to the advance."
          >
            <Panel padding="none">
              {advance.allocations.length ? (
                <ul className="divide-y divide-border">
                  {advance.allocations.map((row) => {
                    const fils = row.amount.toString().startsWith('-')
                      ? -toFils(row.amount.toString().slice(1))
                      : toFils(row.amount.toString());
                    return (
                      <li
                        key={row.id}
                        className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span
                            className={
                              row.reversedAt
                                ? 'text-sm text-muted-foreground line-through'
                                : 'text-sm font-medium'
                            }
                          >
                            {fils < 0 ? 'Returned from ' : 'Applied to '}
                            <Link
                              href={`/finance/invoices/${row.invoice.id}`}
                              className="hover:underline"
                            >
                              {row.invoice.invoiceNumber}
                            </Link>
                            {` · ${formatMoney(filsToString(Math.abs(fils)))}`}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatCalendarDate(row.allocatedOn)}
                            {row.creditNote ? (
                              <>
                                {' · by credit note '}
                                <Link
                                  href={`/finance/credit-notes/${row.creditNote.id}`}
                                  className="hover:underline"
                                >
                                  {row.creditNote.creditNoteNumber}
                                </Link>
                              </>
                            ) : null}
                            {` · ${row.createdBy.fullName}`}
                          </span>
                          {row.reversedAt ? (
                            <span className="text-xs text-muted-foreground">
                              {`Undone ${formatDateTime(row.reversedAt)}${row.reversedBy ? ` by ${row.reversedBy.fullName}` : ''}${row.reversalReason ? ` — ${row.reversalReason}` : ''}`}
                            </span>
                          ) : null}
                        </span>
                        {advance.can.undo && !row.reversedAt && !row.creditNote ? (
                          <UndoApplicationButton
                            allocationId={row.id}
                            label={`${formatMoney(row.amount.toString())} on ${row.invoice.invoiceNumber}`}
                          />
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">
                  Not applied to any invoice yet.
                </p>
              )}
            </Panel>
          </Section>

          <Section title="Refunds" description="Money from this advance paid back to the customer.">
            <Panel padding="none">
              {advance.refunds.length ? (
                <ul className="divide-y divide-border">
                  {advance.refunds.map((refund) => (
                    <li
                      key={refund.id}
                      className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6"
                    >
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span
                          className={
                            refund.reversedAt
                              ? 'text-sm text-muted-foreground line-through'
                              : 'text-sm font-medium'
                          }
                        >
                          {`${formatMoney(refund.amount.toString())} · ${PAYMENT_METHOD_LABEL[refund.method]}`}
                          {refund.account ? ` from ${refund.account.accountName}` : ''}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {`${formatCalendarDate(refund.refundedOn)}${refund.reference ? ` · ref ${refund.reference}` : ''} · ${refund.createdBy.fullName}`}
                        </span>
                        {refund.reversedAt ? (
                          <span className="text-xs text-muted-foreground">
                            {`Reversed ${formatDateTime(refund.reversedAt)}${refund.reversedBy ? ` by ${refund.reversedBy.fullName}` : ''}${refund.reversalReason ? ` — ${refund.reversalReason}` : ''}`}
                          </span>
                        ) : null}
                      </span>
                      {advance.can.reverseRefund && !refund.reversedAt ? (
                        <ReverseRefundButton
                          refundId={refund.id}
                          label={formatMoney(refund.amount.toString())}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">Nothing refunded.</p>
              )}
              {advance.can.refund && accounts ? (
                <div className="border-t border-border bg-muted/20 px-4 py-6 sm:px-6">
                  <RefundAdvanceForm
                    key={advance.figures.left}
                    advanceId={advance.id}
                    left={advance.figures.left}
                    modes={modes}
                    moneyAccounts={accounts.money}
                    today={today}
                  />
                </div>
              ) : null}
            </Panel>
          </Section>
        </Stack>

        <Stack gap="xl" className="xl:col-span-4">
          <Section title="Details">
            <Panel>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Customer</dt>
                <dd className="text-right">
                  <Link href={`/customers/${advance.customer.id}`} className="hover:underline">
                    {advance.customer.name}
                  </Link>
                </dd>
                <dt className="text-muted-foreground">Vehicle</dt>
                <dd className="text-right">
                  {advance.vehicle ? (
                    <Link href={`/vehicles/${advance.vehicle.id}`} className="hover:underline">
                      {`${advance.vehicle.plateNumber} · ${advance.vehicle.make} ${advance.vehicle.model}`}
                    </Link>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt className="text-muted-foreground">Job card</dt>
                <dd className="text-right">
                  {advance.jobCard ? (
                    <Link href={`/job-cards/${advance.jobCard.id}`} className="hover:underline">
                      {advance.jobCard.jobNumber}
                    </Link>
                  ) : (
                    '—'
                  )}
                </dd>
                <dt className="text-muted-foreground">Received into</dt>
                <dd className="text-right">
                  {advance.account
                    ? `${advance.account.accountCode} ${advance.account.accountName}`
                    : `${PAYMENT_METHOD_LABEL[advance.method]} (default account)`}
                </dd>
                <dt className="text-muted-foreground">Reference</dt>
                <dd className="text-right">{advance.reference ?? '—'}</dd>
                <dt className="text-muted-foreground">Recorded by</dt>
                <dd className="text-right">
                  {`${advance.receivedBy.fullName}, ${formatDateTime(advance.createdAt)}`}
                </dd>
              </dl>
              <p className="mt-4 flex items-start gap-2 border-t border-border pt-4 text-xs text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                {ADVANCE_VAT_LABEL[advance.vatTreatment]}
              </p>
              {!isCancelled && advance.cancelBlocker && advance.can.cancel ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  {`To cancel it: ${advance.cancelBlocker}`}
                </p>
              ) : null}
            </Panel>
          </Section>
        </Stack>
      </Grid>
    </Stack>
  );
}
