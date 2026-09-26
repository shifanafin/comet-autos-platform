import { prisma } from '@/lib/prisma';
import type { JobCardStatus } from '@/generated/prisma/enums';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { CLOSED_JOB_STATUSES, WORKFLOW_STAGES } from '@/lib/workshop/stages';
import { localDateString, localDayRange, parseCalendarDate } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import { invoiceBalance, paidFils } from '@/lib/billing/invoice';
import { getStockByPart, resolveInventoryBranch, stockState } from '@/lib/inventory/stock';

/*
 * Dashboard data. "Today" is the workshop's day in Dubai, whatever time zone
 * the server runs in. Money is summed exactly (fils) with the billing rules,
 * and stock uses the same rule as the inventory screens.
 *
 * Each section fetches independently so the page can stream them with
 * <Suspense>; the page wraps these in React cache() to share queries.
 */

// "Currently in the workshop" = not yet handed back to the customer.
const NOT_IN_WORKSHOP: JobCardStatus[] = CLOSED_JOB_STATUSES;

export async function getWorkshopFlow(organizationId: string) {
  const today = localDayRange();

  const [todaysAppointments, vehiclesCurrentlyIn, jobsByStatus] = await Promise.all([
    prisma.appointment.count({
      where: {
        organizationId,
        scheduledAt: { gte: today.start, lt: today.end },
        status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      },
    }),
    prisma.jobCard.count({ where: { organizationId, status: { notIn: NOT_IN_WORKSHOP } } }),
    prisma.jobCard.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
  ]);

  const statusCounts = new Map(jobsByStatus.map((row) => [row.status, row._count._all]));
  const count = (...statuses: JobCardStatus[]) =>
    statuses.reduce((sum, status) => sum + (statusCounts.get(status) ?? 0), 0);

  return {
    todaysAppointments,
    vehiclesCurrentlyIn,
    workflowStages: WORKFLOW_STAGES.map((stage) => ({
      ...stage,
      count: statusCounts.get(stage.status) ?? 0,
    })),
    waitingForApproval: count('WAITING_APPROVAL'),
    onHold: count('ON_HOLD'),
    /** The jobs that need someone to act, by what that action is. */
    actions: {
      toInspect: count('ARRIVED', 'INSPECTION'),
      toQuote: count('DIAGNOSIS', 'ESTIMATE'),
      waitingApproval: count('WAITING_APPROVAL'),
      approved: count('APPROVED'),
      inRepair: count('REPAIR'),
      qualityCheck: count('QUALITY_CHECK'),
      ready: count('READY'),
      awaitingPayment: count('INVOICED'),
      toDeliver: count('PAID'),
      onHold: count('ON_HOLD'),
    },
  };
}

/** Parts at or below their minimum at the user's branch — the same rule as the Parts screen. */
export async function getLowStockParts(user: AuthenticatedUser) {
  const branch = await resolveInventoryBranch(user);
  const [parts, stock] = await Promise.all([
    prisma.part.findMany({
      where: { organizationId: user.organizationId, isActive: true, reorderLevel: { not: null } },
      select: { id: true, name: true, sku: true, unitOfMeasure: true, reorderLevel: true },
    }),
    getStockByPart(user.organizationId, branch.id),
  ]);
  return parts
    .map((part) => {
      const onHandMilli = stock.get(part.id) ?? 0;
      return { ...part, onHandMilli, state: stockState(onHandMilli, part.reorderLevel) };
    })
    .filter((part) => part.state !== 'IN_STOCK')
    .sort((a, b) => a.onHandMilli - b.onHandMilli);
}

/**
 * Today's invoiced sales and collections, and what customers still owe.
 * Only unpaid / part-paid invoices (and their payments) are read for the
 * outstanding figure, and only today's payments for collections.
 */
