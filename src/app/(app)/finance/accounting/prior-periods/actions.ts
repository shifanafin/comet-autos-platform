'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { removePriorPeriod, savePriorPeriod } from '@/lib/accounting/prior-periods';
import { forgetUrgentDeadlines } from '@/lib/compliance/reminders';

function refresh(organizationId: string) {
  forgetUrgentDeadlines(organizationId);
  revalidatePath('/', 'layout');
}

export async function savePriorPeriodAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => savePriorPeriod(user, formDataToObject(formData)));
  if (result.ok) refresh(user.organizationId);
  return toClientResult(result);
}

export async function removePriorPeriodAction(
  id: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => removePriorPeriod(user, id, input));
  if (result.ok) refresh(user.organizationId);
  return toClientResult(result);
}
