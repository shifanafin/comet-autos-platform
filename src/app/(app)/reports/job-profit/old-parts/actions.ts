'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import {
  costFromWriteOff,
  markAsWork,
  takeFromStockNow,
  undoWriteOffCost,
} from '@/lib/inventory/old-part-lines';

/*
 * Settling the Parts lines of invoices issued before parts were tied to
 * stock (lib/inventory/old-part-lines.ts). Each settles one line.
 */

const ACTIONS = {
  WRITE_OFF: costFromWriteOff,
  STOCK: takeFromStockNow,
  WORK: markAsWork,
  UNDO: undoWriteOffCost,
} as const;

export async function settleOldPartLineAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  const settle = ACTIONS[input.how as keyof typeof ACTIONS];
  if (!settle) return { ok: false, error: 'Choose what this line was.' };
  const result = await runAction(() => settle(user, input));
  if (!result.ok || !result.data) return toClientResult(result);
  revalidatePath('/reports/job-profit', 'layout');
  revalidatePath(`/finance/invoices/${result.data.invoiceId}`);
  revalidatePath('/inventory', 'layout');
  revalidatePath('/finance', 'layout');
  return { ok: true };
}
