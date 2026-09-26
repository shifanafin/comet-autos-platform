import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { InventoryTransactionType } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { resolveDefaultVatRate } from '@/lib/tax';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { formatMilli, milliToString, signedToMilli, toMilli } from '@/lib/money';
import { ADJUSTMENT_REASONS, MOVEMENT_LABEL } from '@/lib/inventory/labels';
import {
  getStockByPart,
  getStockOnHand,
  lockPart,
  postMovement,
  resolveInventoryBranch,
  stockState,
  type StockState,
} from '@/lib/inventory/stock';

/*
 * Parts catalogue. Stock is never stored on the part: it is read from the
 * ledger (lib/inventory/stock.ts) for the user's branch. Changing stock
 * always posts a ledger movement — opening stock when a part is created,
 * an adjustment with a reason, or a reversal of an earlier adjustment.
 */

const money = (label: string) =>
  z
    .string({ error: `Enter the ${label}.` })
    .trim()
    .min(1, `Enter the ${label}.`)
    .refine(
      (value) => /^\d+(\.\d{1,2})?$/.test(value),
      `The ${label} must be an amount like 45 or 45.50.`,
    )
    .refine((value) => Number(value) <= 1_000_000, `The ${label} is not realistic.`);

const optionalQuantity = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || /^\d+(\.\d{1,3})?$/.test(value),
      `${label} must be a number (up to 3 decimals).`,
    )
    .refine((value) => !value || Number(value) <= 1_000_000, `${label} is not realistic.`);

const partSchema = z.object({
  sku: z
    .string({ error: 'Enter the part number / SKU.' })
    .trim()
    .min(1, 'Enter the part number / SKU.')
    .max(40, 'Keep the part number under 40 characters.')
    .transform((value) => value.toUpperCase().replace(/\s+/g, ' '))
    .refine(
      (value) => /^[A-Z0-9][A-Z0-9 ._\-/]*$/.test(value),
      'Use letters, numbers, spaces and - . _ / only.',
    ),
  name: z.string({ error: 'Enter the part name.' }).trim().min(2, 'Enter the part name.').max(120),
  category: z.string().trim().max(60, 'Keep the category under 60 characters.').optional(),
  description: z.string().trim().max(500).optional(),
  preferredSupplierId: z.union([z.literal(''), z.uuid()]).optional(),
  unitOfMeasure: z
    .string({ error: 'Enter the unit.' })
    .trim()
    .min(1, 'Enter the unit (e.g. piece, litre, set).')
    .max(20),
  costPrice: money('cost price'),
  sellingPrice: money('selling price'),
  taxRate: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || (/^\d+(\.\d{1,2})?$/.test(value) && Number(value) <= 100),
      'VAT must be a percentage between 0 and 100.',
    ),
  reorderLevel: optionalQuantity('Minimum stock'),
});

const createPartSchema = partSchema.extend({ openingStock: optionalQuantity('Opening stock') });
const updatePartSchema = partSchema.extend({ isActive: z.enum(['true', 'false']).optional() });

export type PartInput = z.input<typeof createPartSchema>;

async function requireSupplier(
  tx: Prisma.TransactionClient,
  organizationId: string,
  supplierId: string | null,
) {
  if (!supplierId) return null;
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, organizationId },
    select: { id: true },
  });
  if (!supplier) throw new DomainError('Choose a supplier from the list.', 'preferredSupplierId');
  return supplier.id;
}

/** Reuses an existing category's spelling when only the letter case differs. */
async function canonicalCategory(
  tx: Prisma.TransactionClient,
  organizationId: string,
  category: string | null,
) {
  if (!category) return null;
  const existing = await tx.part.findFirst({
    where: { organizationId, category: { equals: category, mode: 'insensitive' } },
    select: { category: true },
  });
  return existing?.category ?? category;
}

async function assertSkuFree(
  tx: Prisma.TransactionClient,
  organizationId: string,
  sku: string,
  exceptPartId?: string,
) {
  const clash = await tx.part.findFirst({
    where: {
      organizationId,
      sku: { equals: sku, mode: 'insensitive' },
      ...(exceptPartId ? { id: { not: exceptPartId } } : {}),
    },
    select: { name: true },
  });
  if (clash) throw new DomainError(`Part number ${sku} is already used by “${clash.name}”.`, 'sku');
}

