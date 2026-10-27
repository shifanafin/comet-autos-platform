'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { recordMoneyTransfer, voidMoneyTransfer } from '@/lib/finance/money';
import {
  addPartner,
  recordOwnerMoney,
  updateOwnerMoney,
  voidOwnerMoney,
} from '@/lib/finance/owner-money';
import {
  recordBusinessPurchasePayment,
  updateBusinessPurchasePayment,
  voidBusinessPurchasePayment,
} from '@/lib/finance/business-purchase';

/** A transfer changes two balances: every screen that shows them. */
function refresh() {
  revalidatePath('/finance/money', 'layout');
  revalidatePath('/finance/accounting');
  revalidatePath('/finance');
  revalidatePath('/');
}

export async function recordMoneyTransferAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => recordMoneyTransfer(user, formDataToObject(formData)));
  if (result.ok || result.duplicate) refresh();
  return toClientResult(result);
}

export async function voidMoneyTransferAction(
  transferId: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => voidMoneyTransfer(user, transferId, input));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function recordOwnerMoneyAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => recordOwnerMoney(user, formDataToObject(formData)));
  if (result.ok || result.duplicate) refresh();
  return toClientResult(result);
}

/** Corrects an entry where it stands (bound to the entry's id on the edit page). */
export async function updateOwnerMoneyAction(
  id: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => updateOwnerMoney(user, id, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function voidOwnerMoneyAction(
  id: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => voidOwnerMoney(user, id, input));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function addPartnerAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => addPartner(user, formDataToObject(formData)));
  if (result.ok || result.duplicate) revalidatePath('/finance/money/owner');
  return toClientResult(result);
}

/** A partner's payment to buy the business — outside the books, so only this screen changes. */
export async function recordBusinessPurchaseAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    recordBusinessPurchasePayment(user, formDataToObject(formData)),
  );
  if (result.ok || result.duplicate) revalidatePath('/finance/money/owner');
  return toClientResult(result);
}

/** Corrects a payment where it stands (bound to its id on the edit page). */
export async function updateBusinessPurchaseAction(
  id: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    updateBusinessPurchasePayment(user, id, formDataToObject(formData)),
  );
  if (result.ok) revalidatePath('/finance/money/owner', 'layout');
  return toClientResult(result);
}

export async function voidBusinessPurchaseAction(
  id: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => voidBusinessPurchasePayment(user, id, input));
  if (result.ok) revalidatePath('/finance/money/owner');
  return toClientResult(result);
}
