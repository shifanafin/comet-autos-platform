import type { EstimateItemType, EstimateStatus, PaymentMethod } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { formatCalendarDate, formatDate, formatDateTime, localDateString } from '@/lib/format';
import {
  billDiscountBreakdown,
  filsToString,
  formatMilli,
  signedToMilli,
  toFils,
} from '@/lib/money';
import { invoiceBalance, receiptBalances } from '@/lib/billing/invoice';
import { employeeName } from '@/lib/workshop/assignment';
import {
  formatAed,
  formatRate,
  type CustomerDocumentModel,
  type DocumentLine,
  type DocumentLineType,
  type DocumentSection,
  type DocumentSeller,
  type DocumentTone,
  type DocumentTotal,
} from '@/lib/documents/model';

/*
 * Domain → document model. Loads a quotation, invoice or payment and
 * describes it for the customer using the amounts the domain already holds:
 * estimate and invoice totals as stored when they were calculated, and paid /
 * balance from the billing rules (invoiceBalance, receiptBalances). Nothing
 * here re-prices anything.
 *
 * Staff loaders check permissions; customer loaders are called only with the
 * organization and resource an already-verified customer link points at.
 */

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  ONLINE: 'Online',
};

const APPROVAL_METHOD_LABEL: Record<string, string> = {
  ONLINE: 'online',
  IN_PERSON: 'in person',
  PHONE: 'by phone',
  EMAIL: 'by email',
  SMS: 'by SMS',
  DIGITAL_SIGNATURE: 'by signature',
};

const vehicleSelect = {
  plateNumber: true,
  vin: true,
  make: true,
  model: true,
  year: true,
} as const;

/** The job's own customer — who the quotation was for — never the vehicle's current owner. */
const customerSelect = { name: true, phone: true, address: true, taxNumber: true } as const;

export async function loadSeller(organizationId: string): Promise<DocumentSeller> {
  return prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: {
      name: true,
      legalName: true,
      address: true,
      phone: true,
      email: true,
      taxNumber: true,
    },
  });
}

const vehicleLabel = (v: { make: string; model: string; year: number | null }) =>
  [v.make, v.model, v.year].filter(Boolean).join(' ');
