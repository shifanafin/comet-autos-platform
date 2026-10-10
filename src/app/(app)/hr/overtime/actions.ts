'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import {
  addOvertime,
  addPublicHoliday,
  decideOvertime,
  removePublicHoliday,
  setWeeklyRestDay,
} from '@/lib/hr/overtime';

function refresh() {
  revalidatePath('/hr', 'layout');
}

export async function decideOvertimeAction(
  id: string,
  decision: 'APPROVED' | 'REJECTED',
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    decideOvertime(user, id, decision, formDataToObject(formData)),
  );
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function addOvertimeAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => addOvertime(user, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function setRestDayAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => setWeeklyRestDay(user, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function addHolidayAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => addPublicHoliday(user, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function removeHolidayAction(id: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => removePublicHoliday(user, id));
  if (result.ok) refresh();
  return toClientResult(result);
}
