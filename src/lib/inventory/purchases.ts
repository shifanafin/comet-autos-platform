import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { PurchaseStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { allocateDocumentNumber } from '@/lib/numbering';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { parseInput, ValidationError } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import {
  calculateLine,
  calculateTotals,
  filsToString,
  formatMilli,
  milliToString,
  signedToMilli,
  toFils,
  toMilli,
} from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { resolveDefaultVatRate } from '@/lib/tax';
import { postMovement, resolveInventoryBranch } from '@/lib/inventory/stock';
import { PURCHASE_STATUS_LABEL } from '@/lib/inventory/labels';

/*
 * Purchase receiving: a purchase records one supplier invoice / delivery
 * (DRAFT while it's being entered), then stock is received against its lines
 * — in full or in part. Every unit received is a PURCHASE_RECEIPT ledger row
 * linked to its purchase line, in the same transaction that raises the
 * line's received quantity, so the purchase and the stock can't disagree.
 *
 * Totals are calculated here with the shared money helpers; the browser only
 * ever sends quantities, costs and VAT rates.
 */

const lineSchema = z.object({
  partId: z.uuid('Choose a part.'),
  quantity: z
    .string({ error: 'Enter the quantity.' })
    .trim()
    .refine(
      (value) => /^\d+(\.\d{1,3})?$/.test(value) && Number(value) > 0,
      'Quantity must be a positive number (up to 3 decimals).',
    )
    .refine((value) => Number(value) <= 1_000_000, 'That quantity is not realistic.'),
  unitCost: z
    .string({ error: 'Enter the cost price.' })
    .trim()
    .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), 'Cost must be an amount like 45 or 45.50.')
    .refine((value) => Number(value) <= 1_000_000, 'That cost is not realistic.'),
  taxRate: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || (/^\d+(\.\d{1,2})?$/.test(value) && Number(value) <= 100),
      'VAT must be between 0 and 100.',
    ),
});

const purchaseSchema = z.object({
  supplierId: z.uuid('Choose the supplier.'),
  supplierInvoiceNumber: z
    .string()
    .trim()
    .max(60, 'Keep the reference under 60 characters.')
    .optional(),
  supplierInvoiceDate: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || parseCalendarDate(value) !== null, 'Enter a valid date.')
    .refine(
      (value) => !value || value <= localDateString(),
      "The purchase date can't be in the future.",
    ),
  notes: z.string().trim().max(500).optional(),
  items: z
    .array(lineSchema, { error: 'Add at least one part.' })
    .min(1, 'Add at least one part.')
    .max(100, 'Split very large deliveries into several purchases.'),
});

export type PurchaseLineInput = z.input<typeof lineSchema>;
export type PurchaseInput = z.input<typeof purchaseSchema>;

/** Accepts either a parsed object or FormData-style input with the lines as a JSON string in `items`. */
function parsePurchase(rawInput: unknown) {
  const raw = { ...(rawInput as Record<string, unknown>) };
  if (typeof raw.items === 'string') {
    try {
      raw.items = JSON.parse(raw.items);
    } catch {
      throw new ValidationError({
        items: 'The purchase lines could not be read. Please try again.',
      });
    }
  }
  const input = parseInput(purchaseSchema, raw);
  const seen = new Set<string>();
  for (const item of input.items) {
    if (seen.has(item.partId))
      throw new ValidationError({
        items: 'Each part can appear only once — combine the quantities on one line.',
      });
    seen.add(item.partId);
  }
  return input;
}

/** Amounts for a quantity of a purchase line at its cost and VAT. */
export function purchaseLineAmounts(quantity: string, unitCost: string, taxRate: string) {
  return calculateLine({ quantity, unitPrice: unitCost, taxRate });
}

