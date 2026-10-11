import type { InvoiceStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { filsToString, toFils } from '@/lib/money';
import { invoiceBalance } from '@/lib/billing/invoice';
import { resolveDefaultVatRate } from '@/lib/tax';
import { PURCHASE_BALANCE_SELECT, purchaseBalance } from '@/lib/finance/supplier-balance';
import { employeeName } from '@/lib/workshop/assignment';
import { customerJournalTotals } from '@/lib/accounting/sub-ledger';

const signedString = (fils: number) => (fils < 0 ? `-${filsToString(-fils)}` : filsToString(fils));

/*
 * The details an export carries beyond what its list screen shows — a
 * customer's TRN and what they owe, a purchase's discount and balance, the
 * invoice behind a job card. Each loader takes the ids of the rows the list
 * service already found (with the screen's search, filters and permission
 * checks) and reads the rest in one query, never one per row.
 */

/** Rows the list found, each with its extra details; a row with none gets an empty object. */
export async function withDetails<Row extends { id: string }, Details>(
  rows: Row[],
  load: (ids: string[]) => Promise<Map<string, Details>>,
  empty: Details,
): Promise<(Row & { details: Details })[]> {
  const details = rows.length > 0 ? await load(rows.map((row) => row.id)) : new Map();
  return rows.map((row) => ({ ...row, details: details.get(row.id) ?? empty }));
}

const COUNTED_INVOICES: { notIn: InvoiceStatus[] } = { notIn: ['DRAFT', 'VOID', 'CANCELLED'] };
const PAYMENT_FIELDS = {
  select: { id: true, amount: true, status: true, reversalOfPaymentId: true, receivedAt: true },
} as const;
const SETTLEMENT_FIELDS = {
  status: true,
  totalAmount: true,
  creditedAmount: true,
  advanceAppliedAmount: true,
  settlementDiscount: true,
  payments: PAYMENT_FIELDS,
} as const;

/** The latest of some dates, or null. */
const latest = (dates: (Date | null | undefined)[]) =>
  dates.reduce<Date | null>((max, d) => (d && (!max || d > max) ? d : max), null);

// ── Customers ────────────────────────────────────────────────────────────────

export interface CustomerDetails {
  code: string | null;
  address: string | null;
  taxNumber: string | null;
  jobCards: number;
  lastVisit: Date | null;
  invoices: number;
  invoiced: string;
  paid: string;
  /** Advances applied to the invoices. */
  advances: string;
  /** Credit notes and discounts given after invoicing. */
  credits: string;
  /** Manual journal entries naming the customer, net: positive adds to what they owe. */
  journal: string;
  owed: string;
}

export const NO_CUSTOMER_DETAILS: CustomerDetails = {
  code: null,
  address: null,
  taxNumber: null,
  jobCards: 0,
  lastVisit: null,
  invoices: 0,
  invoiced: '0.00',
  paid: '0.00',
  advances: '0.00',
  credits: '0.00',
  journal: '0.00',
  owed: '0.00',
};

export async function customerDetails(organizationId: string, ids: string[]) {
  const journal = await customerJournalTotals(prisma, organizationId, ids);
  const customers = await prisma.customer.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true,
      customerCode: true,
      address: true,
      taxNumber: true,
      _count: { select: { jobCards: true } },
      jobCards: { orderBy: { openedAt: 'desc' }, take: 1, select: { openedAt: true } },
      invoices: { where: { status: COUNTED_INVOICES }, select: SETTLEMENT_FIELDS },
    },
  });
  return new Map(
    customers.map((customer) => {
      let invoiced = 0;
      let paid = 0;
      let owed = 0;
      let advances = 0;
      let credits = 0;
      for (const invoice of customer.invoices) {
        const balance = invoiceBalance(invoice);
        invoiced += toFils(balance.total);
        paid += toFils(balance.paid);
        owed += toFils(balance.balance);
        advances += toFils(balance.advanceApplied);
        credits += toFils(balance.credited) + toFils(balance.discount);
      }
      return [
        customer.id,
        {
          code: customer.customerCode,
          address: customer.address,
          taxNumber: customer.taxNumber,
          jobCards: customer._count.jobCards,
          lastVisit: customer.jobCards[0]?.openedAt ?? null,
          invoices: customer.invoices.length,
          invoiced: filsToString(invoiced),
          paid: filsToString(paid),
          advances: filsToString(advances),
          credits: filsToString(credits),
          journal: signedString(journal.get(customer.id) ?? 0),
          // What they owe on invoices, plus what manual journal entries put on their account.
          owed: signedString(owed + (journal.get(customer.id) ?? 0)),
        },
      ];
    }),
  );
}

