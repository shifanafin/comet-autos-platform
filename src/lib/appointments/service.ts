import { z } from 'zod';
import type { AppointmentStatus } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { localDayRange, parseLocalDateTime } from '@/lib/format';
import { APPOINTMENT_STATUS_LABEL } from '@/lib/workshop/labels';

export { APPOINTMENT_STATUS_LABEL };

/*
 * Appointments use the front-desk permission `job_card.create`: the V1
 * permission catalog has no dedicated appointment.* codes, and booking a
 * vehicle in is the same role as checking it in.
 */
const PERMISSION = 'job_card.create';

/** Statuses from which a booking can still turn into a check-in. */
export const OPEN_APPOINTMENT_STATUSES: AppointmentStatus[] = ['SCHEDULED', 'CONFIRMED'];

const MANUAL_TRANSITIONS: Partial<Record<AppointmentStatus, AppointmentStatus[]>> = {
  SCHEDULED: ['CONFIRMED', 'CANCELLED', 'NO_SHOW'],
  CONFIRMED: ['CANCELLED', 'NO_SHOW'],
};

export const appointmentSchema = z.object({
  vehicleId: z.uuid('Choose the vehicle being booked in.'),
  scheduledAt: z.string({ error: 'Choose a date and time.' }).min(1, 'Choose a date and time.'),
  estimatedDurationMinutes: z
    .string()
    .optional()
    .refine((value) => !value || /^\d+$/.test(value), 'Choose a duration.')
    .transform((value) => (value ? Number(value) : null)),
  notes: z
    .string({ error: 'Describe the work requested.' })
    .trim()
    .min(1, 'Describe the work requested.')
    .max(2000),
});

export async function createAppointment(user: AuthenticatedUser, rawInput: unknown) {
  if (!user.primaryBranchId) {
    throw new DomainError('Your account has no branch assigned. Contact an administrator.');
  }
  const branchId = user.primaryBranchId;
  requirePermission(user, PERMISSION, { branchId });
  const input = parseInput(appointmentSchema, rawInput);

  const scheduledAt = parseLocalDateTime(input.scheduledAt);
  if (!scheduledAt) throw new DomainError('Choose a valid date and time.', 'scheduledAt');
  if (scheduledAt.getTime() < Date.now() - 15 * 60 * 1000) {
    throw new DomainError('The appointment time is in the past.', 'scheduledAt');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'appointment.create');
    const vehicle = await tx.vehicle.findFirst({
      where: { id: input.vehicleId, organizationId: user.organizationId, isActive: true },
      select: { id: true, customerId: true },
    });
    if (!vehicle) throw new DomainError('Choose the vehicle being booked in.', 'vehicleId');

    const appointment = await tx.appointment.create({
      data: {
        organizationId: user.organizationId,
        branchId,
        customerId: vehicle.customerId,
        vehicleId: vehicle.id,
        scheduledAt,
        estimatedDurationMinutes: input.estimatedDurationMinutes,
        notes: emptyToNull(input.notes),
        createdByUserId: user.id,
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId,
      actorUserId: user.id,
      action: 'appointment.created',
      entityType: 'Appointment',
      entityId: appointment.id,
      afterData: { vehicleId: vehicle.id, scheduledAt: scheduledAt.toISOString() },
    });
    await settleRequestKey(tx, user, rawInput, appointment.id);
    return appointment;
  });
}

export async function changeAppointmentStatus(
  user: AuthenticatedUser,
  appointmentId: string,
  toStatus: AppointmentStatus,
) {
  return prisma.$transaction(async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, organizationId: user.organizationId },
    });
    if (!appointment) throw new NotFoundError('appointment');
    requirePermission(user, PERMISSION, { branchId: appointment.branchId });

    if (!MANUAL_TRANSITIONS[appointment.status]?.includes(toStatus)) {
      throw new DomainError(
        `A ${APPOINTMENT_STATUS_LABEL[appointment.status].toLowerCase()} appointment can't be marked ${APPOINTMENT_STATUS_LABEL[toStatus].toLowerCase()}.`,
      );
    }
    await tx.appointment.update({ where: { id: appointment.id }, data: { status: toStatus } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: appointment.branchId,
      actorUserId: user.id,
      action: 'appointment.status_changed',
      entityType: 'Appointment',
      entityId: appointment.id,
      beforeData: { status: appointment.status },
      afterData: { status: toStatus },
    });
  });
}

