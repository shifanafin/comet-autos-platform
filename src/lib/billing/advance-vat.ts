import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import { toFils } from '@/lib/money';

/*
 * VAT on customer advances — UAE: the date of supply is the earlier of the
 * work being done, the invoice, or the payment received. An advance is
 * payment received first, so VAT is due on it the day it is received, to
 * the extent of what was paid (FDL 8/2017 Art. 25–26). The amount paid
 * includes the VAT: AED 3,000 at 5% is 2,857.14 + 142.86.
 *
 * When the advance is later applied to the job's invoice (or paid back),
 * the VAT already accounted on that part is released, so the invoice's own
 * VAT is not counted a second time:
 *
 *   received   Dr money  A        Cr Customer advances  A − V   Cr Output VAT  V
 *   applied X  Dr Customer advances X − v   Dr Output VAT v   Cr Receivables X
 *   refunded R Dr Customer advances R − v   Dr Output VAT v   Cr money R
 *
 * v is worked out so the releases add up to exactly V once the advance is
 * used up: each movement releases share(used after it) − share(used before
 * it), share(c) = round(c × V ÷ A), in the order the movements happened. A
 * movement undone (reversed) drops out and the rest are worked out again —
 * every movement of the advance is re-booked whenever one changes
 * (lib/billing/advances.ts syncAdvanceMovements).
 *
 * Only advances recorded VAT_ON_RECEIPT carry any of this. Those taken
 * before it (PENDING_ACCOUNTANT_CONFIRMATION) and a workshop that is not
 * VAT-registered (VAT_ON_INVOICE) book no VAT on the advance.
 */

type Client = Prisma.TransactionClient | typeof prisma;

/** The VAT included in an amount paid, at a rate in percent ("5.00"), in fils. */
export function vatIncluded(amountFils: number, rate: string): number {
  const basis = Math.round(Number(rate) * 100); // 5.00% → 500
  if (!basis || amountFils <= 0) return 0;
  return Math.round((amountFils * basis) / (10_000 + basis));
}

/** A signed stored amount in fils. */
const signedFils = (value: { toString(): string }) => {
  const text = value.toString();
  return text.startsWith('-') ? -toFils(text.slice(1)) : toFils(text);
};

interface Movement {
  id: string;
  /** Signed: applied or refunded above zero, returned to the advance below. */
  fils: number;
  on: Date;
  createdAt: Date;
}

