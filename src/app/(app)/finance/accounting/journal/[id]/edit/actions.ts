'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { changeEntryDate } from '@/lib/accounting/redate';

/** Changes a journal entry's date — through its record when it was booked from one. */
export async function changeEntryDateAction(
  entryId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => changeEntryDate(user, entryId, formDataToObject(formData)));
  if (result.ok) {
    revalidatePath('/finance', 'layout');
    revalidatePath('/', 'layout');
  }
  return toClientResult(result);
}
