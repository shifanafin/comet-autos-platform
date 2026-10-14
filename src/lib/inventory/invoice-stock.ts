import type { Prisma } from '@/generated/prisma/client';
import { DomainError } from '@/lib/errors';
import { formatMilli, signedToMilli } from '@/lib/money';
import { getStockOnHand, postMovement } from '@/lib/inventory/stock';

/*
 * Stock follows the invoice.
 *
 * An invoice's PART lines name the catalogue part they sell (invoice_items
 * .part_id). While the invoice stands, that quantity is out of stock; once it
 * is void, it is back. This compares, part by part, what the invoice sells
 * now with what has already left stock for it (its SALE movements, signed),
 * and posts only the difference — so issuing, correcting a quantity,
 * removing a line and voiding are all the same rule, and running it twice
 * changes nothing.
 *
 * Movements point at the invoice, not its lines: editing an invoice replaces
 * its lines, and the movements must outlive them.
 *
 * The cost of what was sold is booked on the invoice's own entry, from the
 * cost decided on each line (lib/accounting/postings.ts). These movements
 * carry the quantity, and the same cost for the record.
 *
 * Lines billed from a job's repair records (part_usage_id) already left
 * stock when the part was fitted; old lines costed at a write-off
 * (cost_movement_id) left with it. Neither is counted again here.
 */

type Tx = Prisma.TransactionClient;

export async function syncInvoiceStock(
  tx: Tx,
  params: { organizationId: string; invoiceId: string; userId: string },
) {
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: params.invoiceId, organizationId: params.organizationId },
    select: {
      invoiceType: true,
      status: true,
      branchId: true,
      invoiceNumber: true,
      items: {
        select: {
          partId: true,
          partUsageId: true,
          costMovementId: true,
          quantity: true,
          unitCost: true,
        },
      },
    },
  });
  const live =
    invoice.invoiceType === 'TAX_INVOICE' &&
    !['DRAFT', 'VOID', 'CANCELLED'].includes(invoice.status);

  // What the invoice sells now, per part.
  const wanted = new Map<string, { milli: number; unitCost: string | null }>();
  if (live) {
    for (const item of invoice.items) {
      if (!item.partId || item.partUsageId || item.costMovementId) continue;
      const entry = wanted.get(item.partId) ?? { milli: 0, unitCost: null };
      entry.milli += signedToMilli(item.quantity);
      entry.unitCost = item.unitCost?.toString() ?? entry.unitCost;
      wanted.set(item.partId, entry);
    }
  }

  // What has already left stock for it, per part (SALE is negative out).
  const moved = await tx.inventoryTransaction.groupBy({
    by: ['partId'],
    where: { organizationId: params.organizationId, invoiceId: params.invoiceId, transactionType: 'SALE' },
    _sum: { quantity: true },
  });
  const out = new Map(moved.map((row) => [row.partId, -signedToMilli(row._sum.quantity)]));

  const parts = [...new Set([...wanted.keys(), ...out.keys()])].sort();
  for (const partId of parts) {
    const want = wanted.get(partId)?.milli ?? 0;
    const already = out.get(partId) ?? 0;
    const difference = want - already;
    if (difference === 0) continue;

    if (difference > 0) {
      const onHand = await getStockOnHand(tx, params.organizationId, invoice.branchId, partId);
      if (onHand < difference) {
        const part = await tx.part.findUniqueOrThrow({ where: { id: partId }, select: { name: true } });
        throw new DomainError(
          `Not enough “${part.name}” in stock: ${formatMilli(Math.max(onHand, 0))} on hand, this invoice needs ${formatMilli(difference)} more. Record its purchase first.`,
          'items',
        );
      }
    }
    await postMovement(tx, {
      organizationId: params.organizationId,
      branchId: invoice.branchId,
      partId,
      type: 'SALE',
      quantityMilli: -difference,
      unitCost: wanted.get(partId)?.unitCost ?? null,
      invoiceId: params.invoiceId,
      performedByUserId: params.userId,
      note:
        difference > 0
          ? `Sold on ${invoice.invoiceNumber}`
          : `Back to stock: ${invoice.invoiceNumber} ${live ? 'changed' : 'void'}`,
    });
  }
}
