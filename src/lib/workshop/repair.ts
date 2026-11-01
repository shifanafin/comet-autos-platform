import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { EstimateItemType } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey } from '@/lib/request-keys';
import { parseInput } from '@/lib/form-data';
import { calculateLabour, filsToString, formatMilli, multiplyQuantity, signedToMilli, toFils, toMilli, milliToString } from '@/lib/money';
import { getStockByPart, issueStockToJob, postMovement, withNetQuantities } from '@/lib/inventory/stock';
import { applyJobStatusChange, normalizeStatus } from '@/lib/workshop/job-status';

/*
 * Repair: APPROVED → REPAIR, then parts used and labour recorded against the
 * approved work, until the quality check.
 *
 * Every PartUsage / Labour row either fulfils an approved estimate line
 * (estimateItemId set) or is ADDITIONAL work the customer has not approved
 * (estimateItemId NULL). Additional work is recorded honestly but never
 * charged automatically: it has to be quoted and approved through an
 * ADDITIONAL estimate (lib/workshop/estimates.ts) first.
 */

async function lockJob(tx: Prisma.TransactionClient, organizationId: string, jobCardId: string) {
  await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${jobCardId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const jobCard = await tx.jobCard.findFirst({
    where: { id: jobCardId, organizationId },
    select: { id: true, branchId: true, status: true, jobNumber: true },
  });
  if (!jobCard) throw new NotFoundError('job card');
  return jobCard;
}

/** Estimate lines the customer has approved for this job (original quotation and any approved additional work). */
async function approvedLineIds(client: Prisma.TransactionClient, organizationId: string, jobCardId: string) {
  const items = await client.estimateItem.findMany({
    where: { organizationId, estimate: { jobCardId, organizationId, status: 'APPROVED' } },
    select: { id: true, itemType: true },
  });
  return new Map(items.map((item) => [item.id, item.itemType]));
}

async function requireApprovedLine(
  tx: Prisma.TransactionClient,
  organizationId: string,
  jobCardId: string,
  estimateItemId: string | null,
  expectedType: EstimateItemType,
) {
  if (!estimateItemId) return null;
  const approved = await approvedLineIds(tx, organizationId, jobCardId);
  const type = approved.get(estimateItemId);
  if (!type) throw new DomainError('Choose a line from the approved work.', 'estimateItemId');
  // An Other line (fuel, a wash) is marked done like labour: it has no part to fit.
  if (type !== expectedType && !(expectedType === 'LABOUR' && type === 'OTHER')) {
    throw new DomainError(
      expectedType === 'PART' ? 'That approved line is labour, not a part.' : 'That approved line is a part, not labour.',
      'estimateItemId',
    );
  }
  return estimateItemId;
}

async function requireEmployee(tx: Prisma.TransactionClient, organizationId: string, employeeId: string, message: string) {
  const employee = await tx.employee.findFirst({
    where: { id: employeeId, organizationId, isActive: true },
    select: { id: true },
  });
  if (!employee) throw new DomainError(message, 'employeeId');
  return employee.id;
}

/** APPROVED → REPAIR. Only possible when the customer has approved the quotation. */
export async function startRepair(user: AuthenticatedUser, jobCardId: string) {
  return prisma.$transaction(async (tx) => {
    const jobCard = await lockJob(tx, user.organizationId, jobCardId);
    requirePermission(user, 'job_card.edit', { branchId: jobCard.branchId });

    const approvedEstimate = await tx.estimate.findFirst({
      where: { jobCardId: jobCard.id, organizationId: user.organizationId, kind: 'ORIGINAL', status: 'APPROVED' },
      select: { id: true, estimateNumber: true },
    });
    if (!approvedEstimate) {
      throw new DomainError('Repair can only start once the customer has approved the estimate.');
    }
    if (normalizeStatus(jobCard.status) !== 'APPROVED') {
      throw new DomainError('Repair can only start on an approved job.');
    }

    await applyJobStatusChange(tx, {
      organizationId: user.organizationId,
      jobCardId: jobCard.id,
      toStatus: 'REPAIR',
      actor: { userId: user.id },
      source: 'workflow',
      metadata: { estimateId: approvedEstimate.id },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: jobCard.branchId,
      actorUserId: user.id,
      action: 'repair.started',
      entityType: 'JobCard',
      entityId: jobCard.id,
      afterData: { approvedEstimate: approvedEstimate.estimateNumber },
    });
  });
}

const partUsageSchema = z.object({
  partId: z.uuid('Choose the part used.'),
  quantity: z
    .string({ error: 'Enter the quantity used.' })
    .trim()
    .min(1, 'Enter the quantity used.')
    .refine((value) => /^\d+(\.\d{1,3})?$/.test(value) && Number(value) > 0, 'Quantity must be a positive number (up to 3 decimals).')
    .refine((value) => Number(value) <= 10000, 'That quantity is not realistic.'),
  employeeId: z.uuid('Choose who fitted the part.'),
  estimateItemId: z.union([z.literal(''), z.uuid()]).optional(),
  /** Only used when the part has no selling price of its own. */
  unitPrice: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || /^\d+(\.\d{1,2})?$/.test(value),
      'The selling price must be an amount like 45 or 45.50.',
    )
    .refine((value) => !value || Number(value) <= 1_000_000, 'The selling price is not realistic.'),
});

