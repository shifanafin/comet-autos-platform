import type { Prisma } from '@/generated/prisma/client';
import type { InventoryTransactionType } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { DomainError, NotFoundError } from '@/lib/errors';
import { formatMilli, milliToString, signedToMilli } from '@/lib/money';
import { syncPosting } from '@/lib/accounting/journal';

/*
 * Stock follows the schema's ledger rule (Part / InventoryTransaction):
 * there is no stock counter. Stock on hand for a part at a branch is always
 * SUM(inventory_transactions.quantity), signed — positive in, negative out.
 * Every movement is a new ledger row; rows are never edited or deleted (a
 * database trigger refuses it). Mistakes are corrected with new rows: a
 * JOB_RETURN for a part taken back from a job, a REVERSAL for an adjustment.
 *
 * postMovement() is the only way stock moves. It locks the Part row first
 * (SELECT … FOR UPDATE), so concurrent movements of the same part are
 * serialized and the "enough stock?" check can't be raced into a negative
 * balance.
 */

export type StockState = 'IN_STOCK' | 'LOW' | 'OUT';

/** Out at zero or below; low at or below the part's reorder level. */
export function stockState(
  onHandMilli: number,
  reorderLevel: { toString(): string } | null | undefined,
): StockState {
  if (onHandMilli <= 0) return 'OUT';
  if (
    reorderLevel !== null &&
    reorderLevel !== undefined &&
    onHandMilli <= signedToMilli(reorderLevel)
  )
    return 'LOW';
  return 'IN_STOCK';
}

/** Signed thousandths → a decimal string Prisma stores exactly ("-2.500"). */
export function signedMilliToString(milli: number): string {
  return milli < 0 ? `-${milliToString(-milli)}` : milliToString(milli);
}

/** Stock on hand in integer thousandths of the part's unit. */
export async function getStockOnHand(
  client: Prisma.TransactionClient,
  organizationId: string,
  branchId: string,
  partId: string,
): Promise<number> {
  const result = await client.inventoryTransaction.aggregate({
    where: { organizationId, branchId, partId },
    _sum: { quantity: true },
  });
  return signedToMilli(result._sum.quantity);
}

/** Stock on hand for every part at a branch, in thousandths. */
export async function getStockByPart(
  organizationId: string,
  branchId: string,
  client: Prisma.TransactionClient = prisma,
): Promise<Map<string, number>> {
  const rows = await client.inventoryTransaction.groupBy({
    by: ['partId'],
    where: { organizationId, branchId },
    _sum: { quantity: true },
  });
  return new Map(rows.map((row) => [row.partId, signedToMilli(row._sum.quantity)]));
}

/** Locks the part row for the rest of the transaction; also proves it belongs to the organization. */
export async function lockPart(
  tx: Prisma.TransactionClient,
  organizationId: string,
  partId: string,
) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM parts WHERE id = ${partId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  if (rows.length === 0) throw new NotFoundError('part');
}

export interface MovementInput {
  organizationId: string;
  branchId: string;
  partId: string;
  type: InventoryTransactionType;
  /** Signed thousandths: positive into stock, negative out. Never zero. */
  quantityMilli: number;
  unitCost?: string | null;
  purchaseItemId?: string | null;
  partUsageId?: string | null;
  /** SALE: the invoice whose part lines moved it (lib/inventory/invoice-stock.ts). */
  invoiceId?: string | null;
  /** CUSTOMER_RETURN: the credit note the part came back on (lib/inventory/credit-note-stock.ts). */
  creditNoteId?: string | null;
  /** ADJUSTMENT: the stock count that found the difference. */
  stockCountId?: string | null;
  reversalOfTransactionId?: string | null;
  performedByUserId: string;
  note: string;
  /** The day it really happened, for goods recorded after they came in; blank: now. */
  at?: Date;
}

/**
 * Posts one stock movement to the ledger, in the caller's transaction.
 * Refuses any movement that would take stock at the branch below zero.
 */
