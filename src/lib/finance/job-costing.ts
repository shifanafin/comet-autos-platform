import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { getVatSettings } from '@/lib/tax';
import { filsToString, multiplyQuantity, milliToString, signedToMilli, toFils } from '@/lib/money';
import { withNetQuantities } from '@/lib/inventory/stock';
import { resolvePeriod, type ResolvedPeriod } from '@/lib/finance/dashboard';
import { parseCalendarDate } from '@/lib/format';
import { OPEN_JOB_STATUSES } from '@/lib/workshop/check-in';

/*
 * What a job cost the workshop, and what it made.
 *
 *   Sales         what the invoice billed, before VAT: after its discounts,
 *                 less credit notes against it and any discount given after.
 *   Parts         what the parts sold cost — each line at the cost decided on
 *                 it, parts fitted through the job card at what they cost —
 *                 less parts the customer brought back on a credit note.
 *   Other costs   expenses entered as a cost of this job: outside work,
 *                 towing, materials bought for it. Their VAT is left out when
 *                 the workshop reclaims it (it is not a cost then).
 *   Profit        sales − parts − other costs; margin = profit ÷ sales.
 *
 * The same figures the books hold (cost of sales on the invoice's entry; the
 * expenses on theirs) — gathered per job. A Parts line typed before parts
 * were tied to stock has no cost: it is counted, so the screen can say the
 * profit is overstated by it rather than show a profit that isn't there.
 *
 * Technicians' wages are not spread over jobs: they are paid by the month
 * whatever the jobs, and show in the profit and loss.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export interface JobCost {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: Date;
  customerName: string;
  jobCardId: string | null;
  jobNumber: string | null;
  vehicle: string | null;
  /** Fils. */
  salesFils: number;
  partsFils: number;
  otherFils: number;
  profitFils: number;
  /** Percent, one decimal; null when nothing was sold. */
  margin: number | null;
  /** Parts lines with no cost recorded (typed before parts were tied to stock). */
  uncostedLines: number;
  /** The expenses counted as its other costs. */
  expenses: {
    id: string;
    expenseNumber: string | null;
    description: string;
    vendorName: string | null;
    expenseDate: Date;
    costFils: number;
  }[];
}

const fils = (value: { toString(): string } | null | undefined) =>
  value ? toFils(value.toString()) : 0;
/** A signed stored amount ("-0.50") in fils. */
const signedFils = (value: { toString(): string } | null | undefined) => {
  const text = value?.toString() ?? '0';
  return text.startsWith('-') ? -toFils(text.slice(1)) : toFils(text);
};

const INVOICE_SELECT = {
  id: true,
  invoiceNumber: true,
  issueDate: true,
  customerName: true,
  subtotal: true,
  roundingAdjustment: true,
  settlementDiscount: true,
  jobCardId: true,
  customer: { select: { name: true } },
  vehicle: { select: { plateNumber: true, make: true, model: true } },
  jobCard: { select: { jobNumber: true } },
  items: {
    select: {
      id: true,
      itemType: true,
      partId: true,
      partUsageId: true,
      quantity: true,
      unitCost: true,
    },
  },
  creditNotes: {
    where: { status: 'ISSUED' as const },
    select: {
      subtotal: true,
      roundingAmount: true,
      items: { select: { returnedQuantity: true, unitCost: true } },
    },
  },
} as const;

type CostedInvoice = Prisma.InvoiceGetPayload<{ select: typeof INVOICE_SELECT }>;

