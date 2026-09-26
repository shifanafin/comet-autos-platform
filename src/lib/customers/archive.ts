import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { CLOSED_JOB_STATUSES } from '@/lib/workshop/stages';

/*
 * Deleting customers and vehicles.
 *
 * Nothing the workshop has billed or worked on is ever destroyed: invoices,
 * job cards and receipts point at the customer and vehicle, and must keep
 * showing who and what they were for. "Delete" therefore archives — the
 * record leaves every list, search and picker, its history stays, and it can
 * be restored. Anything still in progress (an open job card, an unpaid
 * invoice, a booked appointment) has to be finished first, so nothing live
 * is orphaned.
 */

const reasonSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  requestKey: z.string().optional(),
});

const OPEN_APPOINTMENTS = ['SCHEDULED', 'CONFIRMED'] as const;

async function assertNothingOpen(
  tx: Prisma.TransactionClient,
  organizationId: string,
  where: { customerId: string } | { vehicleId: string },
  who: string,
) {
  const openJob = await tx.jobCard.findFirst({
    where: { organizationId, ...where, status: { notIn: CLOSED_JOB_STATUSES } },
    select: { jobNumber: true },
  });
  if (openJob) {
    throw new DomainError(
      `${who} has an open job card (${openJob.jobNumber}). Finish or cancel it first.`,
    );
  }
  const appointment = await tx.appointment.findFirst({
    where: { organizationId, ...where, status: { in: [...OPEN_APPOINTMENTS] } },
    select: { id: true },
  });
  if (appointment) {
    throw new DomainError(`${who} has a booked appointment. Cancel it first.`);
  }
}

export async function archiveCustomer(
  user: AuthenticatedUser,
  customerId: string,
  rawInput: unknown,
) {
  const input = parseInput(reasonSchema, rawInput);
  requirePermission(user, 'customer.edit');
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'customer.archive');
    const customer = await tx.customer.findFirst({
      where: { id: customerId, organizationId: user.organizationId },
      select: { id: true, name: true, isActive: true },
    });
    if (!customer) throw new NotFoundError('customer');
    if (!customer.isActive) throw new DomainError('This customer is already deleted.');

    await assertNothingOpen(tx, user.organizationId, { customerId: customer.id }, customer.name);
    const unpaid = await tx.invoice.findFirst({
      where: {
        organizationId: user.organizationId,
        customerId: customer.id,
        status: { in: ['ISSUED', 'PARTIALLY_PAID'] },
      },
      select: { invoiceNumber: true },
    });
    if (unpaid) {
      throw new DomainError(
        `${customer.name} still owes money on invoice ${unpaid.invoiceNumber}. Settle or void it first.`,
      );
    }
    // Their cars go with them — and come back with them on restore.
    const vehicles = await tx.vehicle.findMany({
      where: { organizationId: user.organizationId, customerId: customer.id, isActive: true },
      select: { id: true, plateNumber: true },
    });
    for (const vehicle of vehicles) {
      await assertNothingOpen(
        tx,
        user.organizationId,
        { vehicleId: vehicle.id },
        vehicle.plateNumber,
      );
    }

    await tx.customer.update({ where: { id: customer.id }, data: { isActive: false } });
    await tx.vehicle.updateMany({
      where: { id: { in: vehicles.map((v) => v.id) } },
      data: { isActive: false },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'customer.archived',
      entityType: 'Customer',
      entityId: customer.id,
      beforeData: { isActive: true },
      afterData: { isActive: false },
      metadata: { reason: input.reason ?? null, vehicleIds: vehicles.map((v) => v.id) },
    });
    await settleRequestKey(tx, user, rawInput, customer.id);
    return { customerId: customer.id };
  });
}

export async function restoreCustomer(user: AuthenticatedUser, customerId: string) {
  requirePermission(user, 'customer.edit');
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({
      where: { id: customerId, organizationId: user.organizationId },
      select: { id: true, isActive: true },
    });
    if (!customer) throw new NotFoundError('customer');
    if (customer.isActive) return { customerId: customer.id };

    // Bring back the vehicles that were deleted along with the customer.
    const archived = await tx.auditLog.findFirst({
      where: {
        organizationId: user.organizationId,
        entityId: customer.id,
        action: 'customer.archived',
      },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    const vehicleIds = (
      (archived?.metadata as { vehicleIds?: string[] } | null)?.vehicleIds ?? []
    ).filter((id) => typeof id === 'string');

    await tx.customer.update({ where: { id: customer.id }, data: { isActive: true } });
    await tx.vehicle.updateMany({
      where: {
        organizationId: user.organizationId,
        id: { in: vehicleIds },
        customerId: customer.id,
      },
      data: { isActive: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'customer.restored',
      entityType: 'Customer',
      entityId: customer.id,
      beforeData: { isActive: false },
      afterData: { isActive: true },
      metadata: { vehicleIds },
    });
    return { customerId: customer.id };
  });
}

export async function archiveVehicle(
  user: AuthenticatedUser,
  vehicleId: string,
  rawInput: unknown,
) {
  const input = parseInput(reasonSchema, rawInput);
  requirePermission(user, 'vehicle.edit');
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'vehicle.archive');
    const vehicle = await tx.vehicle.findFirst({
      where: { id: vehicleId, organizationId: user.organizationId },
      select: { id: true, plateNumber: true, isActive: true, customerId: true },
    });
    if (!vehicle) throw new NotFoundError('vehicle');
    if (!vehicle.isActive) throw new DomainError('This vehicle is already deleted.');
    await assertNothingOpen(
      tx,
      user.organizationId,
      { vehicleId: vehicle.id },
      vehicle.plateNumber,
    );

    await tx.vehicle.update({ where: { id: vehicle.id }, data: { isActive: false } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'vehicle.archived',
      entityType: 'Vehicle',
      entityId: vehicle.id,
      beforeData: { isActive: true },
      afterData: { isActive: false },
      metadata: { reason: input.reason ?? null, customerId: vehicle.customerId },
    });
    await settleRequestKey(tx, user, rawInput, vehicle.id);
    return { vehicleId: vehicle.id, customerId: vehicle.customerId };
  });
}

export async function restoreVehicle(user: AuthenticatedUser, vehicleId: string) {
  requirePermission(user, 'vehicle.edit');
  return prisma.$transaction(async (tx) => {
    const vehicle = await tx.vehicle.findFirst({
      where: { id: vehicleId, organizationId: user.organizationId },
      select: { id: true, isActive: true, customer: { select: { name: true, isActive: true } } },
    });
    if (!vehicle) throw new NotFoundError('vehicle');
    if (vehicle.isActive) return { vehicleId: vehicle.id };
    if (!vehicle.customer.isActive) {
      throw new DomainError(
        `The owner, ${vehicle.customer.name}, is deleted. Restore the customer first.`,
      );
    }
    await tx.vehicle.update({ where: { id: vehicle.id }, data: { isActive: true } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'vehicle.restored',
      entityType: 'Vehicle',
      entityId: vehicle.id,
      beforeData: { isActive: false },
      afterData: { isActive: true },
    });
    return { vehicleId: vehicle.id };
  });
}