/**
 * Records a part fitted to the vehicle: one PartUsage (cost and selling
 * price snapshotted from the part now, so later price changes never rewrite
 * history) plus one JOB_CONSUMPTION stock-out, in one transaction. A part
 * with no selling price takes the price entered with the usage.
 */
export async function recordPartUsage(user: AuthenticatedUser, jobCardId: string, rawInput: unknown) {
  const input = parseInput(partUsageSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'part_usage.record');
    const jobCard = await lockJob(tx, user.organizationId, jobCardId);
    requirePermission(user, 'job_card.edit', { branchId: jobCard.branchId });
    requirePermission(user, 'inventory.edit', { branchId: jobCard.branchId });
    if (normalizeStatus(jobCard.status) !== 'REPAIR') {
      throw new DomainError('Parts can only be recorded while the job is in repair.');
    }

    const part = await tx.part.findFirst({
      where: { id: input.partId, organizationId: user.organizationId, isActive: true },
    });
    if (!part) throw new DomainError('Choose a part from the inventory.', 'partId');
    if (part.defaultCostPrice === null) {
      throw new DomainError(`${part.name} has no cost price set, so it can't be issued yet.`, 'partId');
    }
    const unitPrice = part.defaultSellingPrice?.toString() ?? input.unitPrice;
    if (!unitPrice) {
      throw new DomainError(`${part.name} has no selling price — enter the price to charge.`, 'unitPrice');
    }
    const employeeId = await requireEmployee(tx, user.organizationId, input.employeeId, 'Choose who fitted the part.');
    const estimateItemId = await requireApprovedLine(tx, user.organizationId, jobCard.id, input.estimateItemId || null, 'PART');
    const quantityMilli = toMilli(input.quantity);

    const usage = await tx.partUsage.create({
      data: {
        organizationId: user.organizationId,
        jobCardId: jobCard.id,
        partId: part.id,
        usedByEmployeeId: employeeId,
        estimateItemId,
        quantity: milliToString(quantityMilli),
        unitCost: part.defaultCostPrice.toString(),
        unitPrice,
      },
    });
    const ledger = await issueStockToJob(tx, {
      organizationId: user.organizationId,
      branchId: jobCard.branchId,
      partId: part.id,
      quantityMilli,
      unitCost: part.defaultCostPrice.toString(),
      partUsageId: usage.id,
      performedByUserId: user.id,
      note: `Issued to job ${jobCard.jobNumber}`,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: jobCard.branchId,
      actorUserId: user.id,
      action: 'part_usage.recorded',
      entityType: 'PartUsage',
      entityId: usage.id,
      afterData: {
        jobCardId: jobCard.id,
        partId: part.id,
        sku: part.sku,
        quantity: usage.quantity.toString(),
        unitCost: usage.unitCost.toString(),
        unitPrice: usage.unitPrice.toString(),
        approvedLine: estimateItemId,
        additionalWork: estimateItemId === null,
      },
      metadata: { inventoryTransactionId: ledger.id },
    });
    return usage;
  });
}

