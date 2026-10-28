import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { JobCardStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { allocateDocumentNumber } from '@/lib/numbering';
import { DomainError } from '@/lib/errors';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { parseInput } from '@/lib/form-data';
import { createCustomer, type CustomerInput } from '@/lib/customers/service';
import { createVehicle, MAX_MILEAGE, type VehicleInput } from '@/lib/vehicles/service';
import { OPEN_APPOINTMENT_STATUSES } from '@/lib/appointments/service';
import { formatKm } from '@/lib/format';
import { arrivalMoment } from './arrival';

/**
 * A job is "in the workshop" until it is delivered or cancelled. Legacy
 * values are included so a job still carrying one is never missed.
 */
export const OPEN_JOB_STATUSES: JobCardStatus[] = [
  'ARRIVED',
  'INSPECTION',
  'DIAGNOSIS',
  'ESTIMATE',
  'WAITING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'REPAIR',
  'QUALITY_CHECK',
  'READY',
  'INVOICED',
  'PAID',
  'ON_HOLD',
  'RECEIVED',
  'INSPECTING',
  'DIAGNOSED',
  'ESTIMATE_SENT',
  'IN_PROGRESS',
  'COMPLETED',
];

/**
 * What a job card needs to exist: who, which vehicle, and what they want
 * done. Mileage is optional — the odometer is often not to hand when the
 * car is dropped off, and refusing to open the job card over it helps
 * nobody. When it is given it is still checked as strictly as before.
 */
const visitSchema = z.object({
  complaint: z
    .string({ error: 'Describe the work the customer is asking for.' })
    .trim()
    .min(3, 'Describe the work the customer is asking for.'),
  mileage: z
    .union([z.literal(''), z.string()])
    .optional()
    .transform((value) => value?.trim() ?? '')
    .refine(
      (value) => value === '' || /^\d+$/.test(value.replace(/,/g, '')),
      'Mileage must be a whole number of km, or left blank.',
    )
    .transform((value) => (value === '' ? null : Number(value.replace(/,/g, ''))))
    .refine(
      (value) => value === null || value <= MAX_MILEAGE,
      'That mileage is not realistic — check the odometer.',
    ),
  appointmentId: z.union([z.literal(''), z.uuid()]).optional(),
});

export interface CheckInResult {
  jobCardId: string;
  jobNumber: string;
  /** Job cards opened in the same check-in for the customer's other vehicles. */
  others?: { jobCardId: string; jobNumber: string; plateNumber: string }[];
}

/** One more of the same customer's vehicles, checked in alongside the first. */
export interface AdditionalVehicle {
  vehicleId: string;
  /** Blank: the same work as the first vehicle. */
  complaint?: string;
  mileage?: string;
}

/** A fleet customer's cars arrive together; a check-in opens a job card for each. */
export const MAX_VEHICLES_PER_CHECK_IN = 20;

/**
 * Checks a vehicle in and opens its Job Card (status ARRIVED). Either an
 * existing vehicle is chosen, or a new vehicle is created in the same
 * transaction — for a customer already on file, or with a new customer made
 * alongside it (never a half-created customer without a job).
 */
export async function checkInVehicle(
  user: AuthenticatedUser,
  input:
    | {
        mode: 'existing';
        vehicleId: string;
        visit: Record<string, string | undefined>;
        /** The same customer's other vehicles, each on its own job card. */
        alsoVehicles?: AdditionalVehicle[];
        requestKey?: string;
      }
    | {
        mode: 'new';
        customer: CustomerInput;
        vehicle: VehicleInput;
        visit: Record<string, string | undefined>;
        requestKey?: string;
      }
    | {
        mode: 'new';
        /** A new vehicle for a customer already on file. */
        customerId: string;
        vehicle: VehicleInput;
        visit: Record<string, string | undefined>;
        requestKey?: string;
      },
): Promise<CheckInResult> {
  if (!user.primaryBranchId) {
    throw new DomainError('Your account has no branch assigned. Contact an administrator.');
  }
  const branchId = user.primaryBranchId;
  requirePermission(user, 'job_card.create', { branchId });
  const visit = parseInput(visitSchema, input.visit);
  // Blank: the job opens now. An earlier date records a job entered after the fact.
  const arrivedAt = arrivalMoment(input.visit.arrivedOn, input.visit.arrivedAt);
  const also = input.mode === 'existing' ? (input.alsoVehicles ?? []) : [];
  if (also.length + 1 > MAX_VEHICLES_PER_CHECK_IN) {
    throw new DomainError(
      `Check in up to ${MAX_VEHICLES_PER_CHECK_IN} vehicles at a time.`,
      'alsoVehicles',
    );
  }
  // Each extra vehicle's own visit: its own mileage, and its own work if it differs.
  const alsoVisits = also.map((extra, index) => {
    try {
      return {
        vehicleId: extra.vehicleId,
        visit: parseInput(visitSchema, {
          complaint: extra.complaint?.trim() ? extra.complaint : visit.complaint,
          mileage: extra.mileage ?? '',
        }),
      };
    } catch (error) {
      if (error instanceof DomainError) {
        throw new DomainError(`Vehicle ${index + 2}: ${error.message}`, `alsoVehicles.${index}`);
      }
      throw error;
    }
  });
  if (input.mode === 'existing') {
    const ids = [input.vehicleId, ...also.map((extra) => extra.vehicleId)];
    if (new Set(ids).size !== ids.length) {
      throw new DomainError('The same vehicle is listed twice.', 'alsoVehicles');
    }
  } else if ('customerId' in input && !z.uuid().safeParse(input.customerId).success) {
    throw new DomainError('Choose the customer who owns this vehicle.', 'customerId');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, input, 'job_card.check_in');
    let vehicleId: string;
    if (input.mode === 'existing') {
      vehicleId = input.vehicleId;
    } else {
      // The owner: one already on file (createVehicle checks it), or a new one made now.
      const customerId =
        'customerId' in input
          ? input.customerId
          : (await createCustomer(tx, user, input.customer)).id;
      const vehicle = await createVehicle(tx, user, customerId, input.vehicle);
      vehicleId = vehicle.id;
    }

    const first = await openJobCard(
      tx,
      user,
      branchId,
      vehicleId,
      visit,
      arrivedAt,
      visit.appointmentId || null,
    );
    const others: NonNullable<CheckInResult['others']> = [];
    for (const extra of alsoVisits) {
      const opened = await openJobCard(
        tx,
        user,
        branchId,
        extra.vehicleId,
        extra.visit,
        arrivedAt,
        null,
        first.customerId,
      );
      others.push({
        jobCardId: opened.jobCardId,
        jobNumber: opened.jobNumber,
        plateNumber: opened.plateNumber,
      });
    }

    await settleRequestKey(tx, user, input, first.jobCardId);
    return {
      jobCardId: first.jobCardId,
      jobNumber: first.jobNumber,
      ...(others.length ? { others } : {}),
    };
  });
}