/** The cost and profit of each invoice given, in a handful of queries whatever their number. */
async function costInvoices(
  client: Client,
  organizationId: string,
  invoices: CostedInvoice[],
): Promise<JobCost[]> {
  if (invoices.length === 0) return [];
  const jobCardIds = [...new Set(invoices.flatMap((i) => (i.jobCardId ? [i.jobCardId] : [])))];
  const invoiceIds = invoices.map((invoice) => invoice.id);
  const [usages, expenses, vat] = await Promise.all([
    jobCardIds.length
      ? client.partUsage.findMany({
          where: { organizationId, jobCardId: { in: jobCardIds } },
          select: { id: true, jobCardId: true, quantity: true, unitCost: true },
        })
      : Promise.resolve([]),
    client.expense.findMany({
      where: {
        organizationId,
        status: 'RECORDED',
        OR: [
          { invoiceId: { in: invoiceIds } },
          ...(jobCardIds.length ? [{ jobCardId: { in: jobCardIds } }] : []),
        ],
      },
      orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        expenseNumber: true,
        description: true,
        vendorName: true,
        expenseDate: true,
        amount: true,
        taxAmount: true,
        invoiceId: true,
        jobCardId: true,
      },
    }),
    getVatSettings(organizationId, client as Prisma.TransactionClient),
  ]);
  const fitted = await withNetQuantities(client, organizationId, usages);

  return invoices.map((invoice) => {
    // Sales, before VAT, after everything taken off it since.
    const credited = invoice.creditNotes.reduce(
      (sum, note) => sum + fils(note.subtotal) + signedFils(note.roundingAmount),
      0,
    );
    const salesFils =
      fils(invoice.subtotal) +
      signedFils(invoice.roundingAdjustment) -
      credited -
      fils(invoice.settlementDiscount);

    // Parts: sold off its own lines, fitted through the job card, less returns.
    let partsFils = 0;
    let uncostedLines = 0;
    for (const item of invoice.items) {
      if (item.itemType !== 'PART' || item.partUsageId) continue;
      if (item.partId && item.unitCost) {
        partsFils += multiplyQuantity(item.quantity.toString(), item.unitCost.toString());
      } else {
        uncostedLines += 1;
      }
    }
    for (const usage of fitted) {
      if (usage.jobCardId !== invoice.jobCardId || usage.netMilli <= 0) continue;
      partsFils += multiplyQuantity(milliToString(usage.netMilli), usage.unitCost.toString());
    }
    for (const note of invoice.creditNotes) {
      for (const item of note.items) {
        if (!item.returnedQuantity || !item.unitCost) continue;
        if (signedToMilli(item.returnedQuantity) <= 0) continue;
        partsFils -= multiplyQuantity(item.returnedQuantity.toString(), item.unitCost.toString());
      }
    }

    // Other costs entered against this job; reclaimable VAT is not a cost.
    const own = expenses.filter(
      (expense) =>
        expense.invoiceId === invoice.id ||
        (invoice.jobCardId !== null && expense.jobCardId === invoice.jobCardId),
    );
    const costed = own.map((expense) => ({
      id: expense.id,
      expenseNumber: expense.expenseNumber,
      description: expense.description,
      vendorName: expense.vendorName,
      expenseDate: expense.expenseDate,
      costFils: fils(expense.amount) + (vat.isVatRegistered ? 0 : fils(expense.taxAmount)),
    }));
    const otherFils = costed.reduce((sum, expense) => sum + expense.costFils, 0);

    const profitFils = salesFils - partsFils - otherFils;
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      issueDate: invoice.issueDate,
      customerName: invoice.customerName ?? invoice.customer.name,
      jobCardId: invoice.jobCardId,
      jobNumber: invoice.jobCard?.jobNumber ?? null,
      vehicle: invoice.vehicle
        ? [invoice.vehicle.plateNumber, invoice.vehicle.make, invoice.vehicle.model]
            .filter(Boolean)
            .join(' · ')
        : null,
      salesFils,
      partsFils,
      otherFils,
      profitFils,
      margin: salesFils > 0 ? Math.round((profitFils * 1000) / salesFils) / 10 : null,
      uncostedLines,
      expenses: costed,
    };
  });
}

/** Whether this user may see what jobs cost and made. */
export const canSeeJobProfit = (user: AuthenticatedUser) => hasPermission(user, 'accounting.view');

/** One invoice's cost and profit (null for a draft, void or pro-forma). */
export async function getJobCost(user: AuthenticatedUser, invoiceId: string) {
  requirePermission(user, 'accounting.view');
  const invoice = await prisma.invoice.findFirst({
    where: {
      id: invoiceId,
      organizationId: user.organizationId,
      invoiceType: 'TAX_INVOICE',
      status: { notIn: ['DRAFT', 'VOID', 'CANCELLED'] },
    },
    select: INVOICE_SELECT,
  });
  if (!invoice) return null;
  const [cost] = await costInvoices(prisma, user.organizationId, [invoice]);
  return cost;
}