const labourSchema = z.object({
  employeeId: z.uuid('Choose the technician.'),
  description: z.string({ error: 'Describe the work performed.' }).trim().min(3, 'Describe the work performed.').max(300),
  hours: z
    .string({ error: 'Enter the hours worked.' })
    .trim()
    .refine((value) => /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0, 'Hours must be a positive number (up to 2 decimals).')
    .refine((value) => Number(value) <= 100, 'That is more than 100 hours — split it into separate entries.'),
  rate: z
    .string({ error: 'Enter the hourly rate.' })
    .trim()
    .refine((value) => /^\d+(\.\d{1,2})?$/.test(value), 'Rate must be an amount like 150 or 150.00.')
    .refine((value) => Number(value) <= 100000, 'That rate is not realistic.'),
  estimateItemId: z.union([z.literal(''), z.uuid()]).optional(),
});

/** Records billable labour. Amount = hours × rate, calculated here; the rate used is stored with the entry. */
export async function recordLabour(user: AuthenticatedUser, jobCardId: string, rawInput: unknown) {
  const input = parseInput(labourSchema, rawInput);
  const amounts = calculateLabour({ hours: input.hours, rate: input.rate });

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'labour.record');
    const jobCard = await lockJob(tx, user.organizationId, jobCardId);
    requirePermission(user, 'job_card.edit', { branchId: jobCard.branchId });
    if (normalizeStatus(jobCard.status) !== 'REPAIR') {
      throw new DomainError('Labour can only be recorded while the job is in repair.');
    }
    const employeeId = await requireEmployee(tx, user.organizationId, input.employeeId, 'Choose the technician.');
    const estimateItemId = await requireApprovedLine(tx, user.organizationId, jobCard.id, input.estimateItemId || null, 'LABOUR');

    const labour = await tx.labour.create({
      data: {
        organizationId: user.organizationId,
        jobCardId: jobCard.id,
        performedByEmployeeId: employeeId,
        estimateItemId,
        description: input.description,
        hours: amounts.hours,
        rate: amounts.rate,
        amount: amounts.amount,
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: jobCard.branchId,
      actorUserId: user.id,
      action: 'labour.recorded',
      entityType: 'Labour',
      entityId: labour.id,
      afterData: {
        jobCardId: jobCard.id,
        employeeId,
        hours: amounts.hours,
        rate: amounts.rate,
        amount: amounts.amount,
        approvedLine: estimateItemId,
        additionalWork: estimateItemId === null,
      },
    });
    return labour;
  });
}

export type LineProgress = 'NOT_STARTED' | 'PARTLY_DONE' | 'DONE';

