import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { MAX_MILEAGE } from '@/lib/vehicles/service';
import { CLOSED_JOB_STATUSES } from '@/lib/workshop/stages';
import { formatKm } from '@/lib/format';

/*
 * Correcting what was written at check-in: the customer's request and the
 * odometer reading. Typos happen at the counter; the job card should not be
 * stuck with them. A closed job card is history and stays as it was.
 */

const detailsSchema = z.object({
  complaint: z
    .string({ error: 'Describe the work the customer is asking for.' })
    .trim()
    .min(3, 'Describe the work the customer is asking for.')
    .max(2000, 'Keep it under 2000 characters.'),
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
});

export async function updateJobCardDetails(
  user: AuthenticatedUser,
  jobCardId: string,
  rawInput: unknown,
) {
  const input = parseInput(detailsSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM job_cards WHERE id = ${jobCardId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const job = await tx.jobCard.findFirst({
      where: { id: jobCardId, organizationId: user.organizationId },
      select: {
        id: true,
        branchId: true,
        status: true,
        vehicleId: true,
        openedAt: true,
        customerComplaint: true,
        odometerReading: true,
      },
    });
    if (!job) throw new NotFoundError('job card');
    requirePermission(user, 'job_card.edit', { branchId: job.branchId });
    if (CLOSED_JOB_STATUSES.includes(job.status)) {
      throw new DomainError('This job card is closed and can no longer be changed.');
    }

    // The reading has to sit between the vehicle's earlier and later visits.
    const others = await tx.jobCard.findMany({
      where: {
        organizationId: user.organizationId,
        vehicleId: job.vehicleId,
        id: { not: job.id },
        odometerReading: { not: null },
      },
      select: { openedAt: true, odometerReading: true },
    });
    const earlier = others.filter((o) => o.openedAt <= job.openedAt).map((o) => o.odometerReading!);
    const later = others.filter((o) => o.openedAt > job.openedAt).map((o) => o.odometerReading!);
    if (input.mileage !== null) {
      const floor = earlier.length ? Math.max(...earlier) : null;
      const ceiling = later.length ? Math.min(...later) : null;
      if (floor !== null && input.mileage < floor) {
        throw new DomainError(
          `Mileage can't be lower than an earlier visit (${formatKm(floor)}).`,
          'mileage',
        );
      }
      if (ceiling !== null && input.mileage > ceiling) {
        throw new DomainError(
          `Mileage can't be higher than a later visit (${formatKm(ceiling)}).`,
          'mileage',
        );
      }
    }

    await tx.jobCard.update({
      where: { id: job.id },
      data: { customerComplaint: input.complaint, odometerReading: input.mileage },
    });
    // The latest visit's reading is the vehicle's odometer; correct it with the job.
    if (later.length === 0 && input.mileage !== null) {
      await tx.vehicle.update({
        where: { id: job.vehicleId },
        data: { lastMileage: input.mileage },
      });
    }

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: job.branchId,
      actorUserId: user.id,
      action: 'job_card.details_updated',
      entityType: 'JobCard',
      entityId: job.id,
      beforeData: { complaint: job.customerComplaint, mileage: job.odometerReading },
      afterData: { complaint: input.complaint, mileage: input.mileage },
    });
    return { jobCardId: job.id };
  });
}