/** Every invoice issued in a period, costed, with the totals — the job profit report. */
export async function getJobProfitReport(
  user: AuthenticatedUser,
  input: { period?: string; from?: string; to?: string },
) {
  requirePermission(user, 'accounting.view');
  const period: ResolvedPeriod = resolvePeriod(input);
  const invoices = await prisma.invoice.findMany({
    where: {
      organizationId: user.organizationId,
      invoiceType: 'TAX_INVOICE',
      status: { notIn: ['DRAFT', 'VOID', 'CANCELLED'] },
      issueDate: { gte: parseCalendarDate(period.from)!, lte: parseCalendarDate(period.to)! },
    },
    orderBy: [{ issueDate: 'desc' }, { invoiceNumber: 'desc' }],
    select: INVOICE_SELECT,
  });
  const jobs = await costInvoices(prisma, user.organizationId, invoices);
  const sum = (pick: (job: JobCost) => number) => jobs.reduce((total, job) => total + pick(job), 0);
  const salesFils = sum((job) => job.salesFils);
  const profitFils = sum((job) => job.profitFils);
  return {
    period,
    jobs,
    totals: {
      sales: filsToString(salesFils),
      parts: filsToString(sum((job) => job.partsFils)),
      other: filsToString(sum((job) => job.otherFils)),
      profit: filsToString(Math.abs(profitFils)),
      profitNegative: profitFils < 0,
      margin: salesFils > 0 ? Math.round((profitFils * 1000) / salesFils) / 10 : null,
      uncostedJobs: jobs.filter((job) => job.uncostedLines > 0).length,
    },
  };
}

export type JobProfitReport = Awaited<ReturnType<typeof getJobProfitReport>>;

export interface JobChoice {
  /** "card:<id>" or "invoice:<id>" — the expense form's `forJob`. */
  value: string;
  label: string;
  hint: string;
}

/**
 * The jobs an expense can be filed against: job cards from the last six
 * months (and any still open), and invoices from them billed without a job
 * card. An invoice billing a job card is offered as that job card.
 */
export async function listJobChoices(user: AuthenticatedUser): Promise<JobChoice[]> {
  const since = new Date(Date.now() - 183 * 86_400_000);
  const [cards, invoices] = await Promise.all([
    prisma.jobCard.findMany({
      where: {
        organizationId: user.organizationId,
        OR: [{ createdAt: { gte: since } }, { status: { in: OPEN_JOB_STATUSES } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        id: true,
        jobNumber: true,
        customer: { select: { name: true } },
        vehicle: { select: { plateNumber: true } },
        invoices: {
          where: { status: { notIn: ['VOID', 'CANCELLED'] } },
          select: { invoiceNumber: true },
        },
      },
    }),
    prisma.invoice.findMany({
      where: {
        organizationId: user.organizationId,
        invoiceType: 'TAX_INVOICE',
        jobCardId: null,
        status: { notIn: ['DRAFT', 'VOID', 'CANCELLED'] },
        issueDate: { gte: since },
      },
      orderBy: [{ issueDate: 'desc' }, { invoiceNumber: 'desc' }],
      take: 300,
      select: {
        id: true,
        invoiceNumber: true,
        customerName: true,
        customer: { select: { name: true } },
        vehicle: { select: { plateNumber: true } },
      },
    }),
  ]);
  return [
    ...invoices.map((invoice) => ({
      value: `invoice:${invoice.id}`,
      label: `${invoice.invoiceNumber} — ${invoice.customerName ?? invoice.customer.name}`,
      hint: invoice.vehicle?.plateNumber ?? '',
    })),
    ...cards.map((card) => ({
      value: `card:${card.id}`,
      label: `${card.jobNumber}${card.invoices[0] ? ` (${card.invoices[0].invoiceNumber})` : ''} — ${card.customer.name}`,
      hint: card.vehicle.plateNumber,
    })),
  ];
}
