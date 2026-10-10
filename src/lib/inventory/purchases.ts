import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { PurchaseStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { loadPartOptions } from '@/lib/inventory/part-options';
import { writeAuditLog } from '@/lib/audit';
import { allocateDocumentNumber } from '@/lib/numbering';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { parseInput, ValidationError } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import {
  calculateDocument,
  calculateLine,
  filsToString,
  formatMilli,
  milliToString,
  readDiscount,
  shareFils,
  signedToMilli,
  toFils,
  toMilli,
  type LineAmounts,
} from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { resolveDefaultVatRate } from '@/lib/tax';
import { postMovement, resolveInventoryBranch } from '@/lib/inventory/stock';
import { getTaxCodeOptions, resolveTaxCodes } from '@/lib/accounting/tax-codes';
import { PURCHASE_STATUS_LABEL } from '@/lib/inventory/labels';
import { receivedValueFils, unitCostAfterDiscount } from '@/lib/inventory/purchase-value';
import { takeSupplierPayment } from '@/lib/finance/supplier-payments';
import {
  purchaseBillDifferenceFils,
  purchaseRoundingFils,
  supplierPaidFils,
} from '@/lib/finance/supplier-balance';
import { roundingField, withRounding } from '@/lib/billing/document-lines';
import { syncPosting } from '@/lib/accounting/journal';

/*
 * Purchase receiving: a purchase records one supplier invoice / delivery
 * (DRAFT while it's being entered), then stock is received against its lines
 * — in full or in part. Every unit received is a PURCHASE_RECEIPT ledger row
 * linked to its purchase line, in the same transaction that raises the
 * line's received quantity, so the purchase and the stock can't disagree.
 *
 * Totals are calculated here with the shared money helpers; the browser only
 * ever sends quantities, costs, VAT rates and discounts as entered.
 *
 * Discounts are trade discounts, priced by the same engine as invoices
 * (calculateLine / calculateDocument): each line may carry its own, and the
 * bill one more, shared across the lines to the fil. They lower the stock's
 * cost and the input VAT; nothing is booked as income. A discounted line
 * keeps its cost after both discounts (`netAmount`), from which every
 * delivery of it is valued (lib/inventory/purchase-value.ts). A purchase
 * with no discount stores no `netAmount` and is valued exactly as before.
 *
 * Receiving can settle the bill at once ("paid now", in full or in part):
 * an ordinary supplier payment, by the same function the Pay screen uses
 * (takeSupplierPayment), in the same transaction. "Pay later" records
 * nothing but an optional due date.
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
  /** The purchase tax code; when given, its rate is the line's VAT rate. */
  taxCodeId: z.union([z.literal(''), z.uuid()]).optional(),
  /** The line's own trade discount: a percentage or an AED amount, as entered. */
  discountType: z.union([z.literal(''), z.enum(['PERCENT', 'AMOUNT'])]).optional(),
  discountValue: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || /^\d+(\.\d{1,2})?$/.test(value),
      'Enter a discount like 10 or 10.50.',
    ),
});

const DATE_FIELD = z
  .string()
  .trim()
  .optional()
  .refine((value) => !value || parseCalendarDate(value) !== null, 'Enter a valid date.');

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
  /** A trade discount on the whole bill, after the lines' own. */
  billDiscountType: z.union([z.literal(''), z.enum(['PERCENT', 'AMOUNT'])]).optional(),
  billDiscountValue: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || /^\d+(\.\d{1,2})?$/.test(value),
      'Enter a discount like 10 or 10.50.',
    ),
  /** The supplier's round-off after VAT ("adjusted amount"): "-0.20", "0.25" or blank. */
  roundingAdjustment: roundingField,
  /** When the supplier expects to be paid. */
  dueDate: DATE_FIELD,
  /** Set when the form was filled by Scan bill: the fields the reader filled. */
  scannedFields: z.string().trim().max(200).optional(),
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

/**
 * A saved line's amounts for the screens: as stored when it carries a
 * discount (its own discount, its cost after the bill discount, its VAT),
 * else priced as it always was.
 */