/** "Mohammed-Mowla-Auto-Garage-LLC-Tax-invoice-INV-000003": the workshop's own name, not the app's. */
export const fileName = (seller: { name: string }, title: string, number: string) => {
  const workshop = seller.name
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${workshop ? `${workshop}-` : ''}${title.replace(/\s+/g, '-')}-${number}`;
};

/** The TYPE column: parts or labour, as the workshop's own sheet prints it. */
function lineType(itemType: EstimateItemType | null): DocumentLineType | null {
  if (itemType === 'LABOUR') return 'LABOUR';
  if (itemType === 'PART') return 'PARTS';
  return null;
}

/** "VAT 5%" when every line carries the same rate, otherwise "VAT". */
function vatLabel(lines: DocumentLine[]) {
  const rates = new Set(
    lines
      .map((l) => l.taxRate)
      .filter((r): r is string => r !== null)
      .map((r) => formatMilli(signedToMilli(r))),
  );
  return rates.size === 1 ? `VAT ${[...rates][0]}%` : 'VAT';
}

// ---------------------------------------------------------------------------
// Quotation
// ---------------------------------------------------------------------------

async function fetchQuotation(organizationId: string, estimateId: string) {
  return prisma.estimate.findFirst({
    where: { id: estimateId, organizationId },
    include: {
      items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      approvals: {
        orderBy: { decidedAt: 'desc' },
        take: 1,
        select: { status: true, decidedAt: true, approvalMethod: true },
      },
      // The quotation's own parties: backfilled from the job card for
      // every quotation that has one, and the only source for one that
      // doesn't.
      customer: { select: customerSelect },
      vehicle: { select: vehicleSelect },
      jobCard: {
        select: {
          jobNumber: true,
          customerComplaint: true,
          odometerReading: true,
        },
      },
    },
  });
}

function quotationStatus(
  status: EstimateStatus,
  expired: boolean,
): { label: string; tone: DocumentTone } {
  if (status === 'APPROVED' || status === 'PARTIALLY_APPROVED')
    return { label: 'Approved', tone: 'success' };
  if (status === 'REJECTED') return { label: 'Rejected', tone: 'danger' };
  if (status === 'EXPIRED' || expired) return { label: 'Expired', tone: 'neutral' };
  if (status === 'SENT') return { label: 'Awaiting approval', tone: 'warning' };
  return { label: 'Draft', tone: 'info' };
}

function quotationModel(
  estimate: NonNullable<Awaited<ReturnType<typeof fetchQuotation>>>,
  seller: DocumentSeller,
): CustomerDocumentModel {
  const { jobCard } = estimate;
  const toLine = (item: (typeof estimate.items)[number]): DocumentLine => ({
    type: lineType(item.itemType),
    description: item.description,
    quantity: item.quantity.toString(),
    unitPrice: item.unitPrice.toString(),
    taxRate: item.taxRate?.toString() ?? null,
    discount: lineDiscount(item.discountAmount),
    lineTotal: item.lineTotal.toString(),
  });
  // One numbered list in the order the lines were entered, each marked
  // parts or labour — the layout of the workshop's own quotation sheet.
  const sections: DocumentSection[] =
    estimate.items.length > 0 ? [{ title: '', lines: estimate.items.map(toLine) }] : [];
  const expired =
    estimate.status === 'SENT' &&
    estimate.validUntil !== null &&
    estimate.validUntil.toISOString().slice(0, 10) < localDateString();
  const decision = estimate.approvals[0];
  const title = estimate.kind === 'ADDITIONAL' ? 'Additional work quotation' : 'Quotation';

  return {
    kind: 'QUOTATION',
    title,
    number: estimate.estimateNumber,
    status: quotationStatus(estimate.status, expired),
    seller,
    meta: [
      { label: 'Date', value: formatDate(estimate.sentAt ?? estimate.createdAt) },
      ...(estimate.validUntil
        ? [{ label: 'Valid until', value: formatCalendarDate(estimate.validUntil) }]
        : []),
      ...(jobCard ? [{ label: 'Job card', value: jobCard.jobNumber }] : []),
      ...(decision
        ? [
            {
              label: decision.status === 'APPROVED' ? 'Approved' : 'Declined',
              value:
                `${formatDate(decision.decidedAt)} ${APPROVAL_METHOD_LABEL[decision.approvalMethod] ?? ''}`.trim(),
            },
          ]
        : []),
    ],
    customer: {
      name: estimate.customer.name,
      phone: estimate.customer.phone,
      address: estimate.customer.address,
      taxNumber: estimate.customer.taxNumber,
    },
    vehicle: estimate.vehicle
      ? {
          description: vehicleLabel(estimate.vehicle),
          plateNumber: estimate.vehicle.plateNumber,
          vin: estimate.vehicle.vin,
          mileage:
            jobCard?.odometerReading != null
              ? `${jobCard.odometerReading.toLocaleString('en-US')} km`
              : null,
        }
      : null,
    narrative:
      estimate.kind === 'ADDITIONAL'
        ? estimate.notes
          ? [{ label: 'Found during the repair', value: estimate.notes }]
          : []
        : jobCard?.customerComplaint
          ? [{ label: 'Work requested', value: jobCard.customerComplaint }]
          : [],
    sections,
    totals: [
      ...billDiscountRows(estimate),
      { label: 'Total excl. VAT', amount: estimate.subtotal.toString() },
      { label: vatLabel(sections.flatMap((s) => s.lines)), amount: estimate.taxAmount.toString() },
      { label: 'Total', amount: estimate.totalAmount.toString(), emphasis: 'total' },
    ],
    highlight: null,
    detailsTitle: null,
    details: [],
    notes: [
      ...(estimate.validUntil
        ? [`Prices are held until ${formatCalendarDate(estimate.validUntil)}.`]
        : []),
      'Work starts only after you approve this quotation. Any further work found during the repair is quoted separately.',
      ...(estimate.kind === 'ORIGINAL' && estimate.notes ? [estimate.notes] : []),
    ],
    fileName: fileName(seller, title, estimate.estimateNumber),
  };
}

export async function getQuotationDocument(user: AuthenticatedUser, estimateId: string) {
  const estimate = await fetchQuotation(user.organizationId, estimateId);
  if (!estimate) throw new NotFoundError('quotation');
  requirePermission(user, 'quotation.view', { branchId: estimate.branchId });
  return quotationModel(estimate, await loadSeller(user.organizationId));
}

/** For a verified customer link only. */
export async function getQuotationDocumentForLink(organizationId: string, estimateId: string) {
  const estimate = await fetchQuotation(organizationId, estimateId);
  if (!estimate) return null;
  return quotationModel(estimate, await loadSeller(organizationId));
}

// ---------------------------------------------------------------------------
// Invoice and receipts
// ---------------------------------------------------------------------------

async function fetchInvoice(organizationId: string, where: { id: string } | { paymentId: string }) {
  return prisma.invoice.findFirst({
    where: {
      organizationId,
      status: { notIn: ['VOID', 'CANCELLED'] },
      ...('id' in where ? { id: where.id } : { payments: { some: { id: where.paymentId } } }),
    },
    include: {
      items: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          labour: {
            select: { estimateItem: { select: { estimate: { select: { kind: true } } } } },
          },
          partUsage: {
            select: { estimateItem: { select: { estimate: { select: { kind: true } } } } },
          },
        },
      },
      payments: { orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] },
      // The invoice names its own customer and vehicle; the snapshot fields
      // hold the rest. The job card, when there is one, adds its number
      // and the mileage the car came in on.
      customer: { select: { name: true, phone: true } },
      vehicle: { select: vehicleSelect },
      jobCard: {
        select: { jobNumber: true, odometerReading: true },
      },
    },
  });
}

type InvoiceRecord = NonNullable<Awaited<ReturnType<typeof fetchInvoice>>>;

/** Seller as it was when the invoice was issued (legal snapshot), with current contact details. */
async function invoiceSeller(invoice: InvoiceRecord): Promise<DocumentSeller> {
  const current = await loadSeller(invoice.organizationId);
  // A business renamed after this invoice was issued: the invoice still
  // names the one that issued it, at the top as well as in the legal line —
  // never the new name above the old legal name, which reads as two companies.
  const renamed =
    invoice.sellerLegalName !== null &&
    invoice.sellerLegalName !== (current.legalName ?? current.name);
  return {
    ...current,
    name: renamed && invoice.sellerLegalName ? invoice.sellerLegalName : current.name,
    legalName: invoice.sellerLegalName ?? current.legalName,
    address: invoice.sellerAddress ?? current.address,
    taxNumber: invoice.sellerTaxNumber ?? current.taxNumber,
  };
}

function invoiceParties(invoice: InvoiceRecord) {
  const vehicle = invoice.vehicle;
  return {
    customer: {
      name: invoice.customerName ?? invoice.customer.name,
      phone: invoice.customer.phone,
      address: invoice.customerAddress,
      taxNumber: invoice.customerTaxNumber,
    },
    vehicle: vehicle
      ? {
          description: vehicleLabel(vehicle),
          plateNumber: vehicle.plateNumber,
          vin: vehicle.vin,
          mileage:
            invoice.jobCard?.odometerReading != null
              ? `${invoice.jobCard.odometerReading.toLocaleString('en-US')} km`
              : null,
        }
      : null,
  };
}

const PAYMENT_STATE = {
  UNPAID: { label: 'Unpaid', tone: 'warning' },
  PARTIALLY_PAID: { label: 'Partially paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
} as const;

/** The AED a line's discount took off, or null for a line without one. */
function lineDiscount(amount: { toString(): string }): string | null {
  return toFils(amount.toString()) > 0 ? amount.toString() : null;
}

/**
 * With a discount on the whole bill, the totals show the lines' total, the
 * discount taken off it, and then the taxable total as usual. Without one,
 * nothing: the totals read exactly as before.
 */
function billDiscountRows(document: {
  discountType: string | null;
  discountValue: { toString(): string } | null;
  discountAmount: { toString(): string };
  subtotal: { toString(): string };
}): DocumentTotal[] {
  const off = toFils(document.discountAmount.toString());
  if (off === 0) return [];
  const label =
    document.discountType === 'PERCENT' && document.discountValue
      ? `Discount (${formatRate(document.discountValue.toString())})`
      : 'Discount';
  return [
    { label: 'Subtotal', amount: filsToString(toFils(document.subtotal.toString()) + off) },
    { label, amount: filsToString(-off) },
  ];
}

/**
 * An invoice with a discount on the bill shows how it was reached, VAT
 * included, before the taxable total: the price before the discount, then
 * the discount off it with the VAT it saves — so the customer reads
 * "3,654.00 − 154.00 = 3,500.00" as they were told it. Without one, nothing.
 */
function invoiceDiscountRows(
  invoice: Parameters<typeof billDiscountBreakdown>[0] & {
    discountType: string | null;
    discountValue: { toString(): string } | null;
  },
  vat: string,
): DocumentTotal[] {
  const breakdown = billDiscountBreakdown(invoice);
  if (!breakdown) return [];
  const percent =
    invoice.discountType === 'PERCENT' && invoice.discountValue
      ? ` ${formatRate(invoice.discountValue.toString())}`
      : '';
  return [
    { label: 'Subtotal', amount: breakdown.linesTotal },
    { label: `${vat} before discount`, amount: breakdown.vatBefore },
    { label: 'Price before discount', amount: breakdown.totalBefore },
    {
      label: `Discount${percent} (${breakdown.discount} + VAT ${breakdown.vatSaved})`,
      amount: filsToString(-toFils(breakdown.discountWithVat)),
    },
  ];
}

/** Payments that count, for listing on the invoice and choosing receipts. */
function countedPayments<
  P extends { id: string; status: string; reversalOfPaymentId: string | null },
>(invoice: { payments: P[] }) {
  const reversed = new Set(invoice.payments.map((p) => p.reversalOfPaymentId).filter(Boolean));
  return invoice.payments.filter(
    (p) => p.status === 'COMPLETED' && !p.reversalOfPaymentId && !reversed.has(p.id),
  );
}

function invoiceModel(invoice: InvoiceRecord, seller: DocumentSeller): CustomerDocumentModel {
  const balance = invoiceBalance(invoice);
  // One numbered list in billing order, each line marked parts or labour.
  // Work the customer approved separately during the repair keeps its own
  // titled run at the end, so it can't be mistaken for the original quote.
  const main: DocumentLine[] = [];
  const additional: DocumentLine[] = [];
  for (const item of invoice.items) {
    const kind = (item.labour ?? item.partUsage)?.estimateItem?.estimate.kind;
    const line: DocumentLine = {
      type: lineType(
        item.itemType ?? (item.labourId ? 'LABOUR' : item.partUsageId ? 'PART' : null),
      ),
      description: item.description,
      quantity: item.quantity.toString(),
      unitPrice: item.unitPrice.toString(),
      taxRate: item.taxRate?.toString() ?? null,
      discount: lineDiscount(item.discountAmount),
      lineTotal: item.lineTotal.toString(),
    };
    (kind === 'ADDITIONAL' ? additional : main).push(line);
  }
  const sections: DocumentSection[] = [
    ...(main.length ? [{ title: '', lines: main }] : []),
    ...(additional.length ? [{ title: 'Additional approved work', lines: additional }] : []),
  ];
  const payments = countedPayments(invoice);
  const title =
    invoice.invoiceType === 'PROFORMA'
      ? 'Proforma invoice'
      : invoice.invoiceType === 'OPENING_BALANCE'
        ? 'Opening balance'
        : 'Tax invoice';

  return {
    kind: 'INVOICE',
    title,
    number: invoice.invoiceNumber,
    // No paid/unpaid badge on the customer's invoice: the totals already
    // show what was paid and what is due.
    status: null,
    seller,
    meta: [
      { label: 'Invoice date', value: formatCalendarDate(invoice.issueDate) },
      ...(invoice.supplyDate
        ? [{ label: 'Date of supply', value: formatCalendarDate(invoice.supplyDate) }]
        : []),
      // Due on receipt needs no line of its own; a later date does.
      ...(invoice.dueDate && invoice.dueDate > invoice.issueDate
        ? [{ label: 'Due date', value: formatCalendarDate(invoice.dueDate) }]
        : []),
      ...(invoice.customerReference
        ? [{ label: 'Your order no.', value: invoice.customerReference }]
        : []),
      ...(invoice.jobCard ? [{ label: 'Job card', value: invoice.jobCard.jobNumber }] : []),
    ],
    ...invoiceParties(invoice),
    narrative: [],
    sections,
    totals: [
      ...invoiceDiscountRows(invoice, vatLabel(sections.flatMap((s) => s.lines))),
      { label: 'Total excl. VAT', amount: invoice.subtotal.toString() },
      { label: vatLabel(sections.flatMap((s) => s.lines)), amount: invoice.taxAmount.toString() },
      ...(!invoice.roundingAdjustment.isZero()
        ? [{ label: 'Round-off', amount: invoice.roundingAdjustment.toFixed(2) }]
        : []),
      { label: 'Total', amount: balance.total, emphasis: 'total' },
      // A discount given after the invoice comes off its total; VAT stays as invoiced.
      ...(toFils(balance.discount) > 0
        ? [
            { label: 'Discount', amount: filsToString(-toFils(balance.discount)) },
            {
              label: 'Total after discount',
              amount: filsToString(toFils(balance.total) - toFils(balance.discount)),
            },
          ]
        : []),
      ...(toFils(balance.credited) > 0
        ? [{ label: 'Credit notes', amount: filsToString(-toFils(balance.credited)) }]
        : []),
      ...(toFils(balance.advanceApplied) > 0
        ? [{ label: 'Advance applied', amount: filsToString(-toFils(balance.advanceApplied)) }]
        : []),
      { label: 'Amount paid', amount: balance.paid },
      { label: 'Balance due', amount: balance.balance, emphasis: 'balance' },
    ],
    highlight: null,
    detailsTitle: payments.length ? 'Payments received' : null,
    details: payments.map((p) => ({
      label: p.paymentNumber ?? 'Payment',
      value: `${formatDate(p.receivedAt)} · ${PAYMENT_METHOD_LABEL[p.method]} · ${formatAed(p.amount.toString())}`,
    })),
    notes: [
      balance.state === 'PAID'
        ? 'This invoice is fully paid. Thank you.'
        : `Please quote ${invoice.invoiceNumber} with your payment.`,
      'Amounts are in UAE dirhams (AED) and include VAT where shown.',
      ...(invoice.notes ? [invoice.notes] : []),
    ],
    fileName: fileName(seller, title, invoice.invoiceNumber),
  };
}

function receiptModel(
  invoice: InvoiceRecord,
  paymentId: string,
  seller: DocumentSeller,
): CustomerDocumentModel {
  const payment = invoice.payments.find((p) => p.id === paymentId);
  // The row that cancels a payment is not money received: it has no receipt.
  if (!payment || payment.reversalOfPaymentId) throw new NotFoundError('payment');
  const reversal = invoice.payments.find((p) => p.reversalOfPaymentId === payment.id);
  if (reversal) return reversedReceiptModel(invoice, payment, reversal, seller);
  const { previousBalance, remainingBalance } = receiptBalances(invoice, payment.id);
  const number = payment.paymentNumber ?? invoice.invoiceNumber;
  const settled = signedToMilli(remainingBalance) === 0;

  return {
    kind: 'RECEIPT',
    title: 'Payment receipt',
    number,
    status: settled
      ? { label: 'Paid in full', tone: 'success' }
      : { label: 'Partially paid', tone: 'warning' },
    seller,
    meta: [
      { label: 'Payment date', value: formatDate(payment.receivedAt) },
      { label: 'Invoice', value: invoice.invoiceNumber },
      ...(invoice.jobCard ? [{ label: 'Job card', value: invoice.jobCard.jobNumber }] : []),
    ],
    ...invoiceParties(invoice),
    narrative: [],
    sections: [],
    totals: [],
    highlight: {
      label: 'Amount received',
      amount: payment.amount.toString(),
      caption: PAYMENT_METHOD_LABEL[payment.method],
    },
    detailsTitle: 'Payment details',
    details: [
      { label: 'Receipt number', value: number },
      { label: 'Received on', value: formatDateTime(payment.receivedAt) },
      { label: 'Payment method', value: PAYMENT_METHOD_LABEL[payment.method] },
      ...(payment.referenceNumber ? [{ label: 'Reference', value: payment.referenceNumber }] : []),
      {
        label: 'Invoice',
        value: `${invoice.invoiceNumber} · total ${formatAed(invoice.totalAmount.toString())}`,
      },
      { label: 'Balance before this payment', value: formatAed(previousBalance) },
      { label: 'Amount paid', value: formatAed(payment.amount.toString()) },
      { label: 'Remaining balance', value: formatAed(remainingBalance) },
      { label: 'Payment status', value: settled ? 'Invoice paid in full' : 'Balance outstanding' },
    ],
    notes: ['Thank you for your payment. Please keep this receipt for your records.'],
    fileName: fileName(seller, 'Receipt', number),
  };
}

/**
 * The receipt of a payment that was later reversed: kept for the record, but
 * saying plainly — in its status, amount label and notes — that it no longer
 * counts, when and why it was reversed, and what the invoice's balance is now.
 */
function reversedReceiptModel(
  invoice: InvoiceRecord,
  payment: InvoiceRecord['payments'][number],
  reversal: InvoiceRecord['payments'][number],
  seller: DocumentSeller,
): CustomerDocumentModel {
  const number = payment.paymentNumber ?? invoice.invoiceNumber;
  const balance = invoiceBalance(invoice);
  return {
    kind: 'RECEIPT',
    title: 'Payment receipt — reversed',
    number,
    status: { label: 'Reversed', tone: 'danger' },
    seller,
    meta: [
      { label: 'Payment date', value: formatDate(payment.receivedAt) },
      { label: 'Reversed on', value: formatDate(reversal.receivedAt) },
      { label: 'Invoice', value: invoice.invoiceNumber },
      ...(invoice.jobCard ? [{ label: 'Job card', value: invoice.jobCard.jobNumber }] : []),
    ],
    ...invoiceParties(invoice),
    narrative: [],
    sections: [],
    totals: [],
    highlight: {
      label: 'Amount reversed',
      amount: payment.amount.toString(),
      caption: PAYMENT_METHOD_LABEL[payment.method],
    },
    detailsTitle: 'Payment details',
    details: [
      { label: 'Receipt number', value: number },
      { label: 'Received on', value: formatDateTime(payment.receivedAt) },
      { label: 'Reversed on', value: formatDateTime(reversal.receivedAt) },
      ...(reversal.notes ? [{ label: 'Reason', value: reversal.notes }] : []),
      { label: 'Payment method', value: PAYMENT_METHOD_LABEL[payment.method] },
      ...(payment.referenceNumber ? [{ label: 'Reference', value: payment.referenceNumber }] : []),
      {
        label: 'Invoice',
        value: `${invoice.invoiceNumber} · total ${formatAed(invoice.totalAmount.toString())}`,
      },
      { label: 'Invoice balance now', value: formatAed(balance.balance) },
    ],
    notes: [
      'This payment was reversed and no longer counts towards the invoice. It is kept on record only.',
    ],
    fileName: fileName(seller, 'Receipt reversed', number),
  };
}

/**
 * A tax credit note: the invoice lines it takes back, at the invoice's own
 * prices and VAT, and why. Carries the original invoice's number and date, as
 * a tax credit note must.
 */
async function creditNoteModel(
  organizationId: string,
  creditNoteId: string,
): Promise<{ branchId: string; model: CustomerDocumentModel }> {
  const note = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, organizationId },
    include: {
      items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
    },
  });
  if (!note) throw new NotFoundError('credit note');
  const invoice = await fetchInvoice(organizationId, { id: note.invoiceId });
  if (!invoice) throw new NotFoundError('credit note');
  const seller = await invoiceSeller(invoice);
  const lines: DocumentLine[] = note.items.map((item) => ({
    type: lineType(item.itemType),
    description: item.description,
    quantity: item.quantity.toString(),
    unitPrice: item.unitPrice.toString(),
    taxRate: item.taxRate.toString(),
    discount: null,
    lineTotal: item.lineTotal.toString(),
  }));
  const share = toFils(note.discountAmount.toString());
  const isVoid = note.status === 'VOID';
  const refund = toFils(note.refundAmount.toString());
  const title = 'Tax credit note';
  return {
    branchId: note.branchId,
    model: {
      kind: 'CREDIT_NOTE',
      title,
      number: note.creditNoteNumber,
      status: isVoid ? { label: 'Void', tone: 'danger' } : null,
      seller,
      meta: [
        { label: 'Credit note date', value: formatCalendarDate(note.issueDate) },
        { label: 'Original invoice', value: invoice.invoiceNumber },
        { label: 'Invoice date', value: formatCalendarDate(invoice.issueDate) },
        ...(invoice.jobCard ? [{ label: 'Job card', value: invoice.jobCard.jobNumber }] : []),
      ],
      ...invoiceParties(invoice),
      narrative: [{ label: 'Reason for credit', value: note.reason }],
      sections: [{ title: '', lines }],
      totals: [
        ...(share > 0
          ? [
              {
                label: 'Subtotal',
                amount: filsToString(toFils(note.subtotal.toString()) + share),
              },
              { label: 'Invoice discount', amount: filsToString(-share) },
            ]
          : []),
        { label: 'Total excl. VAT', amount: note.subtotal.toString() },
        { label: vatLabel(lines), amount: note.taxAmount.toString() },
        ...(!note.roundingAmount.isZero()
          ? [{ label: 'Invoice round-off', amount: note.roundingAmount.toFixed(2) }]
          : []),
        { label: 'Total credited', amount: note.totalAmount.toString(), emphasis: 'total' },
      ],
      highlight: null,
      detailsTitle: refund > 0 ? 'Refund' : null,
      details:
        refund > 0
          ? [
              { label: 'Refunded to you', value: formatAed(note.refundAmount.toString()) },
              ...(note.refundedOn
                ? [
                    { label: 'Refunded on', value: formatCalendarDate(note.refundedOn) },
                    ...(note.refundMethod
                      ? [{ label: 'Method', value: PAYMENT_METHOD_LABEL[note.refundMethod] }]
                      : []),
                    ...(note.refundReference
                      ? [{ label: 'Reference', value: note.refundReference }]
                      : []),
                  ]
                : [{ label: 'Status', value: 'To be refunded' }]),
            ]
          : [],
      notes: [
        ...(isVoid
          ? ['This credit note was withdrawn and does not count. It is kept on record only.']
          : []),
        `This credit note reduces invoice ${invoice.invoiceNumber} by ${formatAed(note.totalAmount.toString())}, VAT included.`,
        'Amounts are in UAE dirhams (AED).',
      ],
      fileName: fileName(seller, title, note.creditNoteNumber),
    },
  };
}

export async function getCreditNoteDocument(user: AuthenticatedUser, creditNoteId: string) {
  const { branchId, model } = await creditNoteModel(user.organizationId, creditNoteId);
  requirePermission(user, 'credit_note.view', { branchId });
  return model;
}

export async function getInvoiceDocument(user: AuthenticatedUser, invoiceId: string) {
  const invoice = await fetchInvoice(user.organizationId, { id: invoiceId });
  if (!invoice) throw new NotFoundError('invoice');
  requirePermission(user, 'invoice.view', { branchId: invoice.branchId });
  return invoiceModel(invoice, await invoiceSeller(invoice));
}

export async function getReceiptDocument(user: AuthenticatedUser, paymentId: string) {
  const invoice = await fetchInvoice(user.organizationId, { paymentId });
  if (!invoice) throw new NotFoundError('receipt');
  requirePermission(user, 'payment.view', { branchId: invoice.branchId });
  return receiptModel(invoice, paymentId, await invoiceSeller(invoice));
}

/** For a verified customer link only: the invoice, and the receipts the customer may open by number. */
export async function getInvoiceDocumentForLink(organizationId: string, invoiceId: string) {
  const invoice = await fetchInvoice(organizationId, { id: invoiceId });
  if (!invoice) return null;
  const seller = await invoiceSeller(invoice);
  return {
    document: invoiceModel(invoice, seller),
    balance: invoiceBalance(invoice),
    receipts: countedPayments(invoice)
      .filter((p) => p.paymentNumber)
      .map((p) => ({
        number: p.paymentNumber!,
        receivedAt: p.receivedAt,
        method: PAYMENT_METHOD_LABEL[p.method],
        amount: p.amount.toString(),
      })),
  };
}

/** For a verified customer link only: one receipt of the linked invoice, by its receipt number. */
export async function getReceiptDocumentForLink(
  organizationId: string,
  invoiceId: string,
  receiptNumber: string,
) {
  const invoice = await fetchInvoice(organizationId, { id: invoiceId });
  const payment = invoice
    ? countedPayments(invoice).find((p) => p.paymentNumber === receiptNumber)
    : undefined;
  if (!invoice || !payment) return null;
  return receiptModel(invoice, payment.id, await invoiceSeller(invoice));
}

// ---------------------------------------------------------------------------
// The job card's customer documents
// ---------------------------------------------------------------------------

/**
 * The documents a job has to share with the customer: the current version of
 * each quotation (original and any additional work) once sent, the live
 * invoice, and a receipt per payment that counts.
 */
export async function getJobDocuments(user: AuthenticatedUser, jobCardId: string) {
  const jobCard = await prisma.jobCard.findFirst({
    where: { id: jobCardId, organizationId: user.organizationId },
    select: { branchId: true },
  });
  if (!jobCard) throw new NotFoundError('job card');
  requirePermission(user, 'job_card.view', { branchId: jobCard.branchId });
  const canSeeInvoice = hasPermission(user, 'invoice.view', { branchId: jobCard.branchId });

  const [estimates, invoice] = await Promise.all([
    prisma.estimate.findMany({
      where: {
        organizationId: user.organizationId,
        jobCardId,
        status: { not: 'DRAFT' },
        isCurrent: true,
      },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        kind: true,
        estimateNumber: true,
        status: true,
        totalAmount: true,
        validUntil: true,
      },
    }),
    canSeeInvoice
      ? prisma.invoice.findFirst({
          where: {
            organizationId: user.organizationId,
            jobCardId,
            status: { notIn: ['VOID', 'CANCELLED'] },
          },
          include: { payments: { orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] } },
        })
      : null,
  ]);
  const today = localDateString();

  return {
    quotations: estimates.map((e) => ({
      id: e.id,
      title: e.kind === 'ADDITIONAL' ? 'Additional work' : 'Quotation',
      number: e.estimateNumber,
      total: e.totalAmount.toString(),
      status: quotationStatus(
        e.status,
        e.status === 'SENT' &&
          e.validUntil !== null &&
          e.validUntil.toISOString().slice(0, 10) < today,
      ),
    })),
    invoice: invoice
      ? (() => {
          const balance = invoiceBalance(invoice);
          return {
            id: invoice.id,
            number: invoice.invoiceNumber,
            status: PAYMENT_STATE[balance.state],
            total: balance.total,
            balance: balance.balance,
            receipts: countedPayments(invoice).map((p) => ({
              id: p.id,
              number: p.paymentNumber ?? invoice.invoiceNumber,
              amount: p.amount.toString(),
              receivedAt: p.receivedAt,
            })),
          };
        })()
      : null,
  };
}

export type JobDocuments = Awaited<ReturnType<typeof getJobDocuments>>;

// ---------------------------------------------------------------------------
// Job card (the workshop's printed job sheet)
// ---------------------------------------------------------------------------

/**
 * The job card as a printed sheet for check-in: who brought which vehicle
 * in and what they asked for, the vehicle diagram to mark its condition on,
 * a box for the workshop supervisor's comments, and signatures. No prices
 * and no quotation lines — those have their own documents.
 */
export async function getJobCardDocument(
  user: AuthenticatedUser,
  jobCardId: string,
): Promise<CustomerDocumentModel> {
  const jobCard = await prisma.jobCard.findFirst({
    where: { id: jobCardId, organizationId: user.organizationId },
    include: {
      customer: { select: customerSelect },
      vehicle: { select: vehicleSelect },
      createdBy: { select: { fullName: true } },
      deliveredBy: { select: { fullName: true } },
      assignments: {
        where: { unassignedAt: null },
        orderBy: [{ assignmentRole: 'asc' }, { assignedAt: 'asc' }],
        select: { employee: { select: { firstName: true, lastName: true } } },
      },
      inspections: {
        orderBy: { inspectedAt: 'desc' },
        take: 1,
        select: { summary: true },
      },
      diagnoses: {
        orderBy: { diagnosedAt: 'desc' },
        take: 1,
        select: { findings: true, recommendedAction: true },
      },
    },
  });
  if (!jobCard) throw new NotFoundError('job card');
  requirePermission(user, 'job_card.view', { branchId: jobCard.branchId });
  const seller = await loadSeller(user.organizationId);

  const technicians = jobCard.assignments.map((a) => employeeName(a.employee));
  const inspection = jobCard.inspections[0];
  const diagnosis = jobCard.diagnoses[0];

  return {
    kind: 'JOB_CARD',
    title: 'Job card',
    number: jobCard.jobNumber,
    status: null,
    seller,
    meta: [
      { label: 'Checked in', value: formatDateTime(jobCard.openedAt) },
      { label: 'Received by', value: jobCard.createdBy.fullName },
      ...(technicians.length > 0 ? [{ label: 'Technician', value: technicians.join(', ') }] : []),
      ...(jobCard.deliveredAt
        ? [
            {
              label: 'Delivered',
              value: `${formatDateTime(jobCard.deliveredAt)}${jobCard.deliveredBy ? ` by ${jobCard.deliveredBy.fullName}` : ''}`,
            },
          ]
        : []),
    ],
    customer: {
      name: jobCard.customer.name,
      phone: jobCard.customer.phone,
      address: jobCard.customer.address,
      taxNumber: jobCard.customer.taxNumber,
    },
    vehicle: {
      description: vehicleLabel(jobCard.vehicle),
      plateNumber: jobCard.vehicle.plateNumber,
      vin: jobCard.vehicle.vin,
      mileage:
        jobCard.odometerReading != null
          ? `${jobCard.odometerReading.toLocaleString('en-US')} km`
          : null,
    },
    // The complaint always comes first: blank, it prints lines to write on.
    narrative: [
      { label: 'Customer complaint', value: jobCard.customerComplaint ?? '' },
      ...(inspection?.summary ? [{ label: 'Inspection', value: inspection.summary }] : []),
      ...(diagnosis
        ? [
            {
              label: 'Diagnosis',
              value: [diagnosis.findings, diagnosis.recommendedAction].filter(Boolean).join('\n'),
            },
          ]
        : []),
    ],
    sections: [],
    totals: [],
    highlight: null,
    detailsTitle: null,
    details: [],
    notes: jobCard.deliveryNotes ? [jobCard.deliveryNotes] : [],
    fileName: fileName(seller, 'Job card', jobCard.jobNumber),
  };
}
