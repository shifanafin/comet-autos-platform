'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { createAccount, updateAccount } from '@/lib/finance/accounting';
import {
  bookExistingRecords,
  completeStandardChart,
  createManualEntry,
  deleteManualEntry,
  reverseManualEntry,
  updateEntryNarration,
  updateManualEntry,
} from '@/lib/accounting/entries';
import { closeBooks, reopenAllBooks } from '@/lib/accounting/periods';
import { localDateString } from '@/lib/format';
import {
  addCustomerOpeningBalance,
  removeCustomerOpeningBalance,
  saveOpeningBalances,
} from '@/lib/accounting/opening-balances';
import { closeFinancialYear, reopenFinancialYear } from '@/lib/accounting/year-end';
import { createTaxCode, updateTaxCode } from '@/lib/accounting/tax-codes';
import { createPaymentMode, updatePaymentMode } from '@/lib/accounting/payment-modes';

function refresh() {
  revalidatePath('/finance', 'layout');
}

export async function createAccountAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createAccount(user, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function updateAccountAction(
  accountId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => updateAccount(user, accountId, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

/** Books everything recorded before the books existed. */
export async function bookExistingRecordsAction(): Promise<
  ActionResult<{ booked: number; failed: string[] }>
> {
  const user = await requireUser();
  const result = await runAction(() => bookExistingRecords(user));
  if (result.ok) refresh();
  return { ...toClientResult(result), data: result.data };
}

/** A journal entry made by hand. Its lines arrive as one JSON field. */
export async function createManualEntryAction(
  _prev: ActionResult<{ entryNumber: string | null }>,
  formData: FormData,
): Promise<ActionResult<{ entryNumber: string | null }>> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  let lines: unknown = [];
  try {
    lines = input.lines ? JSON.parse(input.lines) : [];
  } catch {
    return { ok: false, error: 'The entry’s lines could not be read. Refresh and try again.' };
  }
  const result = await runAction(async () => {
    const entry = await createManualEntry(user, { ...input, lines });
    return { entryNumber: entry.entryNumber };
  });
  if (result.ok) refresh();
  return { ...toClientResult(result), data: result.data };
}

/** Corrects an entry made by hand, in an open period. Its lines arrive as one JSON field. */
export async function updateManualEntryAction(
  entryId: string,
  _prev: ActionResult<{ entryNumber: string | null }>,
  formData: FormData,
): Promise<ActionResult<{ entryNumber: string | null }>> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  let lines: unknown = [];
  try {
    lines = input.lines ? JSON.parse(input.lines) : [];
  } catch {
    return { ok: false, error: 'The entry’s lines could not be read. Refresh and try again.' };
  }
  const result = await runAction(async () => {
    const entry = await updateManualEntry(user, entryId, { ...input, lines });
    return { entryNumber: entry.entryNumber };
  });
  if (result.ok) refresh();
  return { ...toClientResult(result), data: result.data };
}

export async function deleteManualEntryAction(
  entryId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => deleteManualEntry(user, entryId, input));
  if (result.ok) refresh();
  return toClientResult(result);
}

/** An entry's description and line notes. The notes arrive as one JSON field. */
export async function updateEntryNarrationAction(
  entryId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  let notes: unknown = [];
  try {
    notes = input.notes ? JSON.parse(input.notes) : [];
  } catch {
    return { ok: false, error: 'The notes could not be read. Refresh and try again.' };
  }
  const result = await runAction(() =>
    updateEntryNarration(user, entryId, { description: input.description, notes }),
  );
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function reverseManualEntryAction(
  entryId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    reverseManualEntry(user, entryId, { reason: input.reason, date: localDateString() }),
  );
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function addStandardAccountsAction(): Promise<ActionResult<{ added: number }>> {
  const user = await requireUser();
  const result = await runAction(() => completeStandardChart(user));
  if (result.ok) refresh();
  return { ...toClientResult(result), data: result.data };
}

export async function closeBooksAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => closeBooks(user, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function reopenBooksAction(input: { reason: string }): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => reopenAllBooks(user, input));
  if (result.ok) refresh();
  return toClientResult(result);
}

/** The general accounts' opening balances. The rows arrive as one JSON field. */
export async function saveOpeningBalancesAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  let lines: unknown = [];
  try {
    lines = input.lines ? JSON.parse(input.lines) : [];
  } catch {
    return { ok: false, error: 'The balances could not be read. Refresh and try again.' };
  }
  const result = await runAction(() => saveOpeningBalances(user, { ...input, lines }));
  if (result.ok || result.duplicate) refresh();
  return toClientResult(result);
}

export async function addCustomerOpeningBalanceAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => addCustomerOpeningBalance(user, formDataToObject(formData)));
  if (result.ok || result.duplicate) refresh();
  return toClientResult(result);
}

export async function removeCustomerOpeningBalanceAction(
  invoiceId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => removeCustomerOpeningBalance(user, invoiceId, input));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function closeFinancialYearAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => closeFinancialYear(user, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function reopenFinancialYearAction(
  entryId: string,
  input: { reason: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => reopenFinancialYear(user, entryId, input));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function createTaxCodeAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createTaxCode(user, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function updateTaxCodeAction(
  taxCodeId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => updateTaxCode(user, taxCodeId, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function createPaymentModeAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createPaymentMode(user, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function updatePaymentModeAction(
  modeId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => updatePaymentMode(user, modeId, formDataToObject(formData)));
  if (result.ok) refresh();
  return toClientResult(result);
}