function lineAmountsOf(
  item: {
    quantityOrdered: { toString(): string };
    unitCost: { toString(): string };
    discountType: 'PERCENT' | 'AMOUNT' | null;
    discountValue: { toString(): string } | null;
    taxAmount: { toString(): string } | null;
    netAmount: { toString(): string } | null;
  },
  taxRate: string,
) {
  const base = purchaseLineAmounts(
    milliToString(signedToMilli(item.quantityOrdered)),
    item.unitCost.toString(),
    taxRate,
  );
  const discounted = calculateLine({
    quantity: milliToString(signedToMilli(item.quantityOrdered)),
    unitPrice: item.unitCost.toString(),
    taxRate,
    discount: readDiscount(item.discountType, item.discountValue),
  });
  return {
    ...discounted,
    /** Quantity × cost, before any discount. */
    grossFils: base.lineTotalFils,
    /** After the line's own discount and its share of the bill discount, before VAT. */
    net: item.netAmount ? filsToString(toFils(item.netAmount.toString())) : discounted.lineTotal,
    taxAmount:
      item.netAmount && item.taxAmount
        ? filsToString(toFils(item.taxAmount.toString()))
        : discounted.taxAmount,
  };
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
  const codes = await resolveTaxCodes(tx, organizationId, items);
  return items.map((item, index) => {
    const part = parts.find((p) => p.id === item.partId);
    if (!part)
      throw new ValidationError({ items: `Line ${index + 1}: choose a part from the catalogue.` });
    if (!part.isActive)
      throw new ValidationError({
        items: `Line ${index + 1}: ${part.sku} is inactive — reactivate it first.`,
      });
    const code = item.taxCodeId ? codes.get(item.taxCodeId) : undefined;
    const taxRate = code?.rate ?? (item.taxRate || defaultVat);
    const quantity = milliToString(toMilli(item.quantity));
    let amounts: LineAmounts;
    try {
      amounts = calculateLine({
        quantity,
        unitPrice: item.unitCost,
        taxRate,
        discount: readDiscount(item.discountType, item.discountValue),
      });
    } catch (error) {
      throw new ValidationError({
        [`items.${index}.discountValue`]: `Line ${index + 1}: ${
          error instanceof Error ? error.message : 'check the discount.'
        }`,
      });
    }
    return {
      partId: part.id,
      quantity,
      unitCost: item.unitCost,
      taxRate,
      taxCodeId: code?.id ?? null,
      amounts,
    };
  });
}

type PreparedLine = Awaited<ReturnType<typeof prepareLines>>[number];

/**
 * The whole purchase priced: the bill discount shared across the lines to
 * the fil and each line's VAT on what is left (the invoice engine,
 * calculateDocument), and — only when there is any discount — each line's
 * cost after both discounts, from which its stock is valued.
 */
export function pricePurchase(
  lines: PreparedLine[],
  bill: { type?: string | null; value?: string | null },
) {
  const discount = readDiscount(bill.type, bill.value);
  let priced: ReturnType<typeof calculateDocument>;
  try {
    priced = calculateDocument(
      lines.map((line) => line.amounts),
      discount,
    );
  } catch (error) {
    throw new DomainError(
      error instanceof Error ? error.message : 'Check the bill discount.',
      'billDiscountValue',
    );
  }
  const discounted = Boolean(discount) || lines.some((line) => line.amounts.discountType);
  // The same exact split calculateDocument made of the bill discount.
  const shares = shareFils(
    toFils(priced.totals.discountAmount),
    lines.map((line) => line.amounts.lineTotalFils),
  );
  return {
    lines: lines.map((line, index) => ({
      ...line,
      amounts: priced.lines[index],
      netAmount: discounted ? filsToString(line.amounts.lineTotalFils - shares[index]) : null,
    })),
    totals: priced.totals,
  };
}

