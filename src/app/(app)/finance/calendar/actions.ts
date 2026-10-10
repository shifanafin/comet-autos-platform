'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { saveCompanyDates } from '@/lib/compliance/calendar';
import { forgetUrgentDeadlines } from '@/lib/compliance/reminders';

export async function saveCompanyDatesAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => saveCompanyDates(user, formDataToObject(formData)));
  if (result.ok) {
    forgetUrgentDeadlines(user.organizationId);
    revalidatePath('/', 'layout');
  }
  return toClientResult(result);
}