const appointmentInclude = {
  customer: { select: { id: true, name: true, phone: true } },
  vehicle: { select: { id: true, plateNumber: true, make: true, model: true } },
  jobCards: { select: { id: true, jobNumber: true }, take: 1 },
} as const;

/** Today's board (every status, so the desk sees who came and who didn't) plus the next 14 days of open bookings. */
export async function getAppointmentBoard(user: AuthenticatedUser) {
  requirePermission(user, PERMISSION);
  const { start, end } = localDayRange();
  const horizon = new Date(end.getTime() + 14 * 24 * 60 * 60 * 1000);

  const [today, upcoming, overdue] = await Promise.all([
    prisma.appointment.findMany({
      where: { organizationId: user.organizationId, scheduledAt: { gte: start, lt: end } },
      orderBy: { scheduledAt: 'asc' },
      include: appointmentInclude,
    }),
    prisma.appointment.findMany({
      where: {
        organizationId: user.organizationId,
        scheduledAt: { gte: end, lt: horizon },
        status: { in: OPEN_APPOINTMENT_STATUSES },
      },
      orderBy: { scheduledAt: 'asc' },
      include: appointmentInclude,
    }),
    prisma.appointment.findMany({
      where: {
        organizationId: user.organizationId,
        scheduledAt: { lt: start },
        status: { in: OPEN_APPOINTMENT_STATUSES },
      },
      orderBy: { scheduledAt: 'asc' },
      include: appointmentInclude,
      take: 20,
    }),
  ]);
  return { today, upcoming, overdue };
}

export async function getOpenAppointment(user: AuthenticatedUser, appointmentId: string) {
  requirePermission(user, PERMISSION);
  return prisma.appointment.findFirst({
    where: {
      id: appointmentId,
      organizationId: user.organizationId,
      status: { in: OPEN_APPOINTMENT_STATUSES },
    },
    include: appointmentInclude,
  });
}

const rescheduleSchema = appointmentSchema.omit({ vehicleId: true });

/**
 * Moves a booking that is still open to a new time, and lets the desk
 * correct its duration and notes. A checked-in, cancelled or missed
 * appointment is history and stays as it was.
 */
export async function rescheduleAppointment(
  user: AuthenticatedUser,
  appointmentId: string,
  rawInput: unknown,
) {
  const input = parseInput(rescheduleSchema, rawInput);
  const scheduledAt = parseLocalDateTime(input.scheduledAt);
  if (!scheduledAt) throw new DomainError('Choose a valid date and time.', 'scheduledAt');
  if (scheduledAt.getTime() < Date.now() - 15 * 60 * 1000) {
    throw new DomainError('The appointment time is in the past.', 'scheduledAt');
  }

  return prisma.$transaction(async (tx) => {
    const appointment = await tx.appointment.findFirst({
      where: { id: appointmentId, organizationId: user.organizationId },
    });
    if (!appointment) throw new NotFoundError('appointment');
    requirePermission(user, PERMISSION, { branchId: appointment.branchId });
    if (!OPEN_APPOINTMENT_STATUSES.includes(appointment.status)) {
      throw new DomainError(
        `A ${APPOINTMENT_STATUS_LABEL[appointment.status].toLowerCase()} appointment can't be moved.`,
      );
    }
    const data = {
      scheduledAt,
      estimatedDurationMinutes: input.estimatedDurationMinutes,
      notes: emptyToNull(input.notes),
    };
    await tx.appointment.update({ where: { id: appointment.id }, data });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: appointment.branchId,
      actorUserId: user.id,
      action: 'appointment.rescheduled',
      entityType: 'Appointment',
      entityId: appointment.id,
      beforeData: {
        scheduledAt: appointment.scheduledAt.toISOString(),
        estimatedDurationMinutes: appointment.estimatedDurationMinutes,
        notes: appointment.notes,
      },
      afterData: { ...data, scheduledAt: scheduledAt.toISOString() },
    });
  });
}