/** An empty VAT rate takes the organization's default — never a literal rate. */
function partData(input: z.infer<typeof partSchema>, defaultVatRate: string) {
  return {
    sku: input.sku,
    name: input.name,
    description: emptyToNull(input.description),
    unitOfMeasure: input.unitOfMeasure.toLowerCase(),
    defaultCostPrice: input.costPrice,
    defaultSellingPrice: input.sellingPrice,
    defaultTaxRate: input.taxRate || defaultVatRate,
    reorderLevel: input.reorderLevel ? input.reorderLevel : null,
  };
}

/** Creates a part; an opening quantity is posted to the ledger as OPENING_STOCK in the same transaction. */
export async function createPart(
  user: AuthenticatedUser,
  rawInput: unknown,
  /** Join the caller's transaction (a bulk import) instead of opening one. */
  client?: Prisma.TransactionClient,
) {
  const input = parseInput(createPartSchema, rawInput);
  requirePermission(user, 'inventory.manage');

  const run = async (tx: Prisma.TransactionClient) => {
    await claimRequestKey(tx, user, rawInput, 'part.create');
    const branch = await resolveInventoryBranch(user, tx);
    await assertSkuFree(tx, user.organizationId, input.sku);
    const part = await tx.part.create({
      data: {
        organizationId: user.organizationId,
        ...partData(input, await resolveDefaultVatRate(user.organizationId, tx)),
        category: await canonicalCategory(tx, user.organizationId, emptyToNull(input.category)),
        preferredSupplierId: await requireSupplier(
          tx,
          user.organizationId,
          emptyToNull(input.preferredSupplierId),
        ),
      },
    });
    const openingMilli = input.openingStock ? toMilli(input.openingStock) : 0;
    const opening =
      openingMilli > 0
        ? await postMovement(tx, {
            organizationId: user.organizationId,
            branchId: branch.id,
            partId: part.id,
            type: 'OPENING_STOCK',
            quantityMilli: openingMilli,
            unitCost: input.costPrice,
            performedByUserId: user.id,
            note: 'Opening stock',
          })
        : null;
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      actorUserId: user.id,
      action: 'part.created',
      entityType: 'Part',
      entityId: part.id,
      afterData: {
        sku: part.sku,
        name: part.name,
        openingStock: opening ? milliToString(openingMilli) : null,
      },
      metadata: opening ? { inventoryTransactionId: opening.id } : undefined,
    });
    await settleRequestKey(tx, user, rawInput, part.id);
    return part;
  };
  return client ? run(client) : prisma.$transaction(run);
}

/** Edits catalogue details. Stock is never edited here — only through ledger movements. */
export async function updatePart(user: AuthenticatedUser, partId: string, rawInput: unknown) {
  const input = parseInput(updatePartSchema, rawInput);
  requirePermission(user, 'inventory.manage');

  return prisma.$transaction(async (tx) => {
    await lockPart(tx, user.organizationId, partId);
    const before = await tx.part.findUniqueOrThrow({ where: { id: partId } });
    await assertSkuFree(tx, user.organizationId, input.sku, partId);
    const part = await tx.part.update({
      where: { id: partId },
      data: {
        ...partData(input, await resolveDefaultVatRate(user.organizationId, tx)),
        category: await canonicalCategory(tx, user.organizationId, emptyToNull(input.category)),
        preferredSupplierId: await requireSupplier(
          tx,
          user.organizationId,
          emptyToNull(input.preferredSupplierId),
        ),
        isActive: input.isActive ? input.isActive === 'true' : before.isActive,
      },
    });
    const fields = [
      'sku',
      'name',
      'category',
      'description',
      'unitOfMeasure',
      'defaultCostPrice',
      'defaultSellingPrice',
      'defaultTaxRate',
      'reorderLevel',
      'preferredSupplierId',
      'isActive',
    ] as const;
    const changed = fields.filter((f) => String(before[f] ?? '') !== String(part[f] ?? ''));
    if (changed.length > 0) {
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'part.updated',
        entityType: 'Part',
        entityId: part.id,
        beforeData: Object.fromEntries(changed.map((f) => [f, before[f]?.toString() ?? null])),
        afterData: Object.fromEntries(changed.map((f) => [f, part[f]?.toString() ?? null])),
      });
    }
    return part;
  });
}

/**
 * Deletes a part from the catalogue.
 *
 * A part that was never used — no quotation, purchase, job or stock
 * movement names it — is removed outright; the audit log keeps what it was.
 * A part with history is archived instead (inactive: out of the pickers,
 * still on every document that used it, and back with Edit → Active). It is
 * refused while stock is still on hand, which would vanish from the count,
 * or while an open purchase is waiting for it.
 */
