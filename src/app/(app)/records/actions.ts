'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { removeRecords } from '@/lib/records/remove';
import type { RemovableEntity, RemovalOutcome } from '@/lib/records/removal';

/** Deletes, voids, cancels or reverses the chosen rows of one list. */
export async function removeRecordsAction(input: {
  entity: RemovableEntity;
  ids: string[];
  reason?: string;
}): Promise<ActionResult<RemovalOutcome>> {
  const user = await requireUser();
  const result = await runAction(() => removeRecords(user, input));
  if (result.ok && (result.data?.done.length ?? 0) > 0) {
    // A void or cancel moves numbers on the dashboard, the job card, the
    // customer and more: refresh every screen rather than guess which.
    revalidatePath('/', 'layout');
  }
  return result;
}
