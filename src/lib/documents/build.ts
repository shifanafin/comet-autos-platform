import type { EstimateItemType, EstimateStatus, PaymentMethod } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { formatCalendarDate, formatDate, formatDateTime, localDateString } from '@/lib/format';
import { formatMilli, signedToMilli } from '@/lib/money';
import { invoiceBalance, receiptBalances } from '@/lib/billing/invoice';
import {
  formatAed,
  type CustomerDocumentModel,
  type DocumentLine,
  type DocumentLineType,
  type DocumentSection,
  type DocumentSeller,
  type DocumentTone,
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

async function loadSeller(organizationId: string): Promise<DocumentSeller> {
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
const fileName = (seller: { name: string }, title: string, number: string) => {
  const workshop = seller.name.trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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
  requirePermission(user, 'job_card.view', { branchId: estimate.branchId });
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
      lineTotal: item.lineTotal.toString(),
    };
    (kind === 'ADDITIONAL' ? additional : main).push(line);
  }
  const sections: DocumentSection[] = [
    ...(main.length ? [{ title: '', lines: main }] : []),
    ...(additional.length ? [{ title: 'Additional approved work', lines: additional }] : []),
  ];
  const payments = countedPayments(invoice);
  const title = invoice.invoiceType === 'PROFORMA' ? 'Proforma invoice' : 'Tax invoice';

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
      ...(invoice.jobCard ? [{ label: 'Job card', value: invoice.jobCard.jobNumber }] : []),
    ],
    ...invoiceParties(invoice),
    narrative: [],
    sections,
    totals: [
      { label: 'Total excl. VAT', amount: invoice.subtotal.toString() },
      { label: vatLabel(sections.flatMap((s) => s.lines)), amount: invoice.taxAmount.toString() },
      { label: 'Total', amount: balance.total, emphasis: 'total' },
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
  if (!payment) throw new NotFoundError('payment');
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

export async function getInvoiceDocument(user: AuthenticatedUser, invoiceId: string) {
  const invoice = await fetchInvoice(user.organizationId, { id: invoiceId });
  if (!invoice) throw new NotFoundError('invoice');
  requirePermission(user, 'invoice.view', { branchId: invoice.branchId });
  return invoiceModel(invoice, await invoiceSeller(invoice));
}

export async function getReceiptDocument(user: AuthenticatedUser, paymentId: string) {
  const invoice = await fetchInvoice(user.organizationId, { paymentId });
  if (!invoice) throw new NotFoundError('receipt');
  requirePermission(user, 'invoice.view', { branchId: invoice.branchId });
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
        nextVersions: { none: {} },
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