export async function deletePart(
  user: AuthenticatedUser,
  partId: string,
): Promise<{ outcome: 'deleted' | 'archived' }> {
  requirePermission(user, 'inventory.manage');

  return prisma.$transaction(async (tx) => {
    await lockPart(tx, user.organizationId, partId);
    const part = await tx.part.findUniqueOrThrow({
      where: { id: partId },
      include: {
        _count: {
          select: {
            estimateItems: true,
            purchaseItems: true,
            partUsages: true,
            inventoryTransactions: true,
          },
        },
      },
    });
    if (!part.isActive) throw new DomainError(`${part.name} is already deleted.`);

    const used = Object.values(part._count).some((count) => count > 0);
    if (!used) {
      await tx.part.delete({ where: { id: part.id } });
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'part.deleted',
        entityType: 'Part',
        entityId: part.id,
        beforeData: { sku: part.sku, name: part.name, category: part.category },
      });
      return { outcome: 'deleted' as const };
    }

    // Every branch counts: stock anywhere would disappear from sight.
    const stock = await tx.inventoryTransaction.aggregate({
      where: { organizationId: user.organizationId, partId: part.id },
      _sum: { quantity: true },
    });
    const onHand = signedToMilli(stock._sum.quantity);
    if (onHand !== 0) {
      throw new DomainError(
        `${part.name} still has ${formatMilli(onHand)} ${part.unitOfMeasure} in stock. Adjust it to zero first, then delete.`,
      );
    }
    const openPurchase = await tx.purchaseItem.findFirst({
      where: {
        partId: part.id,
        purchase: {
          organizationId: user.organizationId,
          status: { in: ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'] },
        },
      },
      select: { purchase: { select: { purchaseNumber: true } } },
    });
    if (openPurchase) {
      throw new DomainError(
        `${part.name} is on open purchase ${openPurchase.purchase.purchaseNumber}. Receive or cancel it first.`,
      );
    }

    await tx.part.update({ where: { id: part.id }, data: { isActive: false } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'part.archived',
      entityType: 'Part',
      entityId: part.id,
      beforeData: { isActive: true },
      afterData: { isActive: false },
    });
    return { outcome: 'archived' as const };
  });
}

const adjustmentSchema = z
  .object({
    direction: z.enum(['IN', 'OUT'], { error: 'Choose whether stock goes up or down.' }),
    quantity: z
      .string({ error: 'Enter the quantity.' })
      .trim()
      .refine(
        (value) => /^\d+(\.\d{1,3})?$/.test(value) && Number(value) > 0,
        'Quantity must be a positive number (up to 3 decimals).',
      )
      .refine((value) => Number(value) <= 1_000_000, 'That quantity is not realistic.'),
    reason: z.enum(Object.keys(ADJUSTMENT_REASONS) as [keyof typeof ADJUSTMENT_REASONS], {
      error: 'Choose a reason.',
    }),
    note: z.string().trim().max(300).optional(),
  })
  .refine((value) => value.reason !== 'OTHER' || (value.note ?? '').length >= 3, {
    path: ['note'],
    message: 'Describe the reason for this adjustment.',
  });

/** A manual stock correction: one signed ADJUSTMENT row with its reason. Never below zero. */
export async function adjustStock(user: AuthenticatedUser, partId: string, rawInput: unknown) {
  const input = parseInput(adjustmentSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'inventory.adjust');
    const branch = await resolveInventoryBranch(user, tx);
    requirePermission(user, 'inventory.adjust', { branchId: branch.id });
    const part = await tx.part.findFirst({
      where: { id: partId, organizationId: user.organizationId },
    });
    if (!part) throw new NotFoundError('part');
    const quantityMilli = toMilli(input.quantity) * (input.direction === 'IN' ? 1 : -1);
    const note = [ADJUSTMENT_REASONS[input.reason], emptyToNull(input.note)]
      .filter(Boolean)
      .join(': ');

    const movement = await postMovement(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      partId: part.id,
      type: 'ADJUSTMENT',
      quantityMilli,
      unitCost: part.defaultCostPrice?.toString() ?? null,
      performedByUserId: user.id,
      note,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      actorUserId: user.id,
      action: 'inventory.adjusted',
      entityType: 'InventoryTransaction',
      entityId: movement.id,
      afterData: {
        partId: part.id,
        sku: part.sku,
        quantity: movement.quantity.toString(),
        reason: input.reason,
        note,
      },
    });
    return movement;
  });
}

/** Movement types staff may reverse directly. Job movements are corrected with a job return; receipts on the purchase. */
export const REVERSIBLE_TYPES: InventoryTransactionType[] = ['ADJUSTMENT', 'OPENING_STOCK'];

const reversalSchema = z.object({
  reason: z
    .string({ error: 'Say why this movement is being reversed.' })
    .trim()
    .min(3, 'Say why this movement is being reversed.')
    .max(300),
});

