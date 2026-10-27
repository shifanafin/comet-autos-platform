import type { Prisma } from '@/generated/prisma/client';
import { DomainError } from '@/lib/errors';
import { prisma } from '@/lib/prisma';
import { filsToString, signedToMilli, toFils } from '@/lib/money';
import { withNetQuantities } from '@/lib/inventory/stock';

/*
 * The parts on an invoice or a quotation, tied to the catalogue.
 *
 * A Parts line picked from the catalogue names the part it is (partId) and
 * what one of it cost (unitCost — decided by whoever writes the invoice, the
 * part's last purchase cost when left blank). That is what takes it out of
 * stock (lib/inventory/invoice-stock.ts) and books its cost of sales
 * (lib/accounting/postings.ts).
 *
 * Naming a part is never required (the owners, 26 Oct 2026: parts are often
 * bought only after the customer says yes). A line typed without one stays
 * as typed: it takes nothing out of stock and books no cost of sales — the
 * part's cost is wherever it was recorded as bought (an expense, a voucher).
 * Quotations work the same way, and a part they name is carried onto the
 * invoice.
 */

interface PartLine {
  itemType: string;
  description: string;
  partId?: string | null;
  unitCost?: string | null;
}

export async function resolvePartLines<Line extends PartLine>(
  tx: Prisma.TransactionClient,
  organizationId: string,
  lines: Line[],
  options: {
    /** Whether this Parts line must name a part (invoices: yes, but see above). */
    required: (line: Line, index: number) => boolean;
    /** Parts already on the document: still accepted if since made inactive. */
    keep?: Set<string>;
  },
): Promise<Line[]> {
  const ids = [
    ...new Set(lines.map((line) => line.partId).filter((id): id is string => Boolean(id))),
  ];
  const parts = ids.length
    ? await tx.part.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true, name: true, isActive: true, defaultCostPrice: true },
      })
    : [];
  const byId = new Map(parts.map((part) => [part.id, part]));

  return lines.map((line, index) => {
    const n = index + 1;
    if (line.itemType !== 'PART') return { ...line, partId: null, unitCost: null };
    if (!line.partId) {
      if (options.required(line, index)) {
        throw new DomainError(
          `Line ${n} (“${line.description}”): pick the part from the list — or add it, with where it was bought — so it comes out of stock.`,
          `items.${index}`,
        );
      }
      return { ...line, partId: null, unitCost: null };
    }
    const part = byId.get(line.partId);
    if (!part) {
      throw new DomainError(`Line ${n}: that part was not found. Pick it again.`, `items.${index}`);
    }
    if (!part.isActive && !options.keep?.has(part.id)) {
      throw new DomainError(
        `Line ${n}: “${part.name}” is no longer in use. Reactivate it or pick another part.`,
        `items.${index}`,
      );
    }
    const cost = line.unitCost || part.defaultCostPrice?.toString() || '';
    if (!cost) {
      throw new DomainError(
        `Line ${n}: enter what “${part.name}” cost — it has no purchase cost yet.`,
        `items.${index}`,
      );
    }
    return { ...line, partId: part.id, unitCost: filsToString(toFils(cost)) };
  });
}

/**
 * Parts lines that may stay without a part when an invoice is changed: the
 * ones billed from a job's repair records, and the ones that were already
 * without a part before (an invoice from before parts were tied to stock).
 */
export function unlinkedAllowed(
  previous: { id: string; partId: string | null; partUsageId: string | null }[],
) {
  const free = new Set(
    previous.filter((item) => item.partUsageId || !item.partId).map((item) => item.id),
  );
  return (line: { sourceId?: string }) => Boolean(line.sourceId && free.has(line.sourceId));
}

/**
 * The parts fitted on a job card through its repair records and not taken
 * back: they left stock when they were fitted, and their cost is booked on
 * the job's invoice. Billing that job, its Parts lines need not name a part,
 * and may not name one of these again.
 */
export async function partsFittedOnJob(
  tx: Prisma.TransactionClient,
  organizationId: string,
  jobCardId: string | null,
) {
  if (!jobCardId) return new Set<string>();
  const usages = await tx.partUsage.findMany({
    where: { organizationId, jobCardId },
    select: { id: true, partId: true, quantity: true },
  });
  const net = await withNetQuantities(tx, organizationId, usages);
  return new Set(net.filter((usage) => usage.netMilli > 0).map((usage) => usage.partId));
}

/** Refuses a Parts line that names a part already fitted through the job's repair records. */
export function assertNotFitted(
  lines: { partId?: string | null; description: string }[],
  fitted: Set<string>,
) {
  lines.forEach((line, index) => {
    if (line.partId && fitted.has(line.partId)) {
      throw new DomainError(
        `Line ${index + 1} (“${line.description}”): this part was fitted on the job card and already left stock then. Leave the line without a part.`,
        `items.${index}`,
      );
    }
  });
}

/** For the invoice screens: whether billing this job card leaves its Parts lines free of a part. */
export async function jobHasFittedParts(organizationId: string, jobCardId: string | null) {
  if (!jobCardId) return false;
  return (await partsFittedOnJob(prisma, organizationId, jobCardId)).size > 0;
}

/** For the edit screen: what an invoice already took out of stock, per part, in thousandths. */
export async function stockHeldByInvoice(organizationId: string, invoiceId: string) {
  const rows = await prisma.inventoryTransaction.groupBy({
    by: ['partId'],
    where: { organizationId, invoiceId, transactionType: 'SALE' },
    _sum: { quantity: true },
  });
  return Object.fromEntries(rows.map((row) => [row.partId, -signedToMilli(row._sum.quantity)]));
}
