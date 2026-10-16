import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { formatCalendarDate } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import { METHOD_LABEL } from '@/lib/accounting/payment-modes';
import { getCustomerAdvance, ADVANCE_STATUS_LABEL } from '@/lib/billing/advances';
import { fileName, loadSeller } from '@/lib/documents/build';
import { formatAed, formatRate, type CustomerDocumentModel, type DocumentField } from '@/lib/documents/model';
import { aedInWords } from '@/lib/documents/amount-words';

/*
 * What the customer is given when they pay an advance.
 *
 * A VAT-registered workshop owes VAT on an advance the day it is received
 * (the date of supply is the earlier of the work, the invoice or the
 * payment), so its paper is a tax invoice for the advance: the workshop's
 * TRN, the customer's, the amount received split into its value and the VAT
 * included, and the job it is towards. When the job is invoiced, the
 * advance is applied to that invoice and the VAT already accounted here is
 * taken off it (lib/billing/advance-vat.ts).
 *
 * An advance taken before VAT on advances was switched on, or by a workshop
 * not registered, carries no VAT: it is an advance receipt.
 */

/** The advance as paper, ready for the PDF renderer. */
export async function getAdvanceReceiptDocument(
  user: AuthenticatedUser,
  advanceId: string,
): Promise<CustomerDocumentModel> {
  const advance = await getCustomerAdvance(user, advanceId);
  const [seller, customer] = await Promise.all([
    loadSeller(user.organizationId),
    prisma.customer.findFirstOrThrow({
      where: { id: advance.customerId, organizationId: user.organizationId },
      select: { name: true, phone: true, taxNumber: true, address: true },
    }),
  ]);
  const amount = advance.amount.toString();
  const amountFils = toFils(amount);
  const vatFils = advance.vatTreatment === 'VAT_ON_RECEIPT' ? toFils(advance.vatAmount.toString()) : 0;
  const withVat = vatFils > 0;
  const cancelled = advance.status === 'CANCELLED';
  const method = METHOD_LABEL[advance.method];

  const details: DocumentField[] = [
    { label: 'Amount received', value: formatAed(amount) },
    { label: 'Amount in words', value: aedInWords(amount) },
    { label: 'Paid by', value: advance.account?.accountName ? `${method} · ${advance.account.accountName}` : method },
    ...(advance.reference ? [{ label: 'Reference', value: advance.reference }] : []),
    ...(advance.jobCard ? [{ label: 'For job', value: advance.jobCard.jobNumber }] : []),
    { label: 'Received by', value: advance.receivedBy.fullName },
  ];
  const applied = advance.allocations.filter((row) => !row.reversedAt && toFils(row.amount.toString()) > 0);
  if (applied.length) {
    details.push({
      label: 'Applied to',
      value: applied
        .map((row) => `${row.invoice.invoiceNumber} (${formatAed(row.amount.toString())})`)
        .join(', '),
    });
  }

  return {
    kind: 'RECEIPT',
    title: withVat ? 'Tax invoice — advance payment' : 'Advance receipt',
    number: advance.advanceNumber,
    status: cancelled
      ? { label: 'Cancelled', tone: 'danger' }
      : { label: ADVANCE_STATUS_LABEL[advance.status], tone: toFils(advance.figures.left) > 0 ? 'info' : 'success' },
    seller,
    meta: [
      { label: withVat ? 'Date of supply' : 'Received on', value: formatCalendarDate(advance.receivedOn) },
      ...(advance.jobCard ? [{ label: 'Job card', value: advance.jobCard.jobNumber }] : []),
    ],
    customer: {
      name: customer.name,
      phone: customer.phone,
      taxNumber: customer.taxNumber,
      address: customer.address,
    },
    vehicle: advance.vehicle
      ? {
          description: [advance.vehicle.make, advance.vehicle.model].filter(Boolean).join(' '),
          plateNumber: advance.vehicle.plateNumber,
          vin: null,
          mileage: null,
        }
      : null,
    narrative: [
      {
        label: 'For',
        value: advance.notes ?? `Advance towards ${advance.jobCard ? `job ${advance.jobCard.jobNumber}` : 'the repair'}`,
      },
    ],
    sections: [],
    totals: withVat
      ? [
          { label: 'Value before VAT', amount: filsToString(amountFils - vatFils) },
          { label: `VAT ${formatRate(advance.vatRate?.toString() ?? null)}`, amount: filsToString(vatFils) },
          { label: 'Total received', amount, emphasis: 'total' },
        ]
      : [{ label: 'Total received', amount, emphasis: 'total' }],
    highlight: { label: 'Advance received', amount, caption: method },
    detailsTitle: 'Payment details',
    details,
    notes: [
      ...(cancelled
        ? [`This advance was cancelled${advance.cancelReason ? `: ${advance.cancelReason}` : ''}.`]
        : []),
      withVat
        ? 'This advance will be applied to the tax invoice for the job. The VAT shown here is already accounted for and is deducted on that invoice, so it is not charged twice.'
        : 'This advance will be applied to the invoice for the job.',
    ],
    fileName: fileName(seller, withVat ? 'Advance tax invoice' : 'Advance receipt', advance.advanceNumber),
  };
}