/**
 * Opens one vehicle's job card (status ARRIVED) inside the check-in's
 * transaction. With `sameCustomer`, the vehicle must belong to that customer:
 * a fleet check-in is one customer's cars, never someone else's.
 *
 * `arrivedAt` (null: now) is when the vehicle came in. A job entered after
 * the fact may carry a mileage lower than a reading recorded since, so the
 * "never lower than the last reading" check applies only to a job opened
 * now, and the vehicle's odometer only ever moves forward.
 */
async function openJobCard(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  branchId: string,
  vehicleId: string,
  visit: z.infer<typeof visitSchema>,
  arrivedAt: Date | null,
  requestedAppointmentId: string | null,
  sameCustomer?: string,
) {
  // Lock the vehicle row: two desks checking the same car in at once must not both succeed.
  const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM vehicles
      WHERE id = ${vehicleId}::uuid AND organization_id = ${user.organizationId}::uuid AND is_active
      FOR UPDATE`;
  if (locked.length === 0) throw new DomainError('Choose the vehicle to check in.', 'vehicleId');

  const vehicle = await tx.vehicle.findUniqueOrThrow({
    where: { id: vehicleId },
    select: { id: true, customerId: true, lastMileage: true, plateNumber: true },
  });
  if (sameCustomer && vehicle.customerId !== sameCustomer) {
    throw new DomainError(
      `${vehicle.plateNumber} belongs to another customer. Check it in on its own.`,
      'alsoVehicles',
    );
  }

  const openJob = await tx.jobCard.findFirst({
    where: { organizationId: user.organizationId, vehicleId, status: { in: OPEN_JOB_STATUSES } },
    select: { jobNumber: true },
  });
  if (openJob) {
    throw new DomainError(
      `${vehicle.plateNumber} is already in the workshop on job ${openJob.jobNumber}.`,
      'vehicleId',
    );
  }

  if (
    arrivedAt === null &&
    visit.mileage !== null &&
    vehicle.lastMileage !== null &&
    visit.mileage < vehicle.lastMileage
  ) {
    throw new DomainError(
      `${sameCustomer ? `${vehicle.plateNumber}: m` : 'M'}ileage can't be lower than the last recorded reading (${formatKm(vehicle.lastMileage)}).`,
      sameCustomer ? 'alsoVehicles' : 'mileage',
    );
  }

  let appointmentId: string | null = null;
  if (requestedAppointmentId) {
    const appointment = await tx.appointment.findFirst({
      where: {
        id: requestedAppointmentId,
        organizationId: user.organizationId,
        status: { in: OPEN_APPOINTMENT_STATUSES },
      },
    });
    if (!appointment) {
      throw new DomainError('That appointment is no longer open for check-in.', 'appointmentId');
    }
    if (appointment.vehicleId && appointment.vehicleId !== vehicle.id) {
      throw new DomainError('The appointment was booked for a different vehicle.', 'appointmentId');
    }
    await tx.appointment.update({
      where: { id: appointment.id },
      data: { status: 'CHECKED_IN' },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: appointment.branchId,
      actorUserId: user.id,
      action: 'appointment.status_changed',
      entityType: 'Appointment',
      entityId: appointment.id,
      beforeData: { status: appointment.status },
      afterData: { status: 'CHECKED_IN' },
    });
    appointmentId = appointment.id;
  }

  const jobNumber = await allocateDocumentNumber(tx, user.organizationId, branchId, 'JOB_CARD');
  const jobCard = await tx.jobCard.create({
    data: {
      organizationId: user.organizationId,
      branchId,
      vehicleId: vehicle.id,
      // The job belongs to whoever owns the vehicle now, and keeps them if
      // the vehicle later changes hands.
      customerId: vehicle.customerId,
      appointmentId,
      jobNumber,
      status: 'ARRIVED',
      odometerReading: visit.mileage,
      customerComplaint: visit.complaint,
      ...(arrivedAt ? { openedAt: arrivedAt } : {}),
      createdByUserId: user.id,
    },
  });

  // Only a reading that was actually taken, and never an older one, updates the odometer.
  if (
    visit.mileage !== null &&
    (vehicle.lastMileage === null || visit.mileage >= vehicle.lastMileage)
  ) {
    await tx.vehicle.update({ where: { id: vehicle.id }, data: { lastMileage: visit.mileage } });
  }

  await tx.jobStatusHistory.create({
    data: {
      organizationId: user.organizationId,
      jobCardId: jobCard.id,
      fromStatus: null,
      toStatus: 'ARRIVED',
      changedByUserId: user.id,
      changedAt: jobCard.openedAt,
    },
  });
  await writeAuditLog(tx, {
    organizationId: user.organizationId,
    branchId,
    actorUserId: user.id,
    action: 'job_card.created',
    entityType: 'JobCard',
    entityId: jobCard.id,
    afterData: {
      jobNumber,
      status: 'ARRIVED',
      vehicleId: vehicle.id,
      customerId: vehicle.customerId,
      appointmentId,
      odometerReading: visit.mileage,
      entry: appointmentId ? 'appointment' : 'walk_in',
      ...(arrivedAt ? { arrivedAt: arrivedAt.toISOString(), backdated: true } : {}),
    },
  });

  return {
    jobCardId: jobCard.id,
    jobNumber,
    plateNumber: vehicle.plateNumber,
    customerId: vehicle.customerId,
  };
}
