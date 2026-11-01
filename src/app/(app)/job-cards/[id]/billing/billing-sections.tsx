import { CheckCircle2, Info, KeyRound, TriangleAlert } from 'lucide-react';
import type { PaymentModeOption } from '@/lib/accounting/payment-modes';
import type { PaymentMethod } from '@/generated/prisma/enums';
import type { WorkflowStatus } from '@/lib/workshop/stages';
import type { JobWorkspace } from '@/lib/workshop/workspace';
import type { BillableLine, BillingNote, JobInvoice } from '@/lib/billing/invoice';
import type { DocumentTotals } from '@/lib/money';
import type { AccountChoice } from '@/lib/accounting/reports';
import { toFils } from '@/lib/money';
import { billDiscountTotals } from '@/components/workshop/estimate-lines';
import { StagePhotosPanel } from '@/components/media/stage-photos-panel';
import {
  formatCalendarDate,
  formatDateTime,
  formatMoney,
  toLocalDateTimeInput,
} from '@/lib/format';
import { Panel, Stack } from '@/components/layout/primitives';
import { StatusPill } from '@/components/shared/status-pill';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { trimQuantity } from '@/components/workshop/estimate-lines';
import { cn } from '@/lib/utils';
import { CreateInvoiceButton, DeliveryForm } from './billing-forms';
import { InvoicePaymentForm } from '@/components/finance/invoice-payment-form';

const PAYMENT_STATE = {
  UNPAID: { tone: 'danger', label: 'Unpaid' },
  PARTIALLY_PAID: { tone: 'warning', label: 'Partially paid' },
  PAID: { tone: 'success', label: 'Paid' },
} as const;

const METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  ONLINE: 'Online',
};

