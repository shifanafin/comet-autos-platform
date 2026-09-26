'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { AppointmentStatus } from '@/generated/prisma/enums';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import {
  changeAppointmentStatus,
  createAppointment,
  rescheduleAppointment,
} from '@/lib/appointments/service';

export async function createAppointmentAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createAppointment(user, formDataToObject(formData)));
  if (!result.ok) return toClientResult(result);
  revalidatePath('/appointments');
  redirect('/appointments');
}

export async function changeAppointmentStatusAction(
  appointmentId: string,
  toStatus: Extract<AppointmentStatus, 'CONFIRMED' | 'CANCELLED' | 'NO_SHOW'>,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => changeAppointmentStatus(user, appointmentId, toStatus));
  if (result.ok) revalidatePath('/appointments');
  return toClientResult(result);
}

export async function rescheduleAppointmentAction(
  appointmentId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    rescheduleAppointment(user, appointmentId, formDataToObject(formData)),
  );
  if (result.ok) revalidatePath('/appointments');
  return toClientResult(result);
}