/** Everything the repair sections of the job card show. */
export async function getRepairWorkspace(user: AuthenticatedUser, jobCardId: string) {
  const jobCard = await prisma.jobCard.findFirst({
    where: { id: jobCardId, organizationId: user.organizationId },
    select: { id: true, branchId: true },
  });
  if (!jobCard) throw new NotFoundError('job card');
  requirePermission(user, 'job_card.view', { branchId: jobCard.branchId });

  const [approvedEstimates, additionalEstimates, recordedUsages, labours, qualityChecks, parts, stock] = await Promise.all([
    prisma.estimate.findMany({
      where: { organizationId: user.organizationId, jobCardId, status: 'APPROVED' },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      include: { items: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
    }),
    prisma.estimate.findMany({
      where: { organizationId: user.organizationId, jobCardId, kind: 'ADDITIONAL' },
      orderBy: { createdAt: 'desc' },
      include: {
        items: { select: { id: true } },
        approvals: { orderBy: { decidedAt: 'desc' }, take: 1, select: { status: true, decidedAt: true, approvalMethod: true } },
      },
    }),
    prisma.partUsage.findMany({
      where: { organizationId: user.organizationId, jobCardId },
      orderBy: { usedAt: 'asc' },
      include: {
        part: { select: { sku: true, name: true, unitOfMeasure: true } },
        usedByEmployee: { select: { firstName: true, lastName: true } },
        estimateItem: { select: { description: true } },
      },
    }),
    prisma.labour.findMany({
      where: { organizationId: user.organizationId, jobCardId },
      orderBy: { performedAt: 'asc' },
      include: {
        performedByEmployee: { select: { firstName: true, lastName: true } },
        estimateItem: { select: { description: true } },
      },
    }),
    prisma.qualityCheck.findMany({
      where: { organizationId: user.organizationId, jobCardId },
      orderBy: [{ checkedAt: 'desc' }, { id: 'desc' }],
      include: {
        checkedByEmployee: { select: { firstName: true, lastName: true } },
        recordedBy: { select: { fullName: true } },
      },
    }),
    prisma.part.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, sku: true, name: true, unitOfMeasure: true, defaultSellingPrice: true },
    }),
    getStockByPart(user.organizationId, jobCard.branchId),
  ]);
  const partUsages = await withNetQuantities(prisma, user.organizationId, recordedUsages);

  const approvedLines = approvedEstimates.flatMap((estimate) =>
    estimate.items.map((item) => {
      const approvedMilli = signedToMilli(item.quantity);
      if (item.itemType !== 'PART') {
        const recorded = labours.filter((l) => l.estimateItemId === item.id);
        const doneHundredths = recorded.reduce((sum, l) => sum + toFils(l.hours.toString()), 0);
        return {
          id: item.id,
          estimateNumber: estimate.estimateNumber,
          kind: estimate.kind,
          itemType: item.itemType,
          description: item.description,
          approvedQuantity: approvedMilli,
          doneQuantity: doneHundredths * 10,
          lineTotal: item.lineTotal.toString(),
          unitPrice: item.unitPrice.toString(),
          progress: (recorded.length > 0 ? 'DONE' : 'NOT_STARTED') as LineProgress,
        };
      }
      const usedMilli = partUsages.filter((u) => u.estimateItemId === item.id).reduce((sum, u) => sum + u.netMilli, 0);
      return {
        id: item.id,
        estimateNumber: estimate.estimateNumber,
        kind: estimate.kind,
        itemType: item.itemType,
        description: item.description,
        approvedQuantity: approvedMilli,
        doneQuantity: usedMilli,
        lineTotal: item.lineTotal.toString(),
        unitPrice: item.unitPrice.toString(),
        progress: (usedMilli >= approvedMilli ? 'DONE' : usedMilli > 0 ? 'PARTLY_DONE' : 'NOT_STARTED') as LineProgress,
      };
    }),
  );

  const partLine = (u: (typeof partUsages)[number]) => multiplyQuantity(milliToString(u.netMilli), u.unitPrice.toString());
  const totals = {
    approvedFils: approvedEstimates.reduce((sum, e) => sum + toFils(e.subtotal.toString()), 0),
    partsFils: partUsages.filter((u) => u.estimateItemId).reduce((sum, u) => sum + partLine(u), 0),
    labourFils: labours.filter((l) => l.estimateItemId).reduce((sum, l) => sum + toFils(l.amount.toString()), 0),
    unapprovedFils:
      partUsages.filter((u) => !u.estimateItemId).reduce((sum, u) => sum + partLine(u), 0) +
      labours.filter((l) => !l.estimateItemId).reduce((sum, l) => sum + toFils(l.amount.toString()), 0),
  };

  return {
    approvedLines,
    remainingLines: approvedLines.filter((line) => line.progress !== 'DONE'),
    additionalEstimates,
    pendingAdditional: additionalEstimates.find((e) => e.status === 'SENT') ?? null,
    partUsages,
    labours,
    qualityChecks,
    latestQualityCheck: qualityChecks[0] ?? null,
    partsCatalog: parts.map((part) => ({
      id: part.id,
      sku: part.sku,
      name: part.name,
      unitOfMeasure: part.unitOfMeasure,
      sellingPrice: part.defaultSellingPrice?.toString() ?? null,
      stockMilli: stock.get(part.id) ?? 0,
    })),
    totals: {
      approved: filsToString(totals.approvedFils),
      parts: filsToString(totals.partsFils),
      labour: filsToString(totals.labourFils),
      unapproved: filsToString(totals.unapprovedFils),
    },
  };
}

export type RepairWorkspace = Awaited<ReturnType<typeof getRepairWorkspace>>;

/**
 * Approved estimate lines not yet completed — the single rule used by the
 * workspace and by the quality check. A labour line is complete once labour
 * is recorded against it; a part line once the fitted quantity reaches the
 * approved quantity.
 */
