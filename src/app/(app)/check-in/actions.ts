'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { prisma } from '@/lib/prisma';
import {
  checkInVehicle,
  type AdditionalVehicle,
  type CheckInResult,
} from '@/lib/workshop/check-in';

export async function checkInAction(
  _prev: ActionResult<CheckInResult>,
  formData: FormData,
): Promise<ActionResult<CheckInResult>> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  const visit = {
    complaint: input.complaint,
    mileage: input.mileage,
    appointmentId: input.appointmentId,
    arrivedOn: input.arrivedOn,
    arrivedAt: input.arrivedAt,
  };
  // The customer's other vehicles arrive as one JSON field: [{ vehicleId, complaint, mileage }].
  let alsoVehicles: AdditionalVehicle[] = [];
  try {
    const parsed: unknown = input.alsoVehicles ? JSON.parse(input.alsoVehicles) : [];
    alsoVehicles = Array.isArray(parsed)
      ? parsed
          .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
          .map((row) => ({
            vehicleId: String(row.vehicleId ?? ''),
            complaint: typeof row.complaint === 'string' ? row.complaint : undefined,
            mileage: typeof row.mileage === 'string' ? row.mileage : undefined,
          }))
      : [];
  } catch {
    return { ok: false, error: 'The other vehicles could not be read. Refresh and try again.' };
  }

  const vehicle = {
    plateNumber: input.plateNumber,
    plateEmirate: input.plateEmirate,
    vin: input.vin,
    make: input.make,
    model: input.model,
    year: input.year,
  };
  const result = await runAction(() =>
    input.mode === 'new'
      ? // A new vehicle: for a customer chosen from the list, or a new customer typed in.
        input.customerId
        ? checkInVehicle(user, {
            mode: 'new',
            customerId: input.customerId,
            vehicle,
            visit,
            requestKey: input.requestKey,
          })
        : checkInVehicle(user, {
            mode: 'new',
            customer: { name: input.name, phone: input.phone, email: input.email },
            vehicle,
            visit,
            requestKey: input.requestKey,
          })
      : checkInVehicle(user, {
          mode: 'existing',
          vehicleId: input.vehicleId ?? '',
          visit,
          alsoVehicles,
          requestKey: input.requestKey,
        }),
  );

  if (!result.ok) return { ok: false, error: result.error, fieldErrors: result.fieldErrors };
  if (result.duplicate) {
    // The same check-in was submitted twice: show the job the first submission opened.
    const job = result.duplicateOf
      ? await prisma.jobCard.findFirst({
          where: { id: result.duplicateOf, organizationId: user.organizationId },
          select: { id: true, jobNumber: true },
        })
      : null;
    return job
      ? { ok: true, data: { jobCardId: job.id, jobNumber: job.jobNumber } }
      : { ok: false, error: 'This check-in was already saved. Open Job Cards to find it.' };
  }
  revalidatePath('/');
  revalidatePath('/job-cards');
  revalidatePath('/appointments');
  return result;
}
