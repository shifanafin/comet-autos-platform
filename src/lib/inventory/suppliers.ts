import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { parseInput } from '@/lib/form-data';
import { emptyToNull, normalizePhone } from '@/lib/normalize';
import { filsToString } from '@/lib/money';
import { resolveDefaultVatRate } from '@/lib/tax';
import { getStockByPart, resolveInventoryBranch, stockState } from '@/lib/inventory/stock';
import {
  PURCHASE_BALANCE_SELECT,
  RECEIVED_PURCHASE_STATUSES,
  purchaseBalance,
} from '@/lib/finance/supplier-balance';

/*
 * Suppliers. The outstanding amount is the value of stock received from the
 * supplier (cost + VAT, on received quantities) minus the supplier payments
 * that count — one rule, in lib/finance/supplier-balance, shared with the
 * payables screens and with recording a payment.
 */

const supplierSchema = z.object({
  name: z
    .string({ error: 'Enter the supplier name.' })
    .trim()
    .min(2, 'Enter the supplier name.')
    .max(120),
  contactName: z.string().trim().max(120).optional(),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .refine((value) => !value || /^[+\d][\d\s()-]{5,}$/.test(value), 'Enter a valid phone number.'),
  email: z.union([z.literal(''), z.email('Enter a valid email address.')]).optional(),
  address: z.string().trim().max(300).optional(),
  isActive: z.enum(['true', 'false']).optional(),
});

function supplierData(input: z.infer<typeof supplierSchema>) {
  return {
    name: input.name.replace(/\s+/g, ' '),
    contactName: emptyToNull(input.contactName),
    phone: input.phone ? normalizePhone(input.phone) : null,
    email: emptyToNull(input.email)?.toLowerCase() ?? null,
    address: emptyToNull(input.address),
  };
}

async function assertNameFree(
  organizationId: string,
  name: string,
  exceptId?: string,
  client: Prisma.TransactionClient = prisma,
) {
  const clash = await client.supplier.findFirst({
    where: {
      organizationId,
      name: { equals: name.replace(/\s+/g, ' '), mode: 'insensitive' },
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    select: { id: true },
  });
  if (clash) throw new DomainError('A supplier with this name already exists.', 'name');
}

export async function createSupplier(
  user: AuthenticatedUser,
  rawInput: unknown,
  /** Join the caller's transaction (a bulk import) instead of opening one. */
  client?: Prisma.TransactionClient,
) {
  const input = parseInput(supplierSchema, rawInput);
  requirePermission(user, 'inventory.manage');
  const run = async (tx: Prisma.TransactionClient) => {
    await claimRequestKey(tx, user, rawInput, 'supplier.create');
    await assertNameFree(user.organizationId, input.name, undefined, tx);
    const supplier = await tx.supplier.create({
      data: { organizationId: user.organizationId, ...supplierData(input) },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'supplier.created',
      entityType: 'Supplier',
      entityId: supplier.id,
      afterData: supplierData(input),
    });
    await settleRequestKey(tx, user, rawInput, supplier.id);
    return supplier;
  };
  return client ? run(client) : prisma.$transaction(run);
}

export async function updateSupplier(
  user: AuthenticatedUser,
  supplierId: string,
  rawInput: unknown,
) {
  const input = parseInput(supplierSchema, rawInput);
  requirePermission(user, 'inventory.manage');
  const before = await prisma.supplier.findFirst({
    where: { id: supplierId, organizationId: user.organizationId },
  });
  if (!before) throw new NotFoundError('supplier');
  await assertNameFree(user.organizationId, input.name, supplierId);
  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.update({
      where: { id: supplierId },
      data: {
        ...supplierData(input),
        isActive: input.isActive ? input.isActive === 'true' : before.isActive,
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'supplier.updated',
      entityType: 'Supplier',
      entityId: supplier.id,
      beforeData: {
        name: before.name,
        contactName: before.contactName,
        phone: before.phone,
        email: before.email,
        address: before.address,
        isActive: before.isActive,
      },
      afterData: {
        name: supplier.name,
        contactName: supplier.contactName,
        phone: supplier.phone,
        email: supplier.email,
        address: supplier.address,
        isActive: supplier.isActive,
      },
    });
    return supplier;
  });
}

const RECEIVED: ('RECEIVED' | 'PARTIALLY_RECEIVED')[] = [...RECEIVED_PURCHASE_STATUSES];

/**
 * Received value, paid and outstanding for a set of suppliers, in fils.
 * Per purchase the figures come from `purchaseBalance` — the same rule the
 * payables screens and recording a payment use — so the supplier directory
 * can never show a different balance from the payables screen.
 */
async function balances(organizationId: string, supplierIds: string[]) {
  const defaultVat = await resolveDefaultVatRate(organizationId);
  const purchases = await prisma.purchase.findMany({
    where: { organizationId, supplierId: { in: supplierIds }, status: { in: RECEIVED } },
    select: { supplierId: true, ...PURCHASE_BALANCE_SELECT },
  });
  const result = new Map<string, { receivedFils: number; paidFils: number }>();
  for (const purchase of purchases) {
    const entry = result.get(purchase.supplierId) ?? { receivedFils: 0, paidFils: 0 };
    const money = purchaseBalance(purchase, defaultVat);
    entry.receivedFils += money.receivedFils;
    entry.paidFils += money.paidFils;
    result.set(purchase.supplierId, entry);
  }
  return result;
}

const money = (entry: { receivedFils: number; paidFils: number } | undefined) => ({
  received: filsToString(entry?.receivedFils ?? 0),
  paid: filsToString(entry?.paidFils ?? 0),
  // Floored, like every other outstanding figure: overpayment is refused
  // when it is recorded, so a negative here would only ever be bad data.
  outstanding: filsToString(Math.max((entry?.receivedFils ?? 0) - (entry?.paidFils ?? 0), 0)),
});