export async function getIncompleteApprovedLines(
  client: Prisma.TransactionClient,
  organizationId: string,
  jobCardId: string,
) {
  const [items, labours, usages] = await Promise.all([
    client.estimateItem.findMany({
      where: { organizationId, estimate: { jobCardId, organizationId, status: 'APPROVED' } },
      select: { id: true, itemType: true, description: true, quantity: true },
    }),
    client.labour.findMany({ where: { organizationId, jobCardId, estimateItemId: { not: null } }, select: { estimateItemId: true } }),
    client.partUsage
      .findMany({
        where: { organizationId, jobCardId, estimateItemId: { not: null } },
        select: { id: true, estimateItemId: true, quantity: true },
      })
      .then((rows) => withNetQuantities(client, organizationId, rows)),
  ]);
  return items.filter((item) => {
    if (item.itemType !== 'PART') return !labours.some((l) => l.estimateItemId === item.id);
    const fitted = usages.filter((u) => u.estimateItemId === item.id).reduce((sum, u) => sum + u.netMilli, 0);
    return fitted < signedToMilli(item.quantity);
  });
}

const partReturnSchema = z.object({
  quantity: z
    .string({ error: 'Enter the quantity taken back.' })
    .trim()
    .refine((value) => /^\d+(\.\d{1,3})?$/.test(value) && Number(value) > 0, 'Quantity must be a positive number (up to 3 decimals).'),
  reason: z.string({ error: 'Say why the part is being taken back.' }).trim().min(3, 'Say why the part is being taken back.').max(300),
});

/**
 * Corrects a part recorded on a job — wrong part, or fewer used than
 * recorded — by taking it back into stock. Writes a JOB_RETURN ledger row
 * linked to the PartUsage; nothing is deleted or edited, so the original
 * usage, the return and who made each stay in the history. The usage's net
 * quantity (fitted minus returns) is what repair progress, the quality check
 * and billing see. Only while the job is in repair, so work that already
 * passed QC or was invoiced can't be changed underneath it.
 */
export async function returnPartFromJob(user: AuthenticatedUser, jobCardId: string, partUsageId: string, rawInput: unknown) {
  const input = parseInput(partReturnSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'part_usage.return');
    const jobCard = await lockJob(tx, user.organizationId, jobCardId);
    requirePermission(user, 'job_card.edit', { branchId: jobCard.branchId });
    requirePermission(user, 'inventory.edit', { branchId: jobCard.branchId });
    if (normalizeStatus(jobCard.status) !== 'REPAIR') {
      throw new DomainError('Parts can only be taken back while the job is in repair.');
    }

    const usage = await tx.partUsage.findFirst({
      where: { id: partUsageId, organizationId: user.organizationId, jobCardId: jobCard.id },
      include: { part: { select: { name: true, sku: true } } },
    });
    if (!usage) throw new NotFoundError('part record');
    const quantityMilli = toMilli(input.quantity);
    // The ledger movement locks the part row; take the lock first so the
    // "how many are left on the job" check can't race a concurrent return.
    await tx.$queryRaw`SELECT id FROM parts WHERE id = ${usage.partId}::uuid FOR UPDATE`;
    const [current] = await withNetQuantities(tx, user.organizationId, [usage]);
    if (current.netMilli <= 0) throw new DomainError('This part has already been taken back in full.', 'quantity');
    if (quantityMilli > current.netMilli) {
      throw new DomainError(`Only ${formatMilli(current.netMilli)} of this part is still on the job.`, 'quantity');
    }

    const ledger = await postMovement(tx, {
      organizationId: user.organizationId,
      branchId: jobCard.branchId,
      partId: usage.partId,
      type: 'JOB_RETURN',
      quantityMilli,
      unitCost: usage.unitCost.toString(),
      partUsageId: usage.id,
      performedByUserId: user.id,
      note: `Taken back from job ${jobCard.jobNumber}: ${input.reason}`,
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: jobCard.branchId,
      actorUserId: user.id,
      action: 'part_usage.returned',
      entityType: 'PartUsage',
      entityId: usage.id,
      beforeData: { netQuantity: milliToString(current.netMilli) },
      afterData: { netQuantity: milliToString(current.netMilli - quantityMilli), returned: milliToString(quantityMilli) },
      metadata: { jobCardId: jobCard.id, sku: usage.part.sku, reason: input.reason, inventoryTransactionId: ledger.id },
    });
    return ledger;
  });
}