export async function assertSupplierInvoiceFree(
  tx: Prisma.TransactionClient,
  organizationId: string,
  supplierId: string,
  invoiceNumber: string | null,
  exceptPurchaseId?: string,
) {
  if (!invoiceNumber) return;
  const supplier = await tx.supplier.findFirst({
    where: { id: supplierId, organizationId },
    select: { name: true, taxNumber: true },
  });
  // A TRN is one company: a second supplier record with the same TRN (a
  // name typed differently) is the same supplier, and so the same bill.
  const clash = await tx.purchase.findFirst({
    where: {
      organizationId,
      OR: [
        { supplierId },
        ...(supplier?.taxNumber ? [{ supplier: { taxNumber: supplier.taxNumber } }] : []),
      ],
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
  // The same bill may have been entered as an expense against this supplier's name.
  if (!supplier) return;
  const expense = await tx.expense.findFirst({
    where: {
      organizationId,
      status: 'RECORDED',
      billNumber: { equals: invoiceNumber, mode: 'insensitive' },
      vendorName: { equals: supplier.name, mode: 'insensitive' },
    },
    select: { expenseNumber: true },
  });
  if (expense) {
    throw new DomainError(
      `This supplier invoice is already entered as ${expense.expenseNumber ? `expense ${expense.expenseNumber}` : 'an expense'}.`,
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

type PricedPurchase = ReturnType<typeof pricePurchase>;

/** A due date given on a form: a valid date, not before the bill's own date. */
function readDueDate(value: string | undefined, billDate: Date | null) {
  if (!value) return null;
  const due = parseCalendarDate(value);
  if (!due) throw new DomainError('Enter a valid due date.', 'dueDate');
  if (billDate && due < billDate) {
    throw new DomainError('The due date can’t be before the purchase date.', 'dueDate');
  }
  return due;
}

function headerData(input: z.infer<typeof purchaseSchema>, priced: PricedPurchase) {
  const { totals } = priced;
  // The supplier's round-off: after VAT, outside it, at most 5.00 either way.
  const rounded = withRounding(totals, input.roundingAdjustment);
  const supplierInvoiceDate = input.supplierInvoiceDate
    ? parseCalendarDate(input.supplierInvoiceDate)
    : null;
  const supplierInvoiceNumber = emptyToNull(input.supplierInvoiceNumber);
  return {
    supplierInvoiceNumber,
    supplierInvoiceDate,
    // The supplier's tax invoice is in hand when its number is entered with
    // the purchase; without one it is awaited, and so is its input VAT
    // (lib/inventory/bills.ts matches it when it comes).
    billStatus: supplierInvoiceNumber ? ('RECEIVED' as const) : ('PENDING' as const),
    billReceivedOn: supplierInvoiceNumber
      ? (supplierInvoiceDate ?? parseCalendarDate(localDateString())!)
      : null,
    notes: emptyToNull(input.notes),
    subtotal: totals.subtotal,
    taxAmount: totals.taxAmount,
    totalAmount: rounded.totalAmount,
    roundingAdjustment: rounded.roundingAdjustment,
    billDiscountType: totals.discountType,
    billDiscountValue: totals.discountValue,
    billDiscountAmount: totals.discountAmount,
    dueDate: readDueDate(input.dueDate, supplierInvoiceDate),
  };
}

/** Purchase lines for a nested create — the organization comes from the parent purchase. */
function itemRows(priced: PricedPurchase) {
  return priced.lines.map((line) => ({
    partId: line.partId,
    quantityOrdered: line.quantity,
    unitCost: line.unitCost,
    taxRate: line.taxRate,
    taxAmount: line.amounts.taxAmount,
    taxCodeId: line.taxCodeId,
    discountType: line.amounts.discountType,
    discountValue: line.amounts.discountValue,
    discountAmount: line.amounts.discountAmount,
    netAmount: line.netAmount,
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
  return prisma.$transaction(
    (tx) => createPurchaseInTransaction(tx, user, rawInput, options),
    RECEIPT_TRANSACTION,
  );
}

/**
 * createPurchase in a transaction the caller already holds — the purchase
 * import uses it, so every imported bill follows exactly the form's rules.
 */
export async function createPurchaseInTransaction(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  rawInput: unknown,
  options: { receive?: boolean } = {},
) {
  const input = parsePurchase(rawInput);
  const settlement = parseSettlement(rawInput);
  if (!options.receive && settlement.payment === 'now') {
    throw new DomainError('A supplier is paid once the goods are received.', 'payment');
  }

  await claimRequestKey(tx, user, rawInput, 'purchase.create');
  const branch = await resolveInventoryBranch(user, tx);
  requirePermission(user, 'purchase.create', { branchId: branch.id });
  if (options.receive) requirePermission(user, 'purchase.approve', { branchId: branch.id });
  const supplierId = await requireActiveSupplier(tx, user.organizationId, input.supplierId);
  const priced = pricePurchase(await prepareLines(tx, user.organizationId, input.items), {
    type: input.billDiscountType,
    value: input.billDiscountValue,
  });
  const lines = priced.lines;
  const header = headerData(input, priced);
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
        create: itemRows(priced),
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
      ...discountAudit(priced),
      dueDate: input.dueDate || null,
    },
  });
  if (input.scannedFields) {
    // The figures came from reading the bill, then the user's review.
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      actorUserId: user.id,
      action: 'purchase.filled_from_scan',
      entityType: 'Purchase',
      entityId: purchase.id,
      afterData: {
        filled: input.scannedFields.split(',').filter(Boolean),
        purchaseNumber,
        supplierInvoiceNumber: header.supplierInvoiceNumber,
        total: header.totalAmount,
      },
    });
  }
  if (options.receive) {
    const receipt = await receiveInTransaction(tx, user, purchase.id, null);
    await settleOnReceipt(tx, user, purchase.id, settlement, receipt.itemIds);
  }
  await settleRequestKey(tx, user, rawInput, purchase.id);
  return purchase;
}

/** The discounts on a purchase, for its audit entry — only when there are any. */
function discountAudit(priced: PricedPurchase) {
  const lineDiscounts = priced.lines.filter((line) => line.amounts.discountType);
  if (!lineDiscounts.length && !priced.totals.discountType) return {};
  return {
    linesTotal: priced.totals.linesTotal,
    billDiscount: priced.totals.discountType
      ? {
          type: priced.totals.discountType,
          value: priced.totals.discountValue,
          amount: priced.totals.discountAmount,
        }
      : null,
    lineDiscounts: lineDiscounts.map((line) => ({
      partId: line.partId,
      type: line.amounts.discountType,
      value: line.amounts.discountValue,
      amount: line.amounts.discountAmount,
    })),
  };
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
    requirePermission(user, 'purchase.edit', { branchId: purchase.branchId });
    if (purchase.status !== 'DRAFT') throw new DomainError('Only a draft purchase can be edited.');
    const supplierId = await requireActiveSupplier(tx, user.organizationId, input.supplierId);
    const priced = pricePurchase(await prepareLines(tx, user.organizationId, input.items), {
      type: input.billDiscountType,
      value: input.billDiscountValue,
    });
    const lines = priced.lines;
    const header = headerData(input, priced);
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
          create: itemRows(priced),
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
      afterData: {
        supplierId,
        lines: lines.length,
        total: header.totalAmount,
        ...discountAudit(priced),
        dueDate: input.dueDate || null,
      },
    });
  });
}