function SectionHeading({
  id,
  title,
  description,
}: {
  id: string;
  title: string;
  description: string;
}) {
  return (
    <div id={id} className="flex scroll-mt-24 flex-col gap-1">
      <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function Notes({ notes }: { notes: BillingNote[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-warning">
        <TriangleAlert className="size-4" />
        Approved work vs. what was done
      </p>
      <ul className="flex list-disc flex-col gap-1 pl-5 text-foreground/80">
        {notes.map((note, index) => (
          <li key={index}>{note.message}</li>
        ))}
      </ul>
    </div>
  );
}

type Row = {
  key: string;
  group: 'Labour' | 'Parts' | 'Other charges' | 'Additional approved work';
  description: string;
  quantity: string;
  unitPrice: string;
  taxRate: string;
  /** The AED the line's discount took off ("0.00" for none). */
  discountAmount: string;
  lineTotal: string;
};

const discounted = (row: Row) => toFils(row.discountAmount) > 0;

function LineGroups({ rows }: { rows: Row[] }) {
  const groups = (['Labour', 'Parts', 'Other charges', 'Additional approved work'] as const)
    .map((title) => ({ title, rows: rows.filter((r) => r.group === title) }))
    .filter((g) => g.rows.length > 0);
  return (
    <div className="rounded-lg border border-border">
      {/* Phone: each group as its own list of cards, so no invoice line is hidden off-screen. */}
      <div className="md:hidden">
        {groups.map((group) => (
          <div key={group.title} className="border-b border-border last:border-b-0">
            <p className="bg-muted/40 px-4 py-3 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {group.title}
            </p>
            <RecordList>
              {group.rows.map((row) => (
                <RecordCard
                  key={row.key}
                  title={row.description}
                  amount={formatMoney(row.lineTotal)}
                  details={[
                    { label: 'Quantity', value: trimQuantity(row.quantity) },
                    { label: 'Price', value: formatMoney(row.unitPrice) },
                    { label: 'VAT', value: `${trimQuantity(row.taxRate)}%` },
                    ...(discounted(row)
                      ? [{ label: 'Discount', value: `−${formatMoney(row.discountAmount)}` }]
                      : []),
                  ]}
                />
              ))}
            </RecordList>
          </div>
        ))}
      </div>
      <TableWrap>
        <table className="w-full min-w-[600px] text-sm">
          {groups.map((group) => (
            <tbody key={group.title} className="border-b border-border last:border-b-0">
              <tr className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <th className="px-4 py-4">{group.title}</th>
                <th className="w-20 px-2 py-3 text-right">Qty</th>
                <th className="w-28 px-2 py-3 text-right">Price</th>
                <th className="w-16 px-2 py-3 text-right">VAT</th>
                <th className="w-28 px-4 py-3 text-right">Amount</th>
              </tr>
              {group.rows.map((row) => (
                <tr key={row.key} className="border-t border-border">
                  <td className="px-4 py-4">{row.description}</td>
                  <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                    {trimQuantity(row.quantity)}
                  </td>
                  <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                    {formatMoney(row.unitPrice)}
                  </td>
                  <td className="px-2 py-4 text-right text-muted-foreground tabular-nums whitespace-nowrap">
                    {trimQuantity(row.taxRate)}%
                  </td>
                  <td className="px-4 py-4 text-right font-semibold tabular-nums whitespace-nowrap">
                    {formatMoney(row.lineTotal)}
                    {discounted(row) ? (
                      <span className="block text-xs font-normal text-muted-foreground">
                        less {formatMoney(row.discountAmount)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </TableWrap>
    </div>
  );
}

function groupFor(itemType: string, kind: string | undefined): Row['group'] {
  if (kind === 'ADDITIONAL') return 'Additional approved work';
  if (itemType === 'OTHER') return 'Other charges';
  return itemType === 'LABOUR' ? 'Labour' : 'Parts';
}

/** Invoice, payments and delivery — shown from READY onwards. */
export function BillingSections({
  workspace,
  status,
  invoice,
  preview,
  canInvoice,
  canPay,
  canDeliver,
  moneyAccounts = [],
  modes = [],
}: {
  workspace: JobWorkspace;
  status: WorkflowStatus;
  invoice: JobInvoice | null;
  preview: {
    billable: BillableLine[];
    notes: BillingNote[];
    totals: DocumentTotals;
  } | null;
  canInvoice: boolean;
  canPay: boolean;
  canDeliver: boolean;
  /** Cash, bank and card accounts a payment can go into. */
  moneyAccounts?: AccountChoice[];
  /** The receipt modes (payment mode master). */
  modes?: PaymentModeOption[];
}) {
  const { jobCard } = workspace;
  const customer = jobCard.customer;
  const state = invoice ? PAYMENT_STATE[invoice.paymentState] : null;
  // A reversal cancels a payment without editing it. The row that cancels it
  // is not a payment; the one it cancelled is shown struck through.
  const reversalOf = new Map(
    (invoice?.payments ?? [])
      .filter((payment) => payment.reversalOfPaymentId)
      .map((payment) => [payment.reversalOfPaymentId!, payment]),
  );
  const received = (invoice?.payments ?? []).filter((payment) => !payment.reversalOfPaymentId);

  return (
    <Stack gap="2xl">
      {/* Invoice */}
      <section className="flex flex-col gap-4">
        <SectionHeading
          id="invoice"
          title="Invoice"
          description={
            invoice
              ? 'Only approved, completed work is billed, at the approved prices.'
              : 'Review what will be billed, then issue the invoice.'
          }
        />
        {!invoice && preview ? (
          <Panel className="flex flex-col gap-6">
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" />
              Billed from the parts and labour recorded against approved estimate lines, at the
              price and VAT the customer approved. Unapproved work is excluded.
            </p>
            <LineGroups
              rows={preview.billable.map((line, index) => ({
                key: String(index),
                group: groupFor(line.itemType, line.estimateKind),
                description: line.description,
                quantity: line.amounts.quantity,
                unitPrice: line.amounts.unitPrice,
                taxRate: line.amounts.taxRate,
                discountAmount: line.amounts.discountAmount,
                lineTotal: line.amounts.lineTotal,
              }))}
            />
            <Totals
              discounts={billDiscountTotals(preview.totals)}
              subtotal={preview.totals.subtotal}
              tax={preview.totals.taxAmount}
              total={preview.totals.totalAmount}
            />
            <Notes notes={preview.notes} />
            {status === 'READY' && canInvoice && preview.billable.length > 0 ? (
              <CreateInvoiceButton jobCardId={jobCard.id} total={preview.totals.totalAmount} />
            ) : null}
          </Panel>
        ) : null}

        {invoice && state ? (
          <Panel className="flex flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Tax invoice
                </p>
                <p className="text-xl font-semibold tracking-tight">{invoice.invoiceNumber}</p>
                <p className="text-sm text-muted-foreground">
                  Issued {formatCalendarDate(invoice.issueDate)}
                  {invoice.issuedBy ? ` by ${invoice.issuedBy.fullName}` : ''}
                </p>
              </div>
              <StatusPill tone={state.tone}>{state.label}</StatusPill>
            </div>
            <dl className="grid gap-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Customer</dt>
                <dd>{invoice.customerName ?? customer.name}</dd>
                {invoice.customerTaxNumber ? (
                  <dd className="text-muted-foreground">TRN {invoice.customerTaxNumber}</dd>
                ) : null}
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Vehicle</dt>
                <dd className="flex items-center gap-2">
                  <VehiclePlate
                    plateNumber={jobCard.vehicle.plateNumber}
                    className="px-2 py-0.5 text-xs"
                  />
                  {jobCard.vehicle.make} {jobCard.vehicle.model}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium text-muted-foreground">Job</dt>
                <dd>{jobCard.jobNumber}</dd>
              </div>
            </dl>
            <LineGroups
              rows={invoice.items.map((item) => ({
                key: item.id,
                group: groupFor(
                  item.itemType ?? (item.labourId ? 'LABOUR' : 'PART'),
                  (item.labour?.estimateItem ?? item.partUsage?.estimateItem)?.estimate.kind,
                ),
                description: item.description,
                quantity: item.quantity.toString(),
                unitPrice: item.unitPrice.toString(),
                taxRate: item.taxRate?.toString() ?? '0',
                discountAmount: item.discountAmount.toString(),
                lineTotal: item.lineTotal.toString(),
              }))}
            />
            <Totals
              discounts={billDiscountTotals(invoice)}
              subtotal={invoice.subtotal.toString()}
              tax={invoice.taxAmount.toString()}
              total={invoice.totalAmount.toString()}
              paid={invoice.paidAmount}
              advanceApplied={invoice.advanceApplied}
              balance={invoice.balanceDue}
            />
          </Panel>
        ) : null}
      </section>

      {/* Payments */}
      {invoice ? (
        <section className="flex flex-col gap-4">
          <SectionHeading
            id="payments"
            title="Payments"
            description={
              invoice.paymentState === 'PAID'
                ? 'Fully paid.'
                : `${formatMoney(invoice.balanceDue)} still due. Record each payment as it is received.`
            }
          />
          <Panel padding="none" className="overflow-hidden">
            {received.length > 0 ? (
              <ul className="divide-y divide-border">
                {received.map((payment) => (
                  <li
                    key={payment.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm sm:px-6"
                  >
                    <span className="flex flex-col gap-0.5">
                      <span className="font-medium">
                        {payment.paymentNumber} · {METHOD_LABEL[payment.method]}
                        {payment.referenceNumber ? (
                          <span className="font-normal text-muted-foreground">
                            {' '}
                            · ref {payment.referenceNumber}
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(payment.receivedAt)} · received by{' '}
                        {payment.receivedBy.fullName}
                        {payment.notes ? ` · ${payment.notes}` : ''}
                      </span>
                    </span>
                    <span
                      className={cn(
                        'tabular-nums',
                        reversalOf.has(payment.id)
                          ? 'text-muted-foreground line-through'
                          : 'font-semibold',
                      )}
                    >
                      {formatMoney(payment.amount)}
                    </span>
                    {reversalOf.has(payment.id) ? (
                      <span className="w-full text-xs text-muted-foreground">
                        <StatusPill tone="danger">Reversed</StatusPill>{' '}
                        {formatDateTime(reversalOf.get(payment.id)!.receivedAt)}
                        {reversalOf.get(payment.id)!.notes
                          ? ` — ${reversalOf.get(payment.id)!.notes}`
                          : ''}{' '}
                        · not counted
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">No payments yet.</p>
            )}
            {invoice.paymentState !== 'PAID' && canPay ? (
              <div className="border-t border-border bg-muted/20 px-4 py-6 sm:px-6">
                <InvoicePaymentForm
                  moneyAccounts={moneyAccounts}
                  modes={modes}
                  key={invoice.balanceDue}
                  invoiceId={invoice.id}
                  balance={invoice.balanceDue}
                  now={toLocalDateTimeInput(new Date())}
                />
              </div>
            ) : null}
          </Panel>
        </section>
      ) : null}

      {/* Delivery */}
      {invoice ? (
        <section className="flex flex-col gap-4">
          <SectionHeading
            id="delivery"
            title="Delivery"
            description="Hand the vehicle back once it is invoiced — paid in full, or on credit with the balance paid later."
          />
          <Panel
            className={cn('flex flex-col gap-6', status === 'DELIVERED' && 'border-success/30')}
          >
            <dl className="grid gap-4 text-sm sm:grid-cols-3 lg:grid-cols-6">
              {[
                ['Customer', customer.name],
                ['Vehicle', jobCard.vehicle.plateNumber],
                ['Job', jobCard.jobNumber],
                ['Invoice total', formatMoney(invoice.totalAmount)],
                ['Paid', formatMoney(invoice.paidAmount)],
                ['Balance', formatMoney(invoice.balanceDue)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
                  <dd className="font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
            {status === 'DELIVERED' ? (
              <div className="flex items-start gap-3 text-sm">
                <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
                <div>
                  <p className="font-semibold">
                    Delivered {jobCard.deliveredAt ? formatDateTime(jobCard.deliveredAt) : ''}
                  </p>
                  <p className="text-muted-foreground">
                    Handed over by {jobCard.deliveredBy?.fullName ?? '—'}
                  </p>
                  {jobCard.deliveryNotes ? (
                    <p className="mt-2 whitespace-pre-wrap">{jobCard.deliveryNotes}</p>
                  ) : null}
                </div>
              </div>
            ) : (status === 'PAID' || status === 'INVOICED') && canDeliver ? (
              <DeliveryForm
                jobCardId={jobCard.id}
                customerName={jobCard.customer.name}
                balanceDue={invoice.balanceDue}
              />
            ) : (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <KeyRound className="size-4" />
                Ready to deliver.
              </p>
            )}
          </Panel>

          {/* The vehicle as it left, photographed at handover. */}
          <StagePhotosPanel
            jobCardId={jobCard.id}
            branchId={jobCard.branchId}
            status={jobCard.status}
            stage="DELIVERY"
            hint="The condition it left in — the workshop's record if it is ever questioned."
          />
        </section>
      ) : null}
    </Stack>
  );
}

function Totals({
  discounts,
  subtotal,
  tax,
  total,
  paid,
  advanceApplied,
  balance,
}: {
  /** The lines' total and the bill discount, when there is one. */
  discounts: { label: string; amount: { toString(): string } }[];
  subtotal: string;
  tax: string;
  total: string;
  paid?: string;
  /** Settled from customer advances. */
  advanceApplied?: string;
  balance?: string;
}) {
  return (
    <dl className="ml-auto flex w-full flex-col gap-2 text-sm sm:w-80">
      {discounts.map((row) => (
        <div key={row.label} className="flex justify-between">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="tabular-nums">{formatMoney(row.amount)}</dd>
        </div>
      ))}
      <div className="flex justify-between">
        <dt className="text-muted-foreground">Total excl. VAT</dt>
        <dd className="tabular-nums">{formatMoney(subtotal)}</dd>
      </div>
      <div className="flex justify-between">
        <dt className="text-muted-foreground">VAT</dt>
        <dd className="tabular-nums">{formatMoney(tax)}</dd>
      </div>
      <div className="flex justify-between border-t border-border pt-2 text-base font-semibold">
        <dt>Total</dt>
        <dd className="tabular-nums">{formatMoney(total)}</dd>
      </div>
      {paid !== undefined && balance !== undefined ? (
        <>
          {advanceApplied && advanceApplied !== '0.00' ? (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Advance applied</dt>
              <dd className="tabular-nums">{formatMoney(advanceApplied)}</dd>
            </div>
          ) : null}
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Amount paid</dt>
            <dd className="tabular-nums">{formatMoney(paid)}</dd>
          </div>
          <div className="flex justify-between text-base font-semibold">
            <dt>Balance due</dt>
            <dd className={cn('tabular-nums', balance !== '0.00' ? 'text-danger' : 'text-success')}>
              {formatMoney(balance)}
            </dd>
          </div>
        </>
      ) : null}
    </dl>
  );
}
