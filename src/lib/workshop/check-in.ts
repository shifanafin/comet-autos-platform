import { z } from 'zod';
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
}

/**
 * Checks a vehicle in and opens its Job Card (status ARRIVED). Either an existing vehicle is chosen, or a new customer and
 * vehicle are created in the same transaction — never a half-created
 * customer without a job.
 */
export async function checkInVehicle(
  user: AuthenticatedUser,
  input:
    | { mode: 'existing'; vehicleId: string; visit: Record<string, string | undefined>; requestKey?: string }
    | {
        mode: 'new';
        customer: CustomerInput;
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

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, input, 'job_card.check_in');
    let vehicleId: string;
    if (input.mode === 'existing') {
      vehicleId = input.vehicleId;
    } else {
      const customer = await createCustomer(tx, user, input.customer);
      const vehicle = await createVehicle(tx, user, customer.id, input.vehicle);
      vehicleId = vehicle.id;
    }

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

    if (visit.mileage !== null && vehicle.lastMileage !== null && visit.mileage < vehicle.lastMileage) {
      throw new DomainError(
        `Mileage can't be lower than the last recorded reading (${formatKm(vehicle.lastMileage)}).`,
        'mileage',
      );
    }

    let appointmentId: string | null = null;
    if (visit.appointmentId) {
      const appointment = await tx.appointment.findFirst({
        where: {
          id: visit.appointmentId,
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
      await tx.appointment.update({ where: { id: appointment.id }, data: { status: 'CHECKED_IN' } });
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
        createdByUserId: user.id,
      },
    });

    // Only a reading that was actually taken updates the vehicle's odometer.
    if (visit.mileage !== null) {
      await tx.vehicle.update({ where: { id: vehicle.id }, data: { lastMileage: visit.mileage } });
    }

    await tx.jobStatusHistory.create({
      data: {
        organizationId: user.organizationId,
        jobCardId: jobCard.id,
        fromStatus: null,
        toStatus: 'ARRIVED',
        changedByUserId: user.id,
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
      },
    });

    await settleRequestKey(tx, user, input, jobCard.id);
    return { jobCardId: jobCard.id, jobNumber };
  });
}
