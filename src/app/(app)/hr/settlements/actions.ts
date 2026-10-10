'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import {
  approveSettlement,
  cancelSettlement,
  paySettlement,
  prepareSettlement,
} from '@/lib/hr/settlement';

function refresh() {
  revalidatePath('/hr', 'layout');
  revalidatePath('/finance', 'layout');
}

export async function prepareSettlementAction(
  employeeId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    prepareSettlement(user, employeeId, formDataToObject(formData)),
  );
  const id = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !id) return toClientResult(result);
  refresh();
  redirect(`/hr/settlements/${id}`);
}

export async function approveSettlementAction(id: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => approveSettlement(user, id));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function paySettlementAction(
  id: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => paySettlement(user, id, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function cancelSettlementAction(
  id: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => cancelSettlement(user, id, input));
  if (result.ok) refresh();
  return toClientResult(result);
}