export async function listSuppliers(user: AuthenticatedUser, query: string) {
  requirePermission(user, 'inventory.view');
  const q = query.trim();
  const suppliers = await prisma.supplier.findMany({
    where: {
      organizationId: user.organizationId,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { contactName: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q } },
              { email: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    include: {
      _count: { select: { parts: true, purchases: true } },
      purchases: {
        where: { status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { createdAt: true },
      },
    },
  });
  const totals = await balances(
    user.organizationId,
    suppliers.map((s) => s.id),
  );
  return suppliers.map((supplier) => ({
    ...supplier,
    lastPurchaseAt: supplier.purchases[0]?.createdAt ?? null,
    balance: money(totals.get(supplier.id)),
  }));
}

export async function getSupplierDetail(user: AuthenticatedUser, supplierId: string) {
  requirePermission(user, 'inventory.view');
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, organizationId: user.organizationId },
  });
  if (!supplier) throw new NotFoundError('supplier');
  const branch = await resolveInventoryBranch(user);

  const [preferredParts, purchases, purchasedLines, stock, totals] = await Promise.all([
    prisma.part.findMany({
      where: { organizationId: user.organizationId, preferredSupplierId: supplier.id },
      orderBy: { name: 'asc' },
    }),
    prisma.purchase.findMany({
      where: { organizationId: user.organizationId, supplierId: supplier.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { _count: { select: { items: true } } },
    }),
    prisma.purchaseItem.findMany({
      where: {
        organizationId: user.organizationId,
        purchase: { supplierId: supplier.id, status: { in: RECEIVED } },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        part: true,
        purchase: { select: { purchaseNumber: true, supplierInvoiceDate: true, createdAt: true } },
      },
    }),
    getStockByPart(user.organizationId, branch.id),
    balances(user.organizationId, [supplier.id]),
  ]);

  // Supplier parts: parts this supplier is preferred for, plus anything bought from them, with the last cost paid.
  const parts = new Map<
    string,
    {
      part: (typeof preferredParts)[number];
      preferred: boolean;
      lastCost: string | null;
      lastPurchase: string | null;
    }
  >();
  for (const part of preferredParts)
    parts.set(part.id, { part, preferred: true, lastCost: null, lastPurchase: null });
  for (const line of purchasedLines) {
    const entry = parts.get(line.partId) ?? {
      part: line.part,
      preferred: false,
      lastCost: null,
      lastPurchase: null,
    };
    if (entry.lastCost === null) {
      entry.lastCost = line.unitCost.toString();
      entry.lastPurchase = line.purchase.purchaseNumber;
    }
    parts.set(line.partId, entry);
  }

  return {
    supplier,
    parts: [...parts.values()]
      .map((entry) => {
        const onHandMilli = stock.get(entry.part.id) ?? 0;
        return { ...entry, onHandMilli, state: stockState(onHandMilli, entry.part.reorderLevel) };
      })
      .sort((a, b) => a.part.name.localeCompare(b.part.name)),
    purchases,
    balance: money(totals.get(supplier.id)),
  };
}

export async function getSupplierForEdit(user: AuthenticatedUser, supplierId: string) {
  requirePermission(user, 'inventory.manage');
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, organizationId: user.organizationId },
  });
  if (!supplier) throw new NotFoundError('supplier');
  return supplier;
}

/**
 * Deletes a supplier.
 *
 * One that was never used — no purchase, no part naming it as preferred —
 * is removed outright; the audit log keeps what it was. One with history is
 * archived (inactive: out of the pickers, still on every purchase, back with
 * Edit → Active). It is refused while a purchase is still open or money is
 * still owed to them — the same balance the Payables screen shows.
 */
export async function deleteSupplier(
  user: AuthenticatedUser,
  supplierId: string,
): Promise<{ outcome: 'deleted' | 'archived' }> {
  requirePermission(user, 'inventory.manage');
  const supplier = await prisma.supplier.findFirst({
    where: { id: supplierId, organizationId: user.organizationId },
    include: { _count: { select: { purchases: true, parts: true } } },
  });
  if (!supplier) throw new NotFoundError('supplier');
  if (!supplier.isActive) throw new DomainError(`${supplier.name} is already deleted.`);

  if (supplier._count.purchases === 0 && supplier._count.parts === 0) {
    return prisma.$transaction(async (tx) => {
      await tx.supplier.delete({ where: { id: supplier.id } });
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'supplier.deleted',
        entityType: 'Supplier',
        entityId: supplier.id,
        beforeData: { name: supplier.name, phone: supplier.phone, email: supplier.email },
      });
      return { outcome: 'deleted' as const };
    });
  }

  const open = await prisma.purchase.findFirst({
    where: {
      organizationId: user.organizationId,
      supplierId: supplier.id,
      status: { in: ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'] },
    },
    select: { purchaseNumber: true },
  });
  if (open) {
    throw new DomainError(
      `${supplier.name} has open purchase ${open.purchaseNumber}. Receive or cancel it first.`,
    );
  }
  const owed = money((await balances(user.organizationId, [supplier.id])).get(supplier.id));
  if (Number(owed.outstanding) > 0) {
    throw new DomainError(
      `${supplier.name} is still owed AED ${owed.outstanding}. Pay or settle it first.`,
    );
  }

  return prisma.$transaction(async (tx) => {
    await tx.supplier.update({ where: { id: supplier.id }, data: { isActive: false } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'supplier.archived',
      entityType: 'Supplier',
      entityId: supplier.id,
      beforeData: { isActive: true },
      afterData: { isActive: false },
    });
    return { outcome: 'archived' as const };
  });
}