const detailsSchema = purchaseSchema
  .pick({ supplierInvoiceNumber: true, supplierInvoiceDate: true, dueDate: true, notes: true })
  .extend({ requestKey: z.string().optional() });

/**
 * Corrects a purchase's details once it is past draft — the supplier's
 * invoice number, the purchase (bill) date, the due date and the notes. None
 * of them changes an amount, the stock or an entry: the books keep the day
 * the goods were received. The lines and figures stay as received; the
 * audit log keeps the details as they were.
 */
export async function updatePurchaseDetails(
  user: AuthenticatedUser,
  purchaseId: string,
  rawInput: unknown,
) {
  const input = parseInput(detailsSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'purchase.details');
    const purchase = await lockPurchase(tx, user.organizationId, purchaseId);
    requirePermission(user, 'purchase.edit', { branchId: purchase.branchId });
    if (purchase.status === 'CANCELLED') throw new DomainError('This purchase is cancelled.');
    if (purchase.status === 'DRAFT') throw new DomainError('Edit the draft instead.');
    const supplierInvoiceNumber = emptyToNull(input.supplierInvoiceNumber);
    const supplierInvoiceDate = input.supplierInvoiceDate
      ? parseCalendarDate(input.supplierInvoiceDate)
      : null;
    await assertSupplierInvoiceFree(
      tx,
      user.organizationId,
      purchase.supplierId,
      supplierInvoiceNumber,
      purchase.id,
    );
    const after = {
      supplierInvoiceNumber,
      supplierInvoiceDate,
      dueDate: readDueDate(input.dueDate, supplierInvoiceDate),
      notes: emptyToNull(input.notes),
    };
    await tx.purchase.update({ where: { id: purchase.id }, data: after });
    const day = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: purchase.branchId,
      actorUserId: user.id,
      action: 'purchase.details_updated',
      entityType: 'Purchase',
      entityId: purchase.id,
      beforeData: {
        supplierInvoiceNumber: purchase.supplierInvoiceNumber,
        supplierInvoiceDate: day(purchase.supplierInvoiceDate),
        dueDate: day(purchase.dueDate),
        notes: purchase.notes,
      },
      afterData: {
        supplierInvoiceNumber: after.supplierInvoiceNumber,
        supplierInvoiceDate: day(after.supplierInvoiceDate),
        dueDate: day(after.dueDate),
        notes: after.notes,
      },
      metadata: { purchaseNumber: purchase.purchaseNumber },
    });
    await settleRequestKey(tx, user, rawInput, purchase.id);
    return { purchaseId: purchase.id };
  });
}

