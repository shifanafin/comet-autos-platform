import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import {
  filsToString,
  formatMilli,
  milliToString,
  signedToMilli,
  toFils,
  toMilli,
} from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { pricePerUnit } from '@/lib/inventory/pack';
import { OPEN_JOB_STATUSES } from '@/lib/workshop/check-in';
import {
  getStockOnHand,
  lockPart,
  postMovement,
  resolveInventoryBranch,
  withNetQuantities,
} from '@/lib/inventory/stock';

/*
 * A part kept by the piece that is really used by the litre or kg (a can of AC
 * gas, a drum of coolant): stock, cost, selling price and minimum stock move to
 * the small unit together. Stock goes out at the old cost and comes back at the
 * new one, as two adjustments, so the books see any difference: a full can
 * nets to a fil or so, and what was already used shows as a cost.
 *
 * Past documents keep the quantities they were written in. Refused while a
 * purchase is to arrive, or the part is on an open job, a draft invoice or a
 * quotation still in play, because their quantities would change meaning.
 */

const QUANTITY = /^\d{1,7}(\.\d{1,3})?$/;

const conversionSchema = z.object({
  unit: z
    .string({ error: 'Choose the new unit.' })
    .trim()
    .min(1, 'Choose the new unit.')
    .max(20, 'Keep the unit short.'),
  /** How many new units one old one holds: 3 for a 3 kg can. */
  size: z
    .string({ error: 'Enter how much one holds.' })
    .trim()
    .regex(QUANTITY, 'Enter how much one holds, like 3 or 0.5.'),
  /** What is really left, in the new unit. */
  remaining: z
    .string({ error: 'Enter how much is left.' })
    .trim()
    .regex(QUANTITY, 'Enter how much is left, like 2.5 or 0.'),
  requestKey: z.string().optional(),
});

