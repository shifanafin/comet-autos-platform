import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull, normalizePlate, normalizeVin } from '@/lib/normalize';
import { searchVehicles, vehiclePlateExists } from '@/lib/customers/search';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';

export { PLATE_EMIRATES } from '@/lib/vehicles/constants';

/** Upper sanity bound for an odometer reading, in km. */
export const MAX_MILEAGE = 2_000_000;

export const vehicleSchema = z.object({
  plateNumber: z
    .string({ error: 'Registration number is required.' })
    .trim()
    .min(1, 'Registration number is required.')
    .max(20, 'Registration number is too long.')
    .refine((value) => /^[A-Za-z0-9\s-]+$/.test(value), 'Use letters, numbers and spaces only.'),
  plateEmirate: z.string().trim().optional(),
  vin: z
    .string()
    .trim()
    .optional()
    .refine(
      (value) => !value || /^[A-Za-z0-9]{1,17}$/.test(value.replace(/\s+/g, '')),
      'VIN must be up to 17 letters and numbers.',
    ),
  make: z.string({ error: 'Make is required.' }).trim().min(1, 'Make is required.').max(60),
  model: z.string({ error: 'Model is required.' }).trim().min(1, 'Model is required.').max(60),
  year: z
    .string()
    .trim()
    .optional()
    .refine((value) => !value || /^\d{4}$/.test(value), 'Year must be four digits.')
    .refine(
      (value) => !value || (Number(value) >= 1950 && Number(value) <= new Date().getFullYear() + 1),
      'Enter a realistic model year.',
    )
    .transform((value) => (value ? Number(value) : null)),
  color: z.string().trim().max(40).optional(),
});

export type VehicleInput = z.input<typeof vehicleSchema>;

