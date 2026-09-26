'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { recordExpense, updateExpense, voidExpense } from '@/lib/finance/expenses';

function refreshFinance() {
  revalidatePath('/finance', 'layout');
}

export async function recordExpenseAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => recordExpense(user, formDataToObject(formData)));
  if (result.ok || result.duplicate) refreshFinance();
  return toClientResult(result);
}

export async function voidExpenseAction(
  expenseId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => voidExpense(user, expenseId, formDataToObject(formData)));
  if (result.ok) refreshFinance();
  return toClientResult(result);
}

export async function updateExpenseAction(
  expenseId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => updateExpense(user, expenseId, formDataToObject(formData)));
  if (result.ok) refreshFinance();
  return toClientResult(result);
}