/**
 * Receiving books every line into stock and into the ledger in one
 * transaction — all of the delivery or none of it. A long supplier bill is
 * many statements against a hosted database, so it gets more time than the
 * usual transaction (lib/prisma.ts) before it is given up and rolled back.
 */
const RECEIPT_TRANSACTION = { timeout: 90_000, maxWait: 10_000 };

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
  options: { requestKey?: string } & SettlementInput = {},
) {
  const parsed = quantities ? parseInput(receiveSchema, quantities) : null;
  const settlement = parseSettlement(options);
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, options, 'purchase.receipt');
    const receipt = await receiveInTransaction(tx, user, purchaseId, parsed);
    const payment = await settleOnReceipt(tx, user, purchaseId, settlement, receipt.itemIds);
    return { status: receipt.status, received: receipt.received, payment };
  }, RECEIPT_TRANSACTION);
}

// ---------------------------------------------------------------------------
// Settling on receipt: pay now or later, the due date, the part cost price
// ---------------------------------------------------------------------------

const settlementSchema = z.object({
  /** "later" (the default) records nothing; "now" pays the supplier at once. */
  payment: z.union([z.literal(''), z.enum(['later', 'now'])]).optional(),
  /** Blank: everything owed on the purchase once these goods are in. */
  payAmount: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || (/^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0),
      'Enter an amount like 250 or 250.50.',
    ),
  method: z
    .union([z.literal(''), z.enum(['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'])])
    .optional(),
  accountId: z.union([z.literal(''), z.uuid()]).optional(),
  payReference: z.string().trim().max(100).optional(),
  dueDate: DATE_FIELD,
  /** "on": set each received part's cost price to its cost after discounts. */
  updateCostPrice: z.string().optional(),
});

export type SettlementInput = Partial<Record<keyof z.input<typeof settlementSchema>, string>>;

function parseSettlement(rawInput: unknown) {
  const raw = (rawInput ?? {}) as Record<string, unknown>;
  const pick = Object.fromEntries(
    Object.keys(settlementSchema.shape).map((key) => [
      key,
      typeof raw[key] === 'string' ? raw[key] : undefined,
    ]),
  );
  return parseInput(settlementSchema, pick);
}

const ON = new Set(['on', 'true', '1']);

/**
 * After a receipt, in its transaction: the due date, the part cost prices
 * when asked, and — when paid now — the supplier payment, by the same
 * function the Pay screen uses. Pay later books nothing.
 */