// ── Vehicles ─────────────────────────────────────────────────────────────────

export interface VehicleDetails {
  jobCards: number;
  lastVisit: Date | null;
  added: Date | null;
}

export const NO_VEHICLE_DETAILS: VehicleDetails = { jobCards: 0, lastVisit: null, added: null };

export async function vehicleDetails(organizationId: string, ids: string[]) {
  const vehicles = await prisma.vehicle.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true,
      createdAt: true,
      _count: { select: { jobCards: true } },
      jobCards: { orderBy: { openedAt: 'desc' }, take: 1, select: { openedAt: true } },
    },
  });
  return new Map(
    vehicles.map((vehicle) => [
      vehicle.id,
      {
        jobCards: vehicle._count.jobCards,
        lastVisit: vehicle.jobCards[0]?.openedAt ?? null,
        added: vehicle.createdAt,
      },
    ]),
  );
}

// ── Parts ────────────────────────────────────────────────────────────────────

export interface PartDetails {
  description: string | null;
}

export const NO_PART_DETAILS: PartDetails = { description: null };

export async function partDetails(organizationId: string, ids: string[]) {
  const parts = await prisma.part.findMany({
    where: { organizationId, id: { in: ids } },
    select: { id: true, description: true },
  });
  return new Map(parts.map((part) => [part.id, { description: part.description }]));
}

// ── Job cards ────────────────────────────────────────────────────────────────

export interface JobCardDetails {
  technician: string;
  receivedBy: string;
  quotations: string;
  quotationTotal: string;
  invoice: string;
  invoiceTotal: string;
  paid: string;
  balance: string;
  delivered: Date | null;
  deliveredBy: string;
}

export const NO_JOB_CARD_DETAILS: JobCardDetails = {
  technician: '',
  receivedBy: '',
  quotations: '',
  quotationTotal: '',
  invoice: '',
  invoiceTotal: '',
  paid: '',
  balance: '',
  delivered: null,
  deliveredBy: '',
};

export async function jobCardDetails(organizationId: string, ids: string[]) {
  const jobs = await prisma.jobCard.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true,
      deliveredAt: true,
      createdBy: { select: { fullName: true } },
      deliveredBy: { select: { fullName: true } },
      assignments: {
        where: { unassignedAt: null },
        orderBy: [{ assignmentRole: 'asc' }, { assignedAt: 'asc' }],
        select: { employee: { select: { firstName: true, lastName: true } } },
      },
      // The current version of each quotation that was sent or decided.
      estimates: {
        where: { status: { notIn: ['DRAFT', 'REJECTED', 'EXPIRED'] }, isCurrent: true },
        orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
        select: { estimateNumber: true, totalAmount: true },
      },
      invoices: {
        where: { status: COUNTED_INVOICES },
        take: 1,
        select: { invoiceNumber: true, ...SETTLEMENT_FIELDS },
      },
    },
  });
  return new Map(
    jobs.map((job) => {
      const invoice = job.invoices[0];
      const balance = invoice ? invoiceBalance(invoice) : null;
      const quoted = job.estimates.reduce((sum, e) => sum + toFils(e.totalAmount.toString()), 0);
      return [
        job.id,
        {
          technician: job.assignments.map((a) => employeeName(a.employee)).join(', '),
          receivedBy: job.createdBy.fullName,
          quotations: job.estimates.map((e) => e.estimateNumber).join(', '),
          quotationTotal: job.estimates.length > 0 ? filsToString(quoted) : '',
          invoice: invoice?.invoiceNumber ?? '',
          invoiceTotal: balance?.total ?? '',
          paid: balance?.paid ?? '',
          balance: balance?.balance ?? '',
          delivered: job.deliveredAt,
          deliveredBy: job.deliveredBy?.fullName ?? '',
        },
      ];
    }),
  );
}