async function prepareLines(
  tx: Prisma.TransactionClient,
  organizationId: string,
  items: z.infer<typeof lineSchema>[],
) {
  const parts = await tx.part.findMany({
    where: { organizationId, id: { in: items.map((i) => i.partId) } },
    select: { id: true, sku: true, isActive: true },
  });
  const defaultVat = await resolveDefaultVatRate(organizationId, tx);
  return items.map((item, index) => {
    const part = parts.find((p) => p.id === item.partId);
    if (!part)
      throw new ValidationError({ items: `Line ${index + 1}: choose a part from the catalogue.` });
    if (!part.isActive)
      throw new ValidationError({
        items: `Line ${index + 1}: ${part.sku} is inactive — reactivate it first.`,
      });
    const taxRate = item.taxRate || defaultVat;
    const quantity = milliToString(toMilli(item.quantity));
    return {
      partId: part.id,
      quantity,
      unitCost: item.unitCost,
      taxRate,
      amounts: purchaseLineAmounts(quantity, item.unitCost, taxRate),
    };
  });
}

async function assertSupplierInvoiceFree(
  tx: Prisma.TransactionClient,
  organizationId: string,
  supplierId: string,
  invoiceNumber: string | null,
  exceptPurchaseId?: string,
) {
  if (!invoiceNumber) return;
  const clash = await tx.purchase.findFirst({
    where: {
      organizationId,
      supplierId,
      supplierInvoiceNumber: { equals: invoiceNumber, mode: 'insensitive' },
      status: { not: 'CANCELLED' },
      ...(exceptPurchaseId ? { id: { not: exceptPurchaseId } } : {}),
    },
    select: { purchaseNumber: true },
  });
  if (clash) {
    throw new DomainError(
      `This supplier invoice is already entered as ${clash.purchaseNumber}.`,
      'supplierInvoiceNumber',
    );
  }
}

async function requireActiveSupplier(
  tx: Prisma.TransactionClient,
  organizationId: string,
  supplierId: string,
) {
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, organizationId },
    select: { id: true, isActive: true },
  });
  if (!supplier) throw new DomainError('Choose the supplier.', 'supplierId');
  if (!supplier.isActive)
    throw new DomainError(
      'This supplier is inactive — reactivate it to buy from them.',
      'supplierId',
    );
  return supplier.id;
}

function headerData(
  input: z.infer<typeof purchaseSchema>,
  lines: Awaited<ReturnType<typeof prepareLines>>,
) {
  const totals = calculateTotals(lines.map((line) => line.amounts));
  return {
    supplierInvoiceNumber: emptyToNull(input.supplierInvoiceNumber),
    supplierInvoiceDate: input.supplierInvoiceDate
      ? parseCalendarDate(input.supplierInvoiceDate)
      : null,
    notes: emptyToNull(input.notes),
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    totalAmount: totals.totalAmount,
  };
}

/** Purchase lines for a nested create — the organization comes from the parent purchase. */
function itemRows(lines: Awaited<ReturnType<typeof prepareLines>>) {
  return lines.map((line) => ({
    partId: line.partId,
    quantityOrdered: line.quantity,
    unitCost: line.unitCost,
    taxRate: line.taxRate,
    taxAmount: line.amounts.taxAmount,
  }));
}

/**
 * Enters a purchase as a DRAFT. With `receive`, all of it is received into
 * stock straight away (the common case: the goods arrived with the invoice).
 */
export async function createPurchase(
  user: AuthenticatedUser,
  rawInput: unknown,
  options: { receive?: boolean } = {},
) {
  const input = parsePurchase(rawInput);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'purchase.create');
    const branch = await resolveInventoryBranch(user, tx);
    requirePermission(user, 'purchase.create', { branchId: branch.id });
    if (options.receive) requirePermission(user, 'purchase.receive', { branchId: branch.id });
    const supplierId = await requireActiveSupplier(tx, user.organizationId, input.supplierId);
    const lines = await prepareLines(tx, user.organizationId, input.items);
    const header = headerData(input, lines);
    await assertSupplierInvoiceFree(
      tx,
      user.organizationId,
      supplierId,
      header.supplierInvoiceNumber,
    );

    const purchaseNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      branch.id,
      'PURCHASE_ORDER',
    );
    const purchase = await tx.purchase.create({
      data: {
        organizationId: user.organizationId,
        branchId: branch.id,
        supplierId,
        purchaseNumber,
        status: 'DRAFT',
        ...header,
        createdByUserId: user.id,
        items: {
          create: itemRows(lines),
        },
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      actorUserId: user.id,
      action: 'purchase.created',
      entityType: 'Purchase',
      entityId: purchase.id,
      afterData: {
        purchaseNumber,
        supplierId,
        supplierInvoiceNumber: header.supplierInvoiceNumber,
        lines: lines.length,
        total: header.totalAmount,
      },
    });
    if (options.receive) await receiveInTransaction(tx, user, purchase.id, null);
    await settleRequestKey(tx, user, rawInput, purchase.id);
    return purchase;
  });
}