async function settleOnReceipt(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  purchaseId: string,
  settlement: z.infer<typeof settlementSchema>,
  receivedItemIds: string[],
) {
  const purchase = await tx.purchase.findUniqueOrThrow({
    where: { id: purchaseId },
    select: {
      id: true,
      branchId: true,
      purchaseNumber: true,
      supplierInvoiceDate: true,
      dueDate: true,
      items: {
        where: { id: { in: receivedItemIds } },
        select: {
          id: true,
          partId: true,
          quantityOrdered: true,
          unitCost: true,
          taxRate: true,
          taxAmount: true,
          netAmount: true,
          part: { select: { defaultCostPrice: true } },
        },
      },
    },
  });

  const dueDate = readDueDate(settlement.dueDate, purchase.supplierInvoiceDate);
  if (dueDate && dueDate.getTime() !== purchase.dueDate?.getTime()) {
    await tx.purchase.update({ where: { id: purchase.id }, data: { dueDate } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: purchase.branchId,
      actorUserId: user.id,
      action: 'purchase.due_date_set',
      entityType: 'Purchase',
      entityId: purchase.id,
      beforeData: { dueDate: purchase.dueDate?.toISOString().slice(0, 10) ?? null },
      afterData: { dueDate: settlement.dueDate, purchaseNumber: purchase.purchaseNumber },
    });
  }

  if (ON.has(settlement.updateCostPrice ?? '')) {
    // The same right as editing a part's cost in the catalogue.
    requirePermission(user, 'inventory.create');
    for (const item of purchase.items) {
      const cost = unitCostAfterDiscount(item);
      const before = item.part.defaultCostPrice?.toString() ?? null;
      if (before !== null && toFils(before) === toFils(cost)) continue;
      await tx.part.update({ where: { id: item.partId }, data: { defaultCostPrice: cost } });
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'part.updated',
        entityType: 'Part',
        entityId: item.partId,
        beforeData: { defaultCostPrice: before },
        afterData: { defaultCostPrice: cost },
        metadata: { source: 'purchase_receipt', purchaseNumber: purchase.purchaseNumber },
      });
    }
  }

  if (settlement.payment !== 'now') return null;
  if (!settlement.method) {
    throw new DomainError('Choose how the supplier was paid.', 'method');
  }
  return takeSupplierPayment(tx, user, purchase.id, {
    amountFils: settlement.payAmount ? toFils(settlement.payAmount) : null,
    method: settlement.method,
    accountId: settlement.accountId,
    referenceNumber: settlement.payReference,
    paidAt: new Date(),
  });
}

/** Whether this user may pay the supplier as goods are received (the Pay screen's right). */
export const canPayOnReceipt = (user: AuthenticatedUser) =>
  hasPermission(user, 'supplier_payment.create');

async function receiveInTransaction(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  purchaseId: string,
  quantities: Record<string, string> | null,
) {
  const purchase = await lockPurchase(tx, user.organizationId, purchaseId);
  requirePermission(user, 'purchase.approve', { branchId: purchase.branchId });
  if (!(['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'] as PurchaseStatus[]).includes(purchase.status)) {
    throw new DomainError(
      purchase.status === 'RECEIVED'
        ? 'This purchase has already been received in full.'
        : 'This purchase can no longer be received.',
    );
  }

  const received: { sku: string; quantity: string; inventoryTransactionId: string }[] = [];
  const itemIds: string[] = [];
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
      itemIds.push(item.id);
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
  // Received in full: the bill's round-off is owed now, and booked.
  await syncPosting(tx, user.organizationId, 'PURCHASE_ROUNDING', purchase.id, user.id);
  // A tax invoice matched before this delivery: its VAT is claimed with the rest.
  if (purchase.billMatchedByUserId) {
    await syncPosting(tx, user.organizationId, 'PURCHASE_BILL', purchase.id, user.id);
  }
  return { status, received, itemIds };
}