// ── Quotations ───────────────────────────────────────────────────────────────

export interface QuotationDetails {
  kind: string;
  subtotal: string;
  discount: string;
  vat: string;
  preparedBy: string;
  decision: string;
  decidedAt: Date | null;
  vehicle: string;
}

export const NO_QUOTATION_DETAILS: QuotationDetails = {
  kind: '',
  subtotal: '',
  discount: '',
  vat: '',
  preparedBy: '',
  decision: '',
  decidedAt: null,
  vehicle: '',
};

const DECISION = {
  APPROVED: 'Approved',
  PARTIALLY_APPROVED: 'Partly approved',
  REJECTED: 'Declined',
} as const;

export async function quotationDetails(organizationId: string, ids: string[]) {
  const estimates = await prisma.estimate.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true,
      kind: true,
      subtotal: true,
      discountAmount: true,
      taxAmount: true,
      preparedBy: { select: { fullName: true } },
      vehicle: { select: { make: true, model: true, year: true } },
      approvals: {
        orderBy: { decidedAt: 'desc' },
        take: 1,
        select: { status: true, decidedAt: true },
      },
    },
  });
  return new Map(
    estimates.map((e) => {
      const decision = e.approvals[0];
      return [
        e.id,
        {
          kind: e.kind === 'ADDITIONAL' ? 'Additional work' : 'Original',
          subtotal: e.subtotal.toString(),
          discount: e.discountAmount.toString(),
          vat: e.taxAmount.toString(),
          preparedBy: e.preparedBy.fullName,
          decision: decision ? DECISION[decision.status] : '',
          decidedAt: decision?.decidedAt ?? null,
          vehicle: e.vehicle
            ? [e.vehicle.make, e.vehicle.model, e.vehicle.year].filter(Boolean).join(' ')
            : '',
        },
      ];
    }),
  );
}

// ── Invoices ─────────────────────────────────────────────────────────────────

export interface InvoiceDetails {
  status: string;
  customerTaxNumber: string;
  vehicle: string;
  credited: string;
  advanceApplied: string;
  discountAfter: string;
  roundOff: string;
  lastPayment: Date | null;
  issuedBy: string;
  notes: string;
  voidReason: string;
}

export const NO_INVOICE_DETAILS: InvoiceDetails = {
  status: '',
  customerTaxNumber: '',
  vehicle: '',
  credited: '',
  advanceApplied: '',
  discountAfter: '',
  roundOff: '',
  lastPayment: null,
  issuedBy: '',
  notes: '',
  voidReason: '',
};

const INVOICE_STATUS: Record<string, string> = {
  DRAFT: 'Draft',
  ISSUED: 'Issued',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid',
  VOID: 'Void',
  CANCELLED: 'Cancelled',
};

export async function invoiceDetails(organizationId: string, ids: string[]) {
  const invoices = await prisma.invoice.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true,
      status: true,
      customerTaxNumber: true,
      creditedAmount: true,
      advanceAppliedAmount: true,
      settlementDiscount: true,
      roundingAdjustment: true,
      notes: true,
      voidReason: true,
      customer: { select: { taxNumber: true } },
      vehicle: { select: { make: true, model: true, year: true } },
      issuedBy: { select: { fullName: true } },
      createdBy: { select: { fullName: true } },
      payments: {
        where: { status: 'COMPLETED', reversalOfPaymentId: null },
        select: { receivedAt: true },
      },
    },
  });
  return new Map(
    invoices.map((invoice) => [
      invoice.id,
      {
        status: INVOICE_STATUS[invoice.status] ?? invoice.status,
        // As printed on the invoice; the customer's current TRN for older ones.
        customerTaxNumber: invoice.customerTaxNumber ?? invoice.customer.taxNumber ?? '',
        vehicle: invoice.vehicle
          ? [invoice.vehicle.make, invoice.vehicle.model, invoice.vehicle.year]
              .filter(Boolean)
              .join(' ')
          : '',
        credited: invoice.creditedAmount.toString(),
        advanceApplied: invoice.advanceAppliedAmount.toString(),
        discountAfter: invoice.settlementDiscount.toString(),
        roundOff: invoice.roundingAdjustment.toString(),
        lastPayment: latest(invoice.payments.map((p) => p.receivedAt)),
        issuedBy: (invoice.issuedBy ?? invoice.createdBy).fullName,
        notes: invoice.notes ?? '',
        voidReason: invoice.voidReason ?? '',
      },
    ]),
  );
}