/** Replaces a DRAFT purchase's header and lines. Nothing received yet, so nothing in stock changes. */
export async function updatePurchase(
  user: AuthenticatedUser,
  purchaseId: string,
  rawInput: unknown,
) {
  const input = parsePurchase(rawInput);

  return prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, user.organizationId, purchaseId);
    requirePermission(user, 'purchase.create', { branchId: purchase.branchId });
    if (purchase.status !== 'DRAFT') throw new DomainError('Only a draft purchase can be edited.');
    const supplierId = await requireActiveSupplier(tx, user.organizationId, input.supplierId);
    const lines = await prepareLines(tx, user.organizationId, input.items);
    const header = headerData(input, lines);
    await assertSupplierInvoiceFree(
      tx,
      user.organizationId,
      supplierId,
      header.supplierInvoiceNumber,
      purchase.id,
    );

    await tx.purchaseItem.deleteMany({
      where: { organizationId: user.organizationId, purchaseId: purchase.id },
    });
    await tx.purchase.update({
      where: { id: purchase.id },
      data: {
        supplierId,
        ...header,
        items: {
          create: itemRows(lines),
        },
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: purchase.branchId,
      actorUserId: user.id,
      action: 'purchase.updated',
      entityType: 'Purchase',
      entityId: purchase.id,
      beforeData: {
        supplierId: purchase.supplierId,
        total: purchase.totalAmount?.toString() ?? null,
      },
      afterData: { supplierId, lines: lines.length, total: header.totalAmount },
    });
  });
}