/** Cancels one adjustment or opening-stock row with an equal and opposite REVERSAL row. The original stays in the ledger. */
export async function reverseMovement(
  user: AuthenticatedUser,
  transactionId: string,
  rawInput: unknown,
) {
  const input = parseInput(reversalSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    const original = await tx.inventoryTransaction.findFirst({
      where: { id: transactionId, organizationId: user.organizationId },
      include: { part: { select: { sku: true } } },
    });
    if (!original) throw new NotFoundError('stock movement');
    requirePermission(user, 'inventory.adjust', { branchId: original.branchId });
    if (!REVERSIBLE_TYPES.includes(original.transactionType)) {
      throw new DomainError(
        original.transactionType === 'JOB_CONSUMPTION'
          ? 'Parts issued to a job are corrected from the job card (take the part back).'
          : 'Only stock adjustments and opening stock can be reversed here.',
      );
    }
    await lockPart(tx, user.organizationId, original.partId);
    const existing = await tx.inventoryTransaction.findFirst({
      where: { organizationId: user.organizationId, reversalOfTransactionId: original.id },
    });
    if (existing) throw new DomainError('This movement has already been reversed.');

    const reversal = await postMovement(tx, {
      organizationId: user.organizationId,
      branchId: original.branchId,
      partId: original.partId,
      type: 'REVERSAL',
      quantityMilli: -signedToMilli(original.quantity),
      unitCost: original.unitCost?.toString() ?? null,
      reversalOfTransactionId: original.id,
      performedByUserId: user.id,
      note: `Reversal: ${input.reason}`,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: original.branchId,
      actorUserId: user.id,
      action: 'inventory.reversed',
      entityType: 'InventoryTransaction',
      entityId: reversal.id,
      beforeData: {
        originalId: original.id,
        type: original.transactionType,
        quantity: original.quantity.toString(),
      },
      afterData: { quantity: reversal.quantity.toString(), reason: input.reason },
      metadata: { sku: original.part.sku },
    });
    return reversal;
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type StockFilter = '' | 'low' | 'out' | 'in';
export type ActiveFilter = 'active' | 'inactive' | 'all';

export interface PartFilters {
  q?: string;
  category?: string;
  supplierId?: string;
  stock?: StockFilter;
  status?: ActiveFilter;
}

/** Catalogue with stock on hand at the user's branch, filters, and the low / out-of-stock counts. */
export async function listParts(user: AuthenticatedUser, filters: PartFilters) {
  requirePermission(user, 'inventory.view');
  const branch = await resolveInventoryBranch(user);
  const q = filters.q?.trim();
  const status = filters.status ?? 'active';

  const [parts, stock, categories, suppliers] = await Promise.all([
    prisma.part.findMany({
      where: {
        organizationId: user.organizationId,
        ...(status === 'all' ? {} : { isActive: status === 'active' }),
        ...(filters.category ? { category: filters.category } : {}),
        ...(filters.supplierId ? { preferredSupplierId: filters.supplierId } : {}),
        ...(q
          ? {
              OR: [
                { sku: { contains: q, mode: 'insensitive' } },
                { name: { contains: q, mode: 'insensitive' } },
                { category: { contains: q, mode: 'insensitive' } },
                { description: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ name: 'asc' }, { sku: 'asc' }],
      take: 1000,
      include: { preferredSupplier: { select: { id: true, name: true } } },
    }),
    getStockByPart(user.organizationId, branch.id),
    listCategories(user.organizationId),
    prisma.supplier.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);

  const rows = parts.map((part) => {
    const onHandMilli = stock.get(part.id) ?? 0;
    return { ...part, onHandMilli, state: stockState(onHandMilli, part.reorderLevel) };
  });
  const matches = (state: StockState) =>
    filters.stock === 'low'
      ? state === 'LOW'
      : filters.stock === 'out'
        ? state === 'OUT'
        : filters.stock === 'in'
          ? state === 'IN_STOCK'
          : true;

  // Counts are over the whole active catalogue, so the chips stay meaningful while filtering.
  const activeParts = await prisma.part.findMany({
    where: { organizationId: user.organizationId, isActive: true },
    select: { id: true, reorderLevel: true },
  });
  const summary = { active: activeParts.length, low: 0, out: 0 };
  for (const part of activeParts) {
    const state = stockState(stock.get(part.id) ?? 0, part.reorderLevel);
    if (state === 'LOW') summary.low += 1;
    if (state === 'OUT') summary.out += 1;
  }

  return {
    branch,
    parts: rows.filter((row) => matches(row.state)),
    summary,
    categories,
    suppliers,
  };
}

export async function listCategories(organizationId: string) {
  const rows = await prisma.part.findMany({
    where: { organizationId, category: { not: null } },
    distinct: ['category'],
    orderBy: { category: 'asc' },
    select: { category: true },
  });
  return rows.map((row) => row.category!);
}

const movementInclude = {
  performedBy: { select: { fullName: true } },
  partUsage: { select: { jobCard: { select: { id: true, jobNumber: true } } } },
  purchaseItem: {
    select: {
      purchase: {
        select: { id: true, purchaseNumber: true, supplier: { select: { name: true } } },
      },
    },
  },
  reversedBy: { select: { id: true, createdAt: true } },
  reversalOf: { select: { id: true, transactionType: true } },
} satisfies Prisma.InventoryTransactionInclude;

/** One part: details, stock at the branch, the full movement history with a running balance, and purchase history. */
export async function getPartDetail(user: AuthenticatedUser, partId: string) {
  requirePermission(user, 'inventory.view');
  const branch = await resolveInventoryBranch(user);
  const part = await prisma.part.findFirst({
    where: { id: partId, organizationId: user.organizationId },
    include: { preferredSupplier: { select: { id: true, name: true, phone: true } } },
  });
  if (!part) throw new NotFoundError('part');

  const [movements, purchaseLines, onHandMilli] = await Promise.all([
    prisma.inventoryTransaction.findMany({
      where: { organizationId: user.organizationId, branchId: branch.id, partId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: movementInclude,
    }),
    prisma.purchaseItem.findMany({
      where: {
        organizationId: user.organizationId,
        partId,
        purchase: { status: { not: 'CANCELLED' } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      include: {
        purchase: {
          select: {
            id: true,
            purchaseNumber: true,
            status: true,
            supplierInvoiceNumber: true,
            supplierInvoiceDate: true,
            orderedAt: true,
            supplier: { select: { id: true, name: true } },
          },
        },
      },
    }),
    getStockOnHand(prisma, user.organizationId, branch.id, partId),
  ]);

  let balance = 0;
  const history = movements.map((movement) => {
    const quantityMilli = signedToMilli(movement.quantity);
    balance += quantityMilli;
    return {
      ...movement,
      quantityMilli,
      balanceMilli: balance,
      reversible: REVERSIBLE_TYPES.includes(movement.transactionType) && !movement.reversedBy,
    };
  });

  const lastReceived = purchaseLines.find((line) => signedToMilli(line.quantityReceived) > 0);
  return {
    branch,
    part,
    onHandMilli,
    state: stockState(onHandMilli, part.reorderLevel),
    history: history.reverse(),
    purchaseLines,
    lastPurchaseCost: lastReceived?.unitCost.toString() ?? null,
    usedOnJobsMilli: -history
      .filter((m) => m.transactionType === 'JOB_CONSUMPTION' || m.transactionType === 'JOB_RETURN')
      .reduce((sum, m) => sum + m.quantityMilli, 0),
  };
}

export type PartDetail = Awaited<ReturnType<typeof getPartDetail>>;

export async function getPartForEdit(user: AuthenticatedUser, partId: string) {
  requirePermission(user, 'inventory.manage');
  const part = await prisma.part.findFirst({
    where: { id: partId, organizationId: user.organizationId },
  });
  if (!part) throw new NotFoundError('part');
  return part;
}

/** Recent stock movements across all parts at the user's branch. */
export async function listMovements(
  user: AuthenticatedUser,
  filters: { type?: string; q?: string },
  /** Rows to return. The screen shows a page; an export asks for everything. */
  limit = 200,
) {
  requirePermission(user, 'inventory.view');
  const branch = await resolveInventoryBranch(user);
  const q = filters.q?.trim();
  const type =
    filters.type && filters.type in MOVEMENT_LABEL
      ? (filters.type as InventoryTransactionType)
      : undefined;
  const movements = await prisma.inventoryTransaction.findMany({
    where: {
      organizationId: user.organizationId,
      branchId: branch.id,
      ...(type ? { transactionType: type } : {}),
      ...(q
        ? {
            OR: [
              { part: { sku: { contains: q, mode: 'insensitive' } } },
              { part: { name: { contains: q, mode: 'insensitive' } } },
              { note: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    include: {
      ...movementInclude,
      part: { select: { id: true, sku: true, name: true, unitOfMeasure: true } },
    },
  });
  return {
    branch,
    movements: movements.map((m) => ({ ...m, quantityMilli: signedToMilli(m.quantity) })),
  };
}