export async function getFinanceSnapshot(organizationId: string) {
  const today = localDayRange();
  const [openInvoices, todaysInvoices, todaysPayments] = await Promise.all([
    prisma.invoice.findMany({
      where: { organizationId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
      select: {
        totalAmount: true,
        status: true,
        payments: {
          select: {
            id: true,
            amount: true,
            status: true,
            reversalOfPaymentId: true,
            receivedAt: true,
          },
        },
      },
    }),
    prisma.invoice.findMany({
      where: {
        organizationId,
        status: { in: ['ISSUED', 'PARTIALLY_PAID', 'PAID'] },
        issuedAt: { gte: today.start, lt: today.end },
      },
      select: { totalAmount: true },
    }),
    prisma.payment.findMany({
      where: { organizationId, receivedAt: { gte: today.start, lt: today.end } },
      select: { id: true, amount: true, status: true, reversalOfPaymentId: true },
    }),
  ]);

  const outstandingFils = openInvoices.reduce(
    (sum, invoice) => sum + toFils(invoiceBalance(invoice).balance),
    0,
  );
  return {
    todaysSales: filsToString(
      todaysInvoices.reduce((sum, invoice) => sum + toFils(invoice.totalAmount.toString()), 0),
    ),
    todaysInvoiceCount: todaysInvoices.length,
    todaysCollections: filsToString(paidFils(todaysPayments.filter((p) => !p.reversalOfPaymentId))),
    customerOutstanding: filsToString(outstandingFils),
    unpaidInvoices: openInvoices.length,
  };
}

/** Today's appointments in time order (Dubai day). */
export async function getTodaysAppointments(organizationId: string) {
  const today = localDayRange();
  return prisma.appointment.findMany({
    where: {
      organizationId,
      scheduledAt: { gte: today.start, lt: today.end },
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
    },
    orderBy: { scheduledAt: 'asc' },
    take: 8,
    select: {
      id: true,
      scheduledAt: true,
      status: true,
      notes: true,
      vehicle: { select: { plateNumber: true, make: true, model: true } },
      customer: { select: { name: true } },
    },
  });
}

/** Most recently opened job cards that are still in the workshop. */
export async function getRecentJobCards(organizationId: string, take = 6) {
  return prisma.jobCard.findMany({
    where: { organizationId, status: { notIn: NOT_IN_WORKSHOP } },
    orderBy: { openedAt: 'desc' },
    take,
    select: {
      id: true,
      jobNumber: true,
      status: true,
      openedAt: true,
      customer: { select: { name: true } },
      vehicle: { select: { plateNumber: true, make: true, model: true } },
    },
  });
}

/**
 * The three numbers the owner opens the app for: job cards still open,
 * quotations the customer has not answered, and invoices not yet paid.
 * Quotations count only the current version of each chain, and only while
 * they are still in date — an expired quotation is not waiting for anyone.
 */
export async function getDocumentCounts(organizationId: string) {
  // validUntil is a calendar date; compare it with today's date in Dubai.
  const today = parseCalendarDate(localDateString())!;
  const [openWorkOrders, quotationsAwaiting, draftQuotations, unpaidInvoices] = await Promise.all([
    prisma.jobCard.count({ where: { organizationId, status: { notIn: NOT_IN_WORKSHOP } } }),
    prisma.estimate.count({
      where: {
        organizationId,
        status: 'SENT',
        nextVersions: { none: {} },
        OR: [{ validUntil: null }, { validUntil: { gte: today } }],
      },
    }),
    prisma.estimate.count({
      where: { organizationId, status: 'DRAFT', kind: 'ORIGINAL', nextVersions: { none: {} } },
    }),
    prisma.invoice.count({
      where: { organizationId, status: { in: ['ISSUED', 'PARTIALLY_PAID'] } },
    }),
  ]);
  return { openWorkOrders, quotationsAwaiting, draftQuotations, unpaidInvoices };
}

export type ActivityKind = 'work_order' | 'quotation' | 'invoice' | 'payment';

export interface ActivityItem {
  kind: ActivityKind;
  id: string;
  href: string;
  number: string;
  customer: string;
  plateNumber: string | null;
  amount: string | null;
  at: Date;
}

/**
 * Everything created today, newest first — job cards opened, quotations
 * started, invoices issued and payments taken. Money rows are left out for
 * someone who may not see invoices.
 */
export async function getTodaysActivity(
  organizationId: string,
  options: { includeMoney: boolean; take?: number },
): Promise<ActivityItem[]> {
  const today = localDayRange();
  const window = { gte: today.start, lt: today.end };
  const take = options.take ?? 10;

  const [workOrders, quotations, invoices, payments] = await Promise.all([
    prisma.jobCard.findMany({
      where: { organizationId, openedAt: window },
      orderBy: { openedAt: 'desc' },
      take,
      select: {
        id: true,
        jobNumber: true,
        openedAt: true,
        customer: { select: { name: true } },
        vehicle: { select: { plateNumber: true } },
      },
    }),
    prisma.estimate.findMany({
      where: { organizationId, createdAt: window, kind: 'ORIGINAL' },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        estimateNumber: true,
        createdAt: true,
        totalAmount: true,
        customer: { select: { name: true } },
        vehicle: { select: { plateNumber: true } },
      },
    }),
    options.includeMoney
      ? prisma.invoice.findMany({
          where: { organizationId, issuedAt: window, status: { notIn: ['VOID', 'CANCELLED'] } },
          orderBy: { issuedAt: 'desc' },
          take,
          select: {
            id: true,
            invoiceNumber: true,
            issuedAt: true,
            totalAmount: true,
            customerName: true,
            customer: { select: { name: true } },
            vehicle: { select: { plateNumber: true } },
          },
        })
      : Promise.resolve([]),
    options.includeMoney
      ? prisma.payment.findMany({
          where: { organizationId, receivedAt: window, reversalOfPaymentId: null, status: 'COMPLETED' },
          orderBy: { receivedAt: 'desc' },
          take,
          select: {
            id: true,
            paymentNumber: true,
            receivedAt: true,
            amount: true,
            invoice: {
              select: {
                id: true,
                invoiceNumber: true,
                customerName: true,
                customer: { select: { name: true } },
                vehicle: { select: { plateNumber: true } },
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  const items: ActivityItem[] = [
    ...workOrders.map((job) => ({
      kind: 'work_order' as const,
      id: job.id,
      href: `/job-cards/${job.id}`,
      number: job.jobNumber,
      customer: job.customer.name,
      plateNumber: job.vehicle.plateNumber,
      amount: null,
      at: job.openedAt,
    })),
    ...quotations.map((quote) => ({
      kind: 'quotation' as const,
      id: quote.id,
      href: `/quotations/${quote.id}`,
      number: quote.estimateNumber,
      customer: quote.customer.name,
      plateNumber: quote.vehicle?.plateNumber ?? null,
      amount: quote.totalAmount.toString(),
      at: quote.createdAt,
    })),
    ...invoices.map((invoice) => ({
      kind: 'invoice' as const,
      id: invoice.id,
      href: `/finance/invoices/${invoice.id}`,
      number: invoice.invoiceNumber,
      customer: invoice.customerName ?? invoice.customer.name,
      plateNumber: invoice.vehicle?.plateNumber ?? null,
      amount: invoice.totalAmount.toString(),
      at: invoice.issuedAt!,
    })),
    ...payments.map((payment) => ({
      kind: 'payment' as const,
      id: payment.id,
      href: `/finance/invoices/${payment.invoice.id}`,
      number: payment.paymentNumber ?? payment.invoice.invoiceNumber,
      customer: payment.invoice.customerName ?? payment.invoice.customer.name,
      plateNumber: payment.invoice.vehicle?.plateNumber ?? null,
      amount: payment.amount.toString(),
      at: payment.receivedAt,
    })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, take);
}