export async function convertPartUnit(user: AuthenticatedUser, partId: string, rawInput: unknown) {
  const input = parseInput(conversionSchema, rawInput);
  const unit = input.unit.toLowerCase();
  const sizeMilli = toMilli(input.size);
  if (sizeMilli <= 0) throw new DomainError('Enter how much one holds, like 3.', 'size');
  const remainingMilli = toMilli(input.remaining);

  return prisma.$transaction(
    async (tx) => {
      await claimRequestKey(tx, user, rawInput, 'part.convert_unit');
      const branch = await resolveInventoryBranch(user, tx);
      requirePermission(user, 'inventory.approve', { branchId: branch.id });
      await lockPart(tx, user.organizationId, partId);
      const part = await tx.part.findFirst({
        where: { id: partId, organizationId: user.organizationId },
      });
      if (!part) throw new NotFoundError('part');
      if (part.unitOfMeasure.toLowerCase() === unit) {
        throw new DomainError(`This part is already kept by the ${unit}.`, 'unit');
      }

      const open = await tx.purchase.findFirst({
        where: {
          organizationId: user.organizationId,
          status: { in: ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'] },
          items: { some: { partId } },
        },
        select: { purchaseNumber: true },
      });
      if (open) {
        throw new DomainError(
          `${open.purchaseNumber} is still to arrive with this part. Receive or cancel it first.`,
        );
      }
      const usages = await tx.partUsage.findMany({
        where: {
          organizationId: user.organizationId,
          partId,
          jobCard: { status: { in: OPEN_JOB_STATUSES } },
        },
        select: { id: true, quantity: true, jobCard: { select: { jobNumber: true } } },
      });
      const fitted = (await withNetQuantities(tx, user.organizationId, usages)).find(
        (usage) => usage.netMilli > 0,
      );
      if (fitted) {
        throw new DomainError(
          `It is fitted on open job ${fitted.jobCard.jobNumber}. Finish that job first.`,
        );
      }
      const draftInvoice = await tx.invoiceItem.findFirst({
        where: {
          organizationId: user.organizationId,
          partId,
          invoice: { status: 'DRAFT' },
        },
        select: { invoice: { select: { invoiceNumber: true } } },
      });
      if (draftInvoice) {
        throw new DomainError(
          `Draft invoice ${draftInvoice.invoice.invoiceNumber ?? ''} has this part. Issue or delete it first.`,
        );
      }
      const today = parseCalendarDate(localDateString())!;
      const quoted = await tx.estimateItem.findFirst({
        where: {
          organizationId: user.organizationId,
          partId,
          estimate: {
            OR: [
              // Still waiting for an answer, and not past its validity.
              {
                status: { in: ['DRAFT', 'SENT'] },
                replacedAt: null,
                OR: [{ validUntil: null }, { validUntil: { gte: today } }],
              },
              // Approved, with its job still open.
              { status: 'APPROVED', isCurrent: true, jobCard: { status: { in: OPEN_JOB_STATUSES } } },
            ],
          },
        },
        select: { estimate: { select: { estimateNumber: true } } },
      });
      if (quoted) {
        throw new DomainError(
          `Quotation ${quoted.estimate.estimateNumber} has this part. Replace or finish it first.`,
        );
      }
      const stockByBranch = await tx.inventoryTransaction.groupBy({
        by: ['branchId'],
        where: { organizationId: user.organizationId, partId },
        _sum: { quantity: true },
      });
      const elsewhere = stockByBranch.some(
        (row) => row.branchId !== branch.id && signedToMilli(row._sum.quantity) !== 0,
      );
      if (elsewhere) {
        throw new DomainError('Another branch holds this part too. Move its stock here first.');
      }

      const onHand = await getStockOnHand(tx, user.organizationId, branch.id, partId);
      const before = {
        unit: part.unitOfMeasure,
        cost: part.defaultCostPrice?.toString() ?? null,
        selling: part.defaultSellingPrice?.toString() ?? null,
        reorderLevel: part.reorderLevel?.toString() ?? null,
        onHand: milliToString(onHand),
      };
      const scale = (price: string | null) => (price ? pricePerUnit(price, input.size) : null);
      const after = {
        unit,
        cost: scale(before.cost),
        selling: scale(before.selling),
        reorderLevel: before.reorderLevel
          ? milliToString(Math.round((signedToMilli(before.reorderLevel) * sizeMilli) / 1000))
          : null,
        onHand: milliToString(remainingMilli),
      };
      const note = `Changed to ${unit}: 1 ${before.unit} = ${formatMilli(sizeMilli)} ${unit}`;
      const movement = {
        organizationId: user.organizationId,
        branchId: branch.id,
        partId,
        type: 'ADJUSTMENT' as const,
        performedByUserId: user.id,
        note,
      };

      if (onHand > 0) {
        await postMovement(tx, { ...movement, quantityMilli: -onHand, unitCost: before.cost });
      }
      await tx.part.update({
        where: { id: partId },
        data: {
          unitOfMeasure: unit,
          defaultCostPrice: after.cost,
          defaultSellingPrice: after.selling,
          reorderLevel: after.reorderLevel,
        },
      });
      if (remainingMilli > 0) {
        await postMovement(tx, {
          ...movement,
          quantityMilli: remainingMilli,
          unitCost: after.cost,
        });
      }

      const valueOf = (milli: number, price: string | null) =>
        price ? Math.round((milli * toFils(price)) / 1000) : 0;
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        branchId: branch.id,
        actorUserId: user.id,
        action: 'part.unit_converted',
        entityType: 'Part',
        entityId: partId,
        beforeData: before,
        afterData: after,
        metadata: {
          sku: part.sku,
          size: input.size,
          valueBefore: filsToString(valueOf(onHand, before.cost)),
          valueAfter: filsToString(valueOf(remainingMilli, after.cost)),
        },
      });
      await settleRequestKey(tx, user, rawInput, partId);
      return { id: partId };
    },
    { timeout: 30_000 },
  );
}
