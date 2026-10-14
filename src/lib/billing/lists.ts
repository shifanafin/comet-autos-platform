import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { invoiceBalance, paidFils } from '@/lib/billing/invoice';
import { filsToString, toFils } from '@/lib/money';
import { PAYMENT_METHOD_LABEL } from '@/lib/documents/build';

/*
 * Read-only finance lists over what billing already records. Paid and
 * balance come from the billing rules (invoiceBalance) — nothing is
 * recalculated differently here.
 */

export type InvoiceFilter = '' | 'unpaid' | 'paid' | 'void';

export async function listInvoices(
  user: AuthenticatedUser,
  filters: { q?: string; status?: string },
  /** Rows to return. The screens show a page; an export asks for everything. */
  limit = 200,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
) {
  requirePermission(user, 'invoice.view');
  const q = filters.q?.trim();
  const status = (
    ['unpaid', 'paid', 'void'].includes(filters.status ?? '') ? filters.status : ''
  ) as InvoiceFilter;
  const where: Prisma.InvoiceWhereInput = {
    organizationId: user.organizationId,
    status:
      status === 'unpaid'
        ? { in: ['ISSUED', 'PARTIALLY_PAID'] }
        : status === 'paid'
          ? 'PAID'
          : status === 'void'
            ? 'VOID'
            : { notIn: ['DRAFT', 'VOID', 'CANCELLED'] },
    ...(q
      ? {
          OR: [
            { invoiceNumber: { contains: q, mode: 'insensitive' } },
            { customerName: { contains: q, mode: 'insensitive' } },
            { customer: { name: { contains: q, mode: 'insensitive' } } },
            { customer: { phone: { contains: q, mode: 'insensitive' } } },
            // The invoice's own vehicle, so one raised without a job card is found too.
            { vehicle: { plateNumber: { contains: q, mode: 'insensitive' } } },
            { jobCard: { jobNumber: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      // Newest number first, so the list follows the invoice sequence even when
      // an invoice is back-dated. Each type is its own series (INV-, PRO-, OB-):
      // tax invoices lead, opening balances — the oldest debts — come last.
      // Numbers are zero-padded within a series, so text order is number order.
      orderBy: [{ invoiceType: 'asc' }, { invoiceNumber: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        invoiceNumber: true,
        issueDate: true,
        dueDate: true,
        status: true,
        customerReference: true,
        discountAmount: true,
        subtotal: true,
        taxAmount: true,
        totalAmount: true,
        creditedAmount: true,
        advanceAppliedAmount: true,
        settlementDiscount: true,
        customerName: true,
        items: { select: { discountAmount: true } },
        payments: {
          select: {
            id: true,
            amount: true,
            status: true,
            reversalOfPaymentId: true,
            receivedAt: true,
          },
        },
        customer: { select: { name: true, phone: true } },
        vehicle: { select: { plateNumber: true, make: true, model: true } },
        jobCard: { select: { id: true, jobNumber: true } },
      },
    }),
    prisma.invoice.count({ where }),
  ]);
  // "Customers owe …" on the Unpaid filter counts every unpaid invoice matched.
  const owedFils =
    status === 'unpaid'
      ? (
          await prisma.invoice.findMany({
            where,
            select: {
              status: true,
              totalAmount: true,
              creditedAmount: true,
              advanceAppliedAmount: true,
              settlementDiscount: true,
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
          })
        ).reduce((sum, invoice) => sum + toFils(invoiceBalance(invoice).balance), 0)
      : 0;
  return {
    status,
    /** On the Unpaid filter: what every matched invoice still owes. */
    owed: filsToString(owedFils),
    /** Every invoice the search and filter match, not only the page shown. */
    total,
    invoices: invoices.map(({ payments, items, ...invoice }) => ({
      ...invoice,
      /** Everything taken off: the lines' own discounts and the bill discount. */
      totalDiscount: filsToString(
        items.reduce(
          (sum, item) => sum + toFils(item.discountAmount.toString()),
          toFils(invoice.discountAmount.toString()),
        ),
      ),
      balance: invoiceBalance({ ...invoice, payments }),
    })),
  };
}

/**
 * Which payments to list:
 *   received  money that stands — neither reversed nor a reversal (default);
 *   reversed  payments that were reversed, each with its reversal;
 *   all       every row, reversals included — the full trail, for exports.
 */
export type PaymentView = 'received' | 'reversed' | 'all';

/**
 * What a payment row is. A reversal cancels a payment without editing it:
 * the original stays on record as REVERSED, and the row that cancels it is
 * a REVERSAL — same amount, the opposite way.
 */
export type PaymentStanding = 'RECEIVED' | 'REVERSED' | 'REVERSAL';

export const PAYMENT_STANDING_LABEL: Record<PaymentStanding, string> = {
  RECEIVED: 'Received',
  REVERSED: 'Reversed',
  REVERSAL: 'Reversal',
};

export async function listPayments(
  user: AuthenticatedUser,
  filters: { q?: string; view?: PaymentView },
  limit = 200,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
) {
  requirePermission(user, 'payment.view');
  const q = filters.q?.trim();
  const view = filters.view ?? 'received';
  const where: Prisma.PaymentWhereInput = {
    organizationId: user.organizationId,
    ...(view === 'received' ? { reversalOfPaymentId: null, reversals: { none: {} } } : {}),
    ...(view === 'reversed' ? { reversals: { some: {} } } : {}),
    ...(q
      ? {
          OR: [
            { paymentNumber: { contains: q, mode: 'insensitive' } },
            { referenceNumber: { contains: q, mode: 'insensitive' } },
            { invoice: { invoiceNumber: { contains: q, mode: 'insensitive' } } },
            { invoice: { customerName: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  // The totals cover every row the search matches, not only the page shown.
  const [payments, total, sum] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        paymentNumber: true,
        amount: true,
        method: true,
        status: true,
        referenceNumber: true,
        notes: true,
        reversalOfPaymentId: true,
        receivedAt: true,
        receivedBy: { select: { fullName: true } },
        reversals: {
          select: {
            id: true,
            receivedAt: true,
            notes: true,
            receivedBy: { select: { fullName: true } },
          },
        },
        reversalOf: { select: { paymentNumber: true } },
        invoice: {
          select: {
            status: true,
            invoiceNumber: true,
            customerName: true,
            jobCard: { select: { id: true, jobNumber: true } },
          },
        },
      },
    }),
    prisma.payment.count({ where }),
    prisma.payment.aggregate({ where, _sum: { amount: true } }),
  ]);
  const matchedFils = toFils(sum._sum.amount?.toString() ?? '0');
  const rows = payments.map((payment) => {
    const standing: PaymentStanding = payment.reversalOfPaymentId
      ? 'REVERSAL'
      : payment.reversals.length > 0
        ? 'REVERSED'
        : 'RECEIVED';
    return {
      ...payment,
      standing,
      methodLabel: PAYMENT_METHOD_LABEL[payment.method],
      /** A reversal takes money back out: negative. */
      signedAmount: filsToString(
        (standing === 'REVERSAL' ? -1 : 1) * toFils(payment.amount.toString()),
      ),
      reversal: payment.reversals[0] ?? null,
    };
  });
  return {
    payments: rows,
    total,
    /** Money that stands, across every row the search matches. */
    totalShown:
      view === 'received' ? matchedFils : paidFils(payments.filter((p) => !p.reversalOfPaymentId)),
    /** What the reversed payments matched had come to. */
    totalReversed:
      view === 'reversed'
        ? matchedFils
        : rows
            .filter((row) => row.standing === 'REVERSED')
            .reduce((sum, row) => sum + toFils(row.amount.toString()), 0),
  };
}
