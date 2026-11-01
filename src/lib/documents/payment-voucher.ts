import { formatCalendarDate } from '@/lib/format';
import { toFils } from '@/lib/money';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { getPaymentVoucher } from '@/lib/finance/payment-vouchers';
import { METHOD_LABEL } from '@/lib/accounting/payment-modes';
import { fileName, loadSeller } from '@/lib/documents/build';
import { formatAmount, type CustomerDocumentModel, type DocumentField } from '@/lib/documents/model';
import { aedInWords } from '@/lib/documents/amount-words';

/*
 * A payment voucher as paper: who was paid, how much (in figures and in
 * words), what for and how — and, for card money collected for someone,
 * how the amount handed over follows from what was collected less the
 * bank's fee. It ends with two signatures: the payee, and the workshop.
 */

/** The voucher, ready for the PDF renderer. */
export async function getPaymentVoucherDocument(
  user: AuthenticatedUser,
  voucherId: string,
): Promise<CustomerDocumentModel> {
  const voucher = await getPaymentVoucher(user, voucherId);
  const seller = await loadSeller(user.organizationId);
  const owed = voucher.status === 'OWED';
  const paid = voucher.amount?.toString() ?? null;
  const method = voucher.paymentMethod ? METHOD_LABEL[voucher.paymentMethod] : null;
  const paidFrom = voucher.paidFrom?.accountName ?? method;
  const job = voucher.expense?.jobCard ?? null;

  const details: DocumentField[] =
    voucher.kind === 'CARD_COLLECTION'
      ? [
          {
            label: 'Card payment collected',
            value: `${formatAmount(voucher.collectedAmount!.toString())} on ${formatCalendarDate(voucher.collectedOn!)}${voucher.cardReference ? ` · slip ${voucher.cardReference}` : ''}`,
          },
          ...(toFils(voucher.feeAmount.toString()) > 0
            ? [
                {
                  label: `Bank's card fee${voucher.feeRate ? ` (${voucher.feeRate.toString().replace(/\.?0+$/, '')}%)` : ''}`,
                  value: `- ${formatAmount(voucher.feeAmount.toString())}`,
                },
              ]
            : []),
          ...(toFils(voucher.feeVatAmount.toString()) > 0
            ? [{ label: 'VAT on the bank’s fee', value: `- ${formatAmount(voucher.feeVatAmount.toString())}` }]
            : []),
          { label: 'Amount paid', value: paid ? formatAmount(paid) : 'Not paid yet' },
        ]
      : [
          { label: 'For', value: voucher.expense?.chartOfAccount?.accountName ?? 'Outside work' },
          ...(job
            ? [
                {
                  label: 'Job',
                  value: `${job.jobNumber}${job.vehicle?.plateNumber ? ` · ${job.vehicle.plateNumber}` : ''}`,
                },
              ]
            : voucher.expense?.invoice
              ? [{ label: 'Invoice', value: voucher.expense.invoice.invoiceNumber }]
              : []),
          { label: 'Amount paid', value: paid ? formatAmount(paid) : '—' },
        ];
  if (paid) details.push({ label: 'Amount in words', value: aedInWords(paid) });
  if (paidFrom) details.push({ label: 'Paid by', value: paidFrom });
  if (voucher.paymentReference) details.push({ label: 'Reference', value: voucher.paymentReference });

  const date = voucher.paidOn ?? voucher.collectedOn;
  return {
    kind: 'PAYMENT_VOUCHER',
    title: 'Payment voucher',
    number: voucher.voucherNumber,
    status:
      voucher.status === 'VOID'
        ? { label: 'Void', tone: 'danger' }
        : owed
          ? { label: 'Not paid yet', tone: 'warning' }
          : { label: 'Paid', tone: 'success' },
    seller,
    meta: [
      ...(date ? [{ label: owed ? 'Collected on' : 'Paid on', value: formatCalendarDate(date) }] : []),
      ...(voucher.expense?.expenseNumber
        ? [{ label: 'Expense', value: voucher.expense.expenseNumber }]
        : []),
    ],
    customer: {
      name: voucher.payeeName,
      phone: voucher.payeePhone,
      taxNumber: null,
      address: null,
    },
    vehicle: null,
    narrative: [{ label: 'Paid for', value: voucher.description }],
    sections: [],
    totals: [],
    highlight: paid
      ? {
          label: 'Amount paid',
          amount: paid,
          caption: voucher.kind === 'CARD_COLLECTION' ? 'Card payment collected, less the bank’s fee' : method,
        }
      : {
          label: 'Collected for them',
          amount: voucher.collectedAmount!.toString(),
          caption: 'To be paid over, less the bank’s fee',
        },
    detailsTitle: 'Payment details (AED)',
    details,
    notes: [
      ...(voucher.status === 'VOID'
        ? [`This voucher is void${voucher.voidReason ? `: ${voucher.voidReason}` : ''}.`]
        : []),
      ...(voucher.notes ? [voucher.notes] : []),
    ],
    fileName: fileName(seller, 'Payment voucher', voucher.voucherNumber),
  };
}