async function lockPurchase(
  tx: Prisma.TransactionClient,
  organizationId: string,
  purchaseId: string,
) {
  await tx.$executeRaw`SELECT id FROM purchases WHERE id = ${purchaseId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const purchase = await tx.purchase.findFirst({
    where: { id: purchaseId, organizationId },
    include: {
      items: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: { part: { select: { sku: true, name: true } } },
      },
      supplier: { select: { name: true } },
    },
  });
  if (!purchase) throw new NotFoundError('purchase');
  return purchase;
}

const receiveSchema = z.record(
  z.string(),
  z
    .string()
    .trim()
    .refine(
      (value) => value === '' || /^\d+(\.\d{1,3})?$/.test(value),
      'Enter a quantity (up to 3 decimals).',
    ),
);

/**
 * Receives stock against a purchase. `quantities` maps purchase line id →
 * quantity arriving now; lines left out (or null for everything) receive
 * their full outstanding quantity.
 */
export async function receivePurchase(
  user: AuthenticatedUser,
  purchaseId: string,
  quantities: Record<string, string> | null,
  options: { requestKey?: string } = {},
) {
  const parsed = quantities ? parseInput(receiveSchema, quantities) : null;
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, options, 'purchase.receive');
    return receiveInTransaction(tx, user, purchaseId, parsed);
  });
}

async function receiveInTransaction(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  purchaseId: string,
  quantities: Record<string, string> | null,
) {
  const purchase = await lockPurchase(tx, user.organizationId, purchaseId);
  requirePermission(user, 'purchase.receive', { branchId: purchase.branchId });
  if (!(['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'] as PurchaseStatus[]).includes(purchase.status)) {
    throw new DomainError(
      purchase.status === 'RECEIVED'
        ? 'This purchase has already been received in full.'
        : 'This purchase can no longer be received.',
    );
  }

  const received: { sku: string; quantity: string; inventoryTransactionId: string }[] = [];
  let complete = true;
  for (const item of purchase.items) {
    const outstanding = signedToMilli(item.quantityOrdered) - signedToMilli(item.quantityReceived);
    const requested = quantities && item.id in quantities ? quantities[item.id] : null;
    const now = requested === null ? outstanding : requested === '' ? 0 : toMilli(requested);
    if (now > outstanding) {
      throw new ValidationError({
        [item.id]: `${item.part.sku}: only ${formatMilli(outstanding)} still to receive.`,
      });
    }
    if (now > 0) {
      await tx.purchaseItem.update({
        where: { id: item.id },
        data: { quantityReceived: milliToString(signedToMilli(item.quantityReceived) + now) },
      });
      const movement = await postMovement(tx, {
        organizationId: user.organizationId,
        branchId: purchase.branchId,
        partId: item.partId,
        type: 'PURCHASE_RECEIPT',
        quantityMilli: now,
        unitCost: item.unitCost.toString(),
        purchaseItemId: item.id,
        performedByUserId: user.id,
        note: `Received on ${purchase.purchaseNumber}${purchase.supplierInvoiceNumber ? ` (supplier invoice ${purchase.supplierInvoiceNumber})` : ''}`,
      });
      received.push({
        sku: item.part.sku,
        quantity: milliToString(now),
        inventoryTransactionId: movement.id,
      });
    }
    if (outstanding - now > 0) complete = false;
  }
  if (received.length === 0)
    throw new DomainError('Enter the quantity received on at least one line.');

  const status: PurchaseStatus = complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
  await tx.purchase.update({
    where: { id: purchase.id },
    data: { status, receivedAt: new Date(), receivedByUserId: user.id },
  });
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId: purchase.branchId,
    actorUserId: user.id,
    action: 'purchase.received',
    entityType: 'Purchase',
    entityId: purchase.id,
    beforeData: { status: purchase.status },
    afterData: { status, received },
  });
  return { status, received };
}

/** Cancels a purchase that has received nothing. Anything already received stays in stock and in the ledger. */
export async function cancelPurchase(user: AuthenticatedUser, purchaseId: string) {
  return prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, user.organizationId, purchaseId);
    requirePermission(user, 'purchase.create', { branchId: purchase.branchId });
    if (purchase.status !== 'DRAFT' && purchase.status !== 'ORDERED') {
      throw new DomainError('Only a purchase with nothing received can be cancelled.');
    }
    await tx.purchase.update({ where: { id: purchase.id }, data: { status: 'CANCELLED' } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: purchase.branchId,
      actorUserId: user.id,
      action: 'purchase.cancelled',
      entityType: 'Purchase',
      entityId: purchase.id,
      beforeData: { status: purchase.status },
      afterData: { status: 'CANCELLED' },
    });
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Value of what has actually been received on a purchase (cost + VAT), in fils. */
export function receivedValueFils(
  items: {
    quantityReceived: { toString(): string };
    unitCost: { toString(): string };
    taxRate: { toString(): string } | null;
  }[],
  defaultVat: string,
) {
  return items.reduce((sum, item) => {
    const qty = signedToMilli(item.quantityReceived);
    if (qty <= 0) return sum;
    const amounts = purchaseLineAmounts(
      milliToString(qty),
      item.unitCost.toString(),
      item.taxRate?.toString() ?? defaultVat,
    );
    return sum + amounts.lineTotalFils + amounts.taxFils;
  }, 0);
}

export async function listPurchases(
  user: AuthenticatedUser,
  filters: { q?: string; status?: string; supplierId?: string },
  /** Rows to return. The screen shows a page; an export asks for everything. */
  limit = 200,
) {
  requirePermission(user, 'inventory.view');
  const q = filters.q?.trim();
  const status =
    filters.status && PURCHASE_STATUS_LABEL[filters.status as PurchaseStatus]
      ? (filters.status as PurchaseStatus)
      : undefined;
  const [purchases, suppliers] = await Promise.all([
    prisma.purchase.findMany({
      where: {
        organizationId: user.organizationId,
        ...(status ? { status } : {}),
        ...(filters.supplierId ? { supplierId: filters.supplierId } : {}),
        ...(q
          ? {
              OR: [
                { purchaseNumber: { contains: q, mode: 'insensitive' } },
                { supplierInvoiceNumber: { contains: q, mode: 'insensitive' } },
                { supplier: { name: { contains: q, mode: 'insensitive' } } },
                {
                  items: {
                    some: {
                      part: {
                        OR: [
                          { sku: { contains: q, mode: 'insensitive' } },
                          { name: { contains: q, mode: 'insensitive' } },
                        ],
                      },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
      include: {
        supplier: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.supplier.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  return { purchases, suppliers };
}

export async function getPurchaseDetail(user: AuthenticatedUser, purchaseId: string) {
  requirePermission(user, 'inventory.view');
  const purchase = await prisma.purchase.findFirst({
    where: { id: purchaseId, organizationId: user.organizationId },
    include: {
      supplier: true,
      createdBy: { select: { fullName: true } },
      receivedBy: { select: { fullName: true } },
      items: {
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        include: {
          part: {
            select: {
              id: true,
              sku: true,
              name: true,
              unitOfMeasure: true,
              defaultCostPrice: true,
            },
          },
          inventoryTransactions: {
            orderBy: { createdAt: 'asc' },
            include: { performedBy: { select: { fullName: true } } },
          },
        },
      },
    },
  });
  if (!purchase) throw new NotFoundError('purchase');
  const defaultVat = await resolveDefaultVatRate(user.organizationId);
  const lines = purchase.items.map((item) => {
    const orderedMilli = signedToMilli(item.quantityOrdered);
    const receivedMilli = signedToMilli(item.quantityReceived);
    const taxRate = item.taxRate?.toString() ?? defaultVat;
    return {
      ...item,
      orderedMilli,
      receivedMilli,
      outstandingMilli: orderedMilli - receivedMilli,
      taxRate,
      amounts: purchaseLineAmounts(milliToString(orderedMilli), item.unitCost.toString(), taxRate),
      costDiffers:
        item.part.defaultCostPrice !== null &&
        toFils(item.part.defaultCostPrice.toString()) !== toFils(item.unitCost.toString()),
    };
  });
  return {
    purchase,
    lines,
    receivedValue: filsToString(receivedValueFils(purchase.items, defaultVat)),
    receipts: lines.flatMap((line) =>
      line.inventoryTransactions.map((t) => ({ ...t, sku: line.part.sku, name: line.part.name })),
    ),
  };
}

export type PurchaseDetail = Awaited<ReturnType<typeof getPurchaseDetail>>;

/** Draft purchase in the shape the purchase form edits. */
export async function getPurchaseForEdit(user: AuthenticatedUser, purchaseId: string) {
  requirePermission(user, 'purchase.create');
  const purchase = await prisma.purchase.findFirst({
    where: { id: purchaseId, organizationId: user.organizationId },
    include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
  });
  if (!purchase) throw new NotFoundError('purchase');
  return purchase;
}

/** Everything the purchase form needs: suppliers, active parts with their cost, and the default VAT. */
export async function getPurchaseFormOptions(user: AuthenticatedUser) {
  requirePermission(user, 'purchase.create');
  const [suppliers, parts] = await Promise.all([
    prisma.supplier.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    prisma.part.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        sku: true,
        name: true,
        unitOfMeasure: true,
        defaultCostPrice: true,
        defaultTaxRate: true,
        preferredSupplierId: true,
      },
    }),
  ]);
  return {
    suppliers,
    parts: parts.map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unitOfMeasure,
      cost: p.defaultCostPrice?.toString() ?? '',
      taxRate: p.defaultTaxRate?.toString() ?? '',
      supplierId: p.preferredSupplierId,
    })),
    defaultVat: await resolveDefaultVatRate(user.organizationId),
  };
}