async function assertUniqueIdentifiers(
  tx: Prisma.TransactionClient,
  organizationId: string,
  plateNumber: string,
  vin: string | null,
  excludeVehicleId?: string,
) {
  const plateClash = await vehiclePlateExists(tx, organizationId, plateNumber, excludeVehicleId);
  if (plateClash === 'deleted') {
    throw new DomainError(
      'A deleted vehicle has this registration. Restore it from Vehicles › Deleted instead.',
      'plateNumber',
    );
  }
  if (plateClash) {
    throw new DomainError('A vehicle with this registration is already on file.', 'plateNumber');
  }
  if (vin) {
    const clash = await tx.vehicle.findFirst({
      where: {
        organizationId,
        vin,
        ...(excludeVehicleId ? { id: { not: excludeVehicleId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new DomainError('A vehicle with this VIN is already on file.', 'vin');
  }
}

function toVehicleData(input: z.infer<typeof vehicleSchema>) {
  return {
    plateNumber: normalizePlate(input.plateNumber),
    plateEmirate: emptyToNull(input.plateEmirate),
    vin: normalizeVin(input.vin),
    make: input.make,
    model: input.model,
    year: input.year,
    color: emptyToNull(input.color),
  };
}

export async function createVehicle(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  customerId: string | undefined,
  rawInput: VehicleInput,
) {
  requirePermission(user, 'vehicle.create');
  const data = toVehicleData(parseInput(vehicleSchema, rawInput));
  const customer = customerId
    ? await tx.customer.findFirst({
        where: { id: customerId, organizationId: user.organizationId, isActive: true },
        select: { id: true },
      })
    : null;
  if (!customer) throw new DomainError('Choose the customer who owns this vehicle.', 'customerId');
  await assertUniqueIdentifiers(tx, user.organizationId, data.plateNumber, data.vin);

  const vehicle = await tx.vehicle.create({
    data: { organizationId: user.organizationId, customerId: customer.id, ...data },
  });
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId: user.primaryBranchId,
    actorUserId: user.id,
    action: 'vehicle.created',
    entityType: 'Vehicle',
    entityId: vehicle.id,
    afterData: { ...data, customerId: customer.id },
  });
  return vehicle;
}

export async function updateVehicle(
  user: AuthenticatedUser,
  vehicleId: string,
  rawInput: VehicleInput,
) {
  requirePermission(user, 'vehicle.edit');
  const data = toVehicleData(parseInput(vehicleSchema, rawInput));
  return prisma.$transaction(async (tx) => {
    const before = await tx.vehicle.findFirst({
      where: { id: vehicleId, organizationId: user.organizationId },
    });
    if (!before) throw new NotFoundError('vehicle');
    await assertUniqueIdentifiers(tx, user.organizationId, data.plateNumber, data.vin, before.id);
    const vehicle = await tx.vehicle.update({ where: { id: before.id }, data });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'vehicle.updated',
      entityType: 'Vehicle',
      entityId: vehicle.id,
      beforeData: {
        plateNumber: before.plateNumber,
        plateEmirate: before.plateEmirate,
        vin: before.vin,
        make: before.make,
        model: before.model,
        year: before.year,
        color: before.color,
      },
      afterData: data,
    });
    return vehicle;
  });
}

export async function listVehicles(
  user: AuthenticatedUser,
  query: string,
  take = 50,
  /** The deleted (archived) vehicles instead, to find one to restore. */
  deleted = false,
) {
  requirePermission(user, 'vehicle.view');
  if (deleted) {
    const trimmed = query.trim();
    return prisma.vehicle.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: false,
        ...(trimmed
          ? {
              OR: [
                { plateNumber: { contains: trimmed, mode: 'insensitive' } },
                { make: { contains: trimmed, mode: 'insensitive' } },
                { model: { contains: trimmed, mode: 'insensitive' } },
                { vin: { contains: trimmed, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
      take,
      include: { customer: { select: { id: true, name: true, phone: true } } },
    });
  }
  if (query.trim().length >= 2) return searchVehicles(user.organizationId, query, take);
  return prisma.vehicle.findMany({
    where: { organizationId: user.organizationId, isActive: true },
    orderBy: { updatedAt: 'desc' },
    take,
    include: { customer: { select: { id: true, name: true, phone: true } } },
  });
}

export async function getVehicleDetail(user: AuthenticatedUser, vehicleId: string) {
  requirePermission(user, 'vehicle.view');
  const vehicle = await prisma.vehicle.findFirst({
    where: { id: vehicleId, organizationId: user.organizationId },
    include: {
      customer: true,
      jobCards: {
        orderBy: { openedAt: 'desc' },
        include: {
          // Who brought the vehicle in for each job — not always today's owner.
          customer: { select: { id: true, name: true } },
          diagnoses: { orderBy: { diagnosedAt: 'desc' }, take: 1, select: { findings: true } },
          estimates: {
            orderBy: [{ version: 'desc' }],
            take: 1,
            select: { estimateNumber: true, status: true, totalAmount: true },
          },
        },
      },
      appointments: {
        where: {
          scheduledAt: { gte: new Date(Date.now() - 1000 * 60 * 60 * 24) },
          status: { in: ['SCHEDULED', 'CONFIRMED'] },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 5,
      },
    },
  });
  if (!vehicle) throw new NotFoundError('vehicle');
  return vehicle;
}

const transferSchema = z.object({
  customerId: z.string({ error: 'Choose the new owner.' }).trim().min(1, 'Choose the new owner.'),
  reason: z
    .string({ error: 'Say why the owner is changing.' })
    .trim()
    .min(3, 'Say why the owner is changing.')
    .max(300),
  /** Typed back by the user, so a vehicle is never handed over by a stray tap. */
  confirmPlate: z
    .string({ error: 'Type the registration number to confirm.' })
    .trim()
    .min(1, 'Type the registration number to confirm.'),
  requestKey: z.string().optional(),
});

/**
 * Hands a vehicle to a new owner. Only the vehicle's current owner changes:
 * every past job keeps the customer who brought it in (JobCard.customerId),
 * and invoices and approvals keep theirs, so the previous owner's history
 * stays theirs. A job that is open right now also stays with whoever brought
 * the vehicle in. The change is audited with both owners and the reason.
 */
export async function transferVehicleOwnership(
  user: AuthenticatedUser,
  vehicleId: string,
  rawInput: unknown,
) {
  const input = parseInput(transferSchema, rawInput);
  requirePermission(user, 'vehicle.edit');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'vehicle.transfer_ownership');
    // Serialise transfers of the same vehicle.
    await tx.$executeRaw`SELECT id FROM vehicles WHERE id = ${vehicleId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const vehicle = await tx.vehicle.findFirst({
      where: { id: vehicleId, organizationId: user.organizationId },
      include: { customer: { select: { id: true, name: true } } },
    });
    if (!vehicle) throw new NotFoundError('vehicle');

    if (normalizePlate(input.confirmPlate) !== normalizePlate(vehicle.plateNumber)) {
      throw new DomainError(
        `That isn't this vehicle's registration. Type ${vehicle.plateNumber} to confirm.`,
        'confirmPlate',
      );
    }
    const newOwner = await tx.customer.findFirst({
      where: { id: input.customerId, organizationId: user.organizationId, isActive: true },
      select: { id: true, name: true },
    });
    if (!newOwner) {
      throw new DomainError('Choose an active customer of this workshop.', 'customerId');
    }
    if (newOwner.id === vehicle.customerId) {
      throw new DomainError(`${newOwner.name} already owns this vehicle.`, 'customerId');
    }

    const openJobs = await tx.jobCard.count({
      where: {
        organizationId: user.organizationId,
        vehicleId: vehicle.id,
        status: { notIn: ['DELIVERED', 'CANCELLED', 'CLOSED'] },
      },
    });

    const updated = await tx.vehicle.update({
      where: { id: vehicle.id },
      data: { customerId: newOwner.id },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: user.primaryBranchId,
      actorUserId: user.id,
      action: 'vehicle.ownership_transferred',
      entityType: 'Vehicle',
      entityId: vehicle.id,
      beforeData: { customerId: vehicle.customer.id, customerName: vehicle.customer.name },
      afterData: { customerId: newOwner.id, customerName: newOwner.name },
      metadata: {
        reason: input.reason,
        plateNumber: vehicle.plateNumber,
        openJobsKeptByPreviousOwner: openJobs,
      },
    });
    await settleRequestKey(tx, user, rawInput, vehicle.id);
    return { vehicle: updated, previousOwner: vehicle.customer, newOwner };
  });
}