/** Cancels a purchase that has received nothing. Anything already received stays in stock and in the ledger. */
export async function cancelPurchase(user: AuthenticatedUser, purchaseId: string) {
  return prisma.$transaction(async (tx) => {
    const purchase = await lockPurchase(tx, user.organizationId, purchaseId);
    requirePermission(user, 'purchase.delete', { branchId: purchase.branchId });
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

/** Value of what has been received on a purchase — lib/inventory/purchase-value.ts. */
export { receivedValueFils };

export async function listPurchases(
  user: AuthenticatedUser,
  filters: { q?: string; status?: string; supplierId?: string },
  /** Rows to return. The screen shows a page; an export asks for everything. */
  limit = 200,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
) {
  requirePermission(user, 'purchase.view');
  const q = filters.q?.trim();
  const status =
    filters.status && PURCHASE_STATUS_LABEL[filters.status as PurchaseStatus]
      ? (filters.status as PurchaseStatus)
      : undefined;
  const where: Prisma.PurchaseWhereInput = {
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
  };
  const [purchases, total, suppliers] = await Promise.all([
    prisma.purchase.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      skip: offset,
      take: limit,
      include: {
        supplier: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.purchase.count({ where }),
    prisma.supplier.findMany({
      where: { organizationId: user.organizationId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
  ]);
  return { purchases, total, suppliers };
}

export async function getPurchaseDetail(user: AuthenticatedUser, purchaseId: string) {
  requirePermission(user, 'purchase.view');
  const purchase = await prisma.purchase.findFirst({
    where: { id: purchaseId, organizationId: user.organizationId },
    include: {
      supplier: true,
      createdBy: { select: { fullName: true } },
      receivedBy: { select: { fullName: true } },
      supplierPayments: {
        orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          supplierPaymentNumber: true,
          amount: true,
          status: true,
          method: true,
          referenceNumber: true,
          reversalOfSupplierPaymentId: true,
          paidAt: true,
          paidBy: { select: { fullName: true } },
        },
      },
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
      amounts: lineAmountsOf(item, taxRate),
      costDiffers:
        item.part.defaultCostPrice !== null &&
        toFils(item.part.defaultCostPrice.toString()) !== toFils(item.unitCost.toString()),
    };
  });
  const roundingFils = purchaseRoundingFils(purchase);
  // A tax invoice matched later for a different amount is owed as it says.
  const billDifferenceFils = purchaseBillDifferenceFils(purchase);
  const receivedFils =
    receivedValueFils(purchase.items, defaultVat) + roundingFils + billDifferenceFils;
  const paidFils = supplierPaidFils(purchase.supplierPayments);
  return {
    purchase,
    lines,
    /** The goods received, and the bill's round-off once all of them are. */
    receivedValue: filsToString(receivedFils),
    /** The round-off counted in what is owed (nothing until fully received). */
    roundingOwed: filsToString(roundingFils),
    /** What the matched tax invoice says beyond what was recorded (signed). */
    billDifference: filsToString(Math.abs(billDifferenceFils)),
    billDifferenceSign: Math.sign(billDifferenceFils),
    /** What the purchase owes the supplier now — the supplier balance's own rule. */
    paid: filsToString(paidFils),
    owed: filsToString(Math.max(receivedFils - paidFils, 0)),
    /** Quantity × cost of every line, before any discount. */
    linesGross: filsToString(lines.reduce((sum, line) => sum + line.amounts.grossFils, 0)),
    /** Every discount taken: the lines' own and the bill's. */
    discountTotal: filsToString(
      lines.reduce((sum, line) => sum + toFils(line.amounts.discountAmount), 0) +
        toFils(purchase.billDiscountAmount.toString()),
    ),
    receipts: lines.flatMap((line) =>
      line.inventoryTransactions.map((t) => ({ ...t, sku: line.part.sku, name: line.part.name })),
    ),
  };
}

export type PurchaseDetail = Awaited<ReturnType<typeof getPurchaseDetail>>;

/** Draft purchase in the shape the purchase form edits. */
export async function getPurchaseForEdit(user: AuthenticatedUser, purchaseId: string) {
  requirePermission(user, 'purchase.edit');
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
    loadPartOptions(user),
  ]);
  return {
    suppliers,
    parts,
    canCreateParts: hasPermission(user, 'inventory.create'),
    defaultVat: await resolveDefaultVatRate(user.organizationId),
    taxCodes: await getTaxCodeOptions(user.organizationId, 'purchases'),
  };
}