// ── Receipts (customer payments) ─────────────────────────────────────────────

export interface PaymentDetails {
  account: string;
  customerMobile: string;
  registration: string;
}

export const NO_PAYMENT_DETAILS: PaymentDetails = {
  account: '',
  customerMobile: '',
  registration: '',
};

export async function paymentDetails(organizationId: string, ids: string[]) {
  const payments = await prisma.payment.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true,
      account: { select: { accountCode: true, accountName: true } },
      invoice: {
        select: {
          customer: { select: { phone: true } },
          vehicle: { select: { plateNumber: true } },
        },
      },
    },
  });
  return new Map(
    payments.map((payment) => [
      payment.id,
      {
        account: payment.account
          ? `${payment.account.accountCode} ${payment.account.accountName}`
          : '',
        customerMobile: payment.invoice.customer.phone,
        registration: payment.invoice.vehicle?.plateNumber ?? '',
      },
    ]),
  );
}

// ── Purchases ────────────────────────────────────────────────────────────────

export interface PurchaseDetails {
  supplierTaxNumber: string;
  dueDate: Date | null;
  discount: string;
  roundOff: string;
  received: string;
  paid: string;
  owed: string;
  notes: string;
  createdBy: string;
  receivedBy: string;
}

export const NO_PURCHASE_DETAILS: PurchaseDetails = {
  supplierTaxNumber: '',
  dueDate: null,
  discount: '',
  roundOff: '',
  received: '',
  paid: '',
  owed: '',
  notes: '',
  createdBy: '',
  receivedBy: '',
};

export async function purchaseDetails(organizationId: string, ids: string[]) {
  const [purchases, defaultVat] = await Promise.all([
    prisma.purchase.findMany({
      where: { organizationId, id: { in: ids } },
      select: {
        id: true,
        dueDate: true,
        billDiscountAmount: true,
        notes: true,
        supplier: { select: { taxNumber: true } },
        createdBy: { select: { fullName: true } },
        receivedBy: { select: { fullName: true } },
        ...PURCHASE_BALANCE_SELECT,
      },
    }),
    resolveDefaultVatRate(organizationId),
  ]);
  return new Map(
    purchases.map((purchase) => {
      const balance = purchaseBalance(purchase, defaultVat);
      return [
        purchase.id,
        {
          supplierTaxNumber: purchase.supplier.taxNumber ?? '',
          dueDate: purchase.dueDate,
          discount: purchase.billDiscountAmount.toString(),
          roundOff: purchase.roundingAdjustment.toString(),
          received: filsToString(balance.receivedFils),
          paid: filsToString(balance.paidFils),
          owed: filsToString(Math.max(balance.receivedFils - balance.paidFils, 0)),
          notes: purchase.notes ?? '',
          createdBy: purchase.createdBy.fullName,
          receivedBy: purchase.receivedBy?.fullName ?? '',
        },
      ];
    }),
  );
}

// ── Stock movements ──────────────────────────────────────────────────────────

export interface MovementDetails {
  reference: string;
}

export const NO_MOVEMENT_DETAILS: MovementDetails = { reference: '' };

export async function movementDetails(organizationId: string, ids: string[]) {
  const movements = await prisma.inventoryTransaction.findMany({
    where: { organizationId, id: { in: ids } },
    select: {
      id: true,
      purchaseItem: {
        select: {
          purchase: { select: { purchaseNumber: true, supplier: { select: { name: true } } } },
        },
      },
      partUsage: { select: { jobCard: { select: { jobNumber: true } } } },
    },
  });
  return new Map(
    movements.map((movement) => {
      const purchase = movement.purchaseItem?.purchase;
      const job = movement.partUsage?.jobCard;
      return [
        movement.id,
        {
          reference: purchase
            ? `${purchase.purchaseNumber} · ${purchase.supplier.name}`
            : (job?.jobNumber ?? ''),
        },
      ];
    }),
  );
}