/** The VAT each standing movement releases, by id (fils, signed). */
export function vatReleases(
  advance: { amountFils: number; vatFils: number },
  movements: Movement[],
): Map<string, number> {
  const share = (used: number) => {
    const clamped = Math.min(Math.max(used, 0), advance.amountFils);
    return advance.amountFils > 0
      ? Math.round((clamped * advance.vatFils) / advance.amountFils)
      : 0;
  };
  const ordered = [...movements].sort(
    (a, b) =>
      a.on.getTime() - b.on.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const released = new Map<string, number>();
  let used = 0;
  for (const movement of ordered) {
    const after = used + movement.fils;
    released.set(movement.id, share(after) - share(used));
    used = after;
  }
  return released;
}

/**
 * For an advance that carries VAT on receipt: the VAT released by each of
 * its standing applications and refunds. Null when it carries none.
 */
export async function advanceVatReleases(client: Client, organizationId: string, advanceId: string) {
  const advance = await client.customerAdvance.findFirst({
    where: { id: advanceId, organizationId },
    select: {
      amount: true,
      vatAmount: true,
      vatTreatment: true,
      allocations: {
        where: { reversedAt: null },
        select: { id: true, amount: true, allocatedOn: true, createdAt: true },
      },
      refunds: {
        where: { reversedAt: null },
        select: { id: true, amount: true, refundedOn: true, createdAt: true },
      },
    },
  });
  if (!advance || advance.vatTreatment !== 'VAT_ON_RECEIPT') return null;
  const vatFils = toFils(advance.vatAmount.toString());
  if (vatFils === 0) return null;
  return vatReleases({ amountFils: toFils(advance.amount.toString()), vatFils }, [
    ...advance.allocations.map((row) => ({
      id: row.id,
      fils: signedFils(row.amount),
      on: row.allocatedOn,
      createdAt: row.createdAt,
    })),
    ...advance.refunds.map((row) => ({
      id: row.id,
      fils: toFils(row.amount.toString()),
      on: row.refundedOn,
      createdAt: row.createdAt,
    })),
  ]);
}

/**
 * For the VAT return: what advances add to and take off a period's
 * standard-rated supplies (Box 1) and output VAT — advances received in it,
 * less the parts of advances applied or refunded in it. Each row as positive
 * figures, with `sign` +1 (received) or −1 (applied, refunded, returned).
 */
export async function advanceVatInPeriod(
  organizationId: string,
  dates: { gte: Date; lte: Date },
) {
  const received = await prisma.customerAdvance.findMany({
    where: {
      organizationId,
      vatTreatment: 'VAT_ON_RECEIPT',
      status: { not: 'CANCELLED' },
      receivedOn: dates,
    },
    orderBy: [{ receivedOn: 'asc' }, { advanceNumber: 'asc' }],
    select: {
      id: true,
      advanceNumber: true,
      receivedOn: true,
      amount: true,
      vatAmount: true,
      customer: { select: { name: true } },
    },
  });
  const [allocations, refunds] = await Promise.all([
    prisma.customerAdvanceAllocation.findMany({
      where: {
        organizationId,
        reversedAt: null,
        allocatedOn: dates,
        advance: { vatTreatment: 'VAT_ON_RECEIPT', status: { not: 'CANCELLED' } },
      },
      select: {
        id: true,
        advanceId: true,
        amount: true,
        allocatedOn: true,
        advance: { select: { advanceNumber: true, customer: { select: { name: true } } } },
        invoice: { select: { invoiceNumber: true } },
      },
    }),
    prisma.customerAdvanceRefund.findMany({
      where: {
        organizationId,
        reversedAt: null,
        refundedOn: dates,
        advance: { vatTreatment: 'VAT_ON_RECEIPT', status: { not: 'CANCELLED' } },
      },
      select: {
        id: true,
        advanceId: true,
        amount: true,
        refundedOn: true,
        advance: { select: { advanceNumber: true, customer: { select: { name: true } } } },
      },
    }),
  ]);
  const releases = new Map<string, Map<string, number> | null>();
  const releaseOf = async (advanceId: string, id: string) => {
    if (!releases.has(advanceId)) {
      releases.set(advanceId, await advanceVatReleases(prisma, organizationId, advanceId));
    }
    return releases.get(advanceId)?.get(id) ?? 0;
  };

  const rows: {
    id: string;
    /** The advance it belongs to, for its link. */
    advanceId: string;
    number: string;
    date: Date;
    party: string;
    what: string;
    sign: 1 | -1;
    /** Fils, positive. */
    net: number;
    vat: number;
  }[] = received.map((advance) => {
    const amount = toFils(advance.amount.toString());
    const vat = toFils(advance.vatAmount.toString());
    return {
      id: advance.id,
      advanceId: advance.id,
      number: advance.advanceNumber,
      date: advance.receivedOn,
      party: advance.customer.name,
      what: 'Advance received',
      sign: 1,
      net: amount - vat,
      vat,
    };
  });
  for (const row of allocations) {
    const amount = signedFils(row.amount);
    const vat = await releaseOf(row.advanceId, row.id);
    // Applied (above zero) takes off; returned to the advance (below zero) adds back.
    rows.push({
      id: row.id,
      advanceId: row.advanceId,
      number: row.advance.advanceNumber,
      date: row.allocatedOn,
      party: row.advance.customer.name,
      what:
        amount >= 0
          ? `Applied to ${row.invoice.invoiceNumber}`
          : `Returned from ${row.invoice.invoiceNumber} by credit note`,
      sign: amount >= 0 ? -1 : 1,
      net: Math.abs(amount - vat),
      vat: Math.abs(vat),
    });
  }
  for (const row of refunds) {
    const amount = toFils(row.amount.toString());
    const vat = await releaseOf(row.advanceId, row.id);
    rows.push({
      id: row.id,
      advanceId: row.advanceId,
      number: row.advance.advanceNumber,
      date: row.refundedOn,
      party: row.advance.customer.name,
      what: 'Refunded',
      sign: -1,
      net: amount - vat,
      vat,
    });
  }
  rows.sort((a, b) => a.date.getTime() - b.date.getTime() || a.number.localeCompare(b.number));
  return {
    rows,
    /** Signed fils: what advances add to Box 1 and to output VAT this period. */
    netFils: rows.reduce((sum, row) => sum + row.sign * row.net, 0),
    vatFils: rows.reduce((sum, row) => sum + row.sign * row.vat, 0),
  };
}
