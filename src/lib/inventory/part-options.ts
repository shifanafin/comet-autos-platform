import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { resolveDefaultVatRate } from '@/lib/tax';
import { OPEN_JOB_STATUSES } from '@/lib/workshop/check-in';
import {
  getStockByPart,
  getStockOnHand,
  resolveInventoryBranch,
  signedMilliToString,
} from '@/lib/inventory/stock';

/*
 * The parts a line can be picked from — invoices, quotations, purchases —
 * with what is in stock at the user's branch, so whoever types a line sees
 * at once whether the workshop has the part, and at what price.
 */

export interface PartOption {
  id: string;
  sku: string;
  name: string;
  unit: string;
  /** Last cost price ("45.00"), or "" when none is set. */
  cost: string;
  /** Selling price, or "" when the part has none. */
  price: string;
  taxRate: string;
  supplierId: string | null;
  /** The supplier it is usually bought from, shown beside it in the list. */
  supplierName: string | null;
  /** Stock on hand at the user's branch, as a decimal ("3.000"; negative when oversold). */
  stock: string;
  /** The open jobs it was bought for: "JC-000017 · SHJ 75633". */
  forJobs?: string[];
}

/** What the part picker needs: the parts, the suppliers to file a new one under, and whether it may add one. */
export interface PartCatalog {
  parts: PartOption[];
  suppliers: { id: string; name: string }[];
  canCreate: boolean;
  /** May record a part bought for a job (a purchase, received) from an invoice line. */
  canBuy?: boolean;
  /** May record paying the shop for it there and then. */
  canPay?: boolean;
  /** The workshop's standard VAT rate ("5.00"), the default for a new part. */
  defaultVat: string;
}

const partSelect = {
  id: true,
  sku: true,
  name: true,
  unitOfMeasure: true,
  defaultCostPrice: true,
  defaultSellingPrice: true,
  defaultTaxRate: true,
  preferredSupplierId: true,
  preferredSupplier: { select: { name: true } },
} as const;

type PartRow = {
  id: string;
  sku: string;
  name: string;
  unitOfMeasure: string;
  defaultCostPrice: { toString(): string } | null;
  defaultSellingPrice: { toString(): string } | null;
  defaultTaxRate: { toString(): string } | null;
  preferredSupplierId: string | null;
  preferredSupplier: { name: string } | null;
};

/** The open jobs each part was bought for. A label only: anyone may still use the part. */
async function jobsByPart(organizationId: string, partIds?: string[]) {
  const rows = await prisma.purchaseItem.findMany({
    where: {
      organizationId,
      ...(partIds ? { partId: { in: partIds } } : {}),
      jobCard: { status: { in: OPEN_JOB_STATUSES } },
      purchase: { status: { not: 'CANCELLED' } },
    },
    select: {
      partId: true,
      jobCard: { select: { jobNumber: true, vehicle: { select: { plateNumber: true } } } },
    },
  });
  const byPart = new Map<string, string[]>();
  for (const { partId, jobCard } of rows) {
    if (!jobCard) continue;
    const label = `${jobCard.jobNumber} · ${jobCard.vehicle.plateNumber}`;
    const labels = byPart.get(partId) ?? [];
    if (!labels.includes(label)) labels.push(label);
    byPart.set(partId, labels);
  }
  return byPart;
}

const toOption = (part: PartRow, stockMilli: number, forJobs?: string[]): PartOption => ({
  id: part.id,
  sku: part.sku,
  name: part.name,
  unit: part.unitOfMeasure,
  cost: part.defaultCostPrice?.toString() ?? '',
  price: part.defaultSellingPrice?.toString() ?? '',
  taxRate: part.defaultTaxRate?.toString() ?? '',
  supplierId: part.preferredSupplierId,
  supplierName: part.preferredSupplier?.name ?? null,
  stock: signedMilliToString(stockMilli),
  ...(forJobs?.length ? { forJobs } : {}),
});

/** Every active part with its stock at the user's branch. The caller has checked permission. */
export async function loadPartOptions(user: AuthenticatedUser): Promise<PartOption[]> {
  const branch = await resolveInventoryBranch(user);
  const [parts, stock, forJobs] = await Promise.all([
    prisma.part.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: partSelect,
    }),
    getStockByPart(user.organizationId, branch.id),
    jobsByPart(user.organizationId),
  ]);
  return parts.map((part) => toOption(part, stock.get(part.id) ?? 0, forJobs.get(part.id)));
}

/** One part as an option — a part just added from the picker. */
export async function getPartOption(user: AuthenticatedUser, partId: string): Promise<PartOption> {
  const part = await prisma.part.findFirst({
    where: { id: partId, organizationId: user.organizationId },
    select: partSelect,
  });
  if (!part) throw new NotFoundError('part');
  const branch = await resolveInventoryBranch(user);
  const [stock, forJobs] = await Promise.all([
    getStockOnHand(prisma, user.organizationId, branch.id, part.id),
    jobsByPart(user.organizationId, [part.id]),
  ]);
  return toOption(part, stock, forJobs.get(part.id));
}

/**
 * The picker's catalogue for an invoice or quotation: empty for someone who
 * may not see the inventory (they type the line as before).
 */
export async function getPartCatalog(
  user: AuthenticatedUser,
  /** An invoice: whoever may invoice sees the parts, since every Parts line must name one. */
  options: { forSale?: boolean } = {},
): Promise<PartCatalog> {
  const sees =
    hasPermission(user, 'inventory.view') ||
    (options.forSale === true && hasPermission(user, 'invoice.create'));
  if (!sees) {
    return { parts: [], suppliers: [], canCreate: false, defaultVat: '' };
  }
  const canCreate = hasPermission(user, 'inventory.create');
  const canBuy =
    options.forSale === true &&
    hasPermission(user, 'purchase.create') &&
    hasPermission(user, 'purchase.approve');
  const canPay = canBuy && hasPermission(user, 'supplier_payment.create');
  const [parts, suppliers, defaultVat] = await Promise.all([
    loadPartOptions(user),
    canCreate || canBuy
      ? prisma.supplier.findMany({
          where: { organizationId: user.organizationId, isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    resolveDefaultVatRate(user.organizationId),
  ]);
  return { parts, suppliers, canCreate, canBuy, canPay, defaultVat };
}