export async function postMovement(tx: Prisma.TransactionClient, input: MovementInput) {
  if (!Number.isSafeInteger(input.quantityMilli) || input.quantityMilli === 0) {
    throw new DomainError('Quantity must be greater than zero.', 'quantity');
  }
  await lockPart(tx, input.organizationId, input.partId);

  if (input.quantityMilli < 0) {
    const onHand = await getStockOnHand(tx, input.organizationId, input.branchId, input.partId);
    if (onHand + input.quantityMilli < 0) {
      throw new DomainError(
        onHand <= 0
          ? 'This part is out of stock at this branch.'
          : `Only ${formatMilli(onHand)} in stock at this branch.`,
        'quantity',
      );
    }
  }

  const movement = await tx.inventoryTransaction.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      partId: input.partId,
      transactionType: input.type,
      quantity: signedMilliToString(input.quantityMilli),
      unitCost: input.unitCost ?? null,
      purchaseItemId: input.purchaseItemId ?? null,
      partUsageId: input.partUsageId ?? null,
      invoiceId: input.invoiceId ?? null,
      creditNoteId: input.creditNoteId ?? null,
      stockCountId: input.stockCountId ?? null,
      reversalOfTransactionId: input.reversalOfTransactionId ?? null,
      performedByUserId: input.performedByUserId,
      note: input.note,
      ...(input.at ? { createdAt: input.at } : {}),
    },
  });
  // Stock in or out of the workshop's value is booked now; a part fitted to
  // or taken back from a job changes the cost on that job's invoice instead.
  await syncPosting(tx, input.organizationId, 'STOCK_MOVEMENT', movement.id, input.performedByUserId);
  if (input.partUsageId) {
    const usage = await tx.partUsage.findUnique({
      where: { id: input.partUsageId },
      select: {
        jobCard: {
          select: {
            invoices: {
              where: { status: { notIn: ['DRAFT', 'VOID', 'CANCELLED'] } },
              select: { id: true },
            },
          },
        },
      },
    });
    for (const invoice of usage?.jobCard.invoices ?? []) {
      await syncPosting(tx, input.organizationId, 'INVOICE', invoice.id, input.performedByUserId);
    }
  }
  return movement;
}

/**
 * Issues stock to a job: one JOB_CONSUMPTION row linked to the PartUsage.
 * Must run in the same transaction as the PartUsage it records.
 */
export async function issueStockToJob(
  tx: Prisma.TransactionClient,
  params: {
    organizationId: string;
    branchId: string;
    partId: string;
    quantityMilli: number;
    unitCost: string;
    partUsageId: string;
    performedByUserId: string;
    note: string;
  },
) {
  if (params.quantityMilli <= 0)
    throw new DomainError('Quantity must be greater than zero.', 'quantity');
  return postMovement(tx, {
    organizationId: params.organizationId,
    branchId: params.branchId,
    partId: params.partId,
    type: 'JOB_CONSUMPTION',
    quantityMilli: -params.quantityMilli,
    unitCost: params.unitCost,
    partUsageId: params.partUsageId,
    performedByUserId: params.performedByUserId,
    note: params.note,
  });
}

/**
 * Attaches each part usage's returns and its net quantity (fitted minus
 * taken back), read from the ledger. The single rule every consumer —
 * repair progress, quality check, billing — uses for "how many were used".
 */
export async function withNetQuantities<T extends { id: string; quantity: { toString(): string } }>(
  client: Prisma.TransactionClient,
  organizationId: string,
  usages: T[],
) {
  const returns =
    usages.length === 0
      ? []
      : await client.inventoryTransaction.findMany({
          where: {
            organizationId,
            transactionType: 'JOB_RETURN',
            partUsageId: { in: usages.map((u) => u.id) },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            partUsageId: true,
            quantity: true,
            note: true,
            createdAt: true,
            performedBy: { select: { fullName: true } },
          },
        });
  return usages.map((usage) => {
    const own = returns.filter((r) => r.partUsageId === usage.id);
    const returnedMilli = own.reduce((sum, r) => sum + signedToMilli(r.quantity), 0);
    return {
      ...usage,
      returns: own.map((r) => ({
        quantityMilli: signedToMilli(r.quantity),
        note: r.note,
        createdAt: r.createdAt,
        by: r.performedBy?.fullName ?? null,
      })),
      returnedMilli,
      netMilli: signedToMilli(usage.quantity) - returnedMilli,
    };
  });
}

/** The branch whose stock the inventory screens show and change: the user's own, else the organization's first. */
export async function resolveInventoryBranch(
  user: AuthenticatedUser,
  client: Prisma.TransactionClient = prisma,
) {
  const branch = await client.branch.findFirst({
    where: user.primaryBranchId
      ? { id: user.primaryBranchId, organizationId: user.organizationId }
      : { organizationId: user.organizationId, isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true },
  });
  if (!branch) throw new DomainError('No branch is set up for this organization.');
  return branch;
}
