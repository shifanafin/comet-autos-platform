'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import {
  completeReconciliation,
  discardReconciliation,
  reopenReconciliation,
  setReconciledLines,
  startReconciliation,
} from '@/lib/accounting/reconciliation';
import {
  matchStatementLine,
  rematchStatement,
  unmatchStatementLine,
  uploadStatement,
} from '@/lib/accounting/statement-import';

function refresh(reconciliationId?: string) {
  revalidatePath('/finance/bank-reconciliation');
  if (reconciliationId) revalidatePath(`/finance/bank-reconciliation/${reconciliationId}`);
}

export async function startReconciliationAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => startReconciliation(user, formDataToObject(formData)));
  if (!result.ok) return toClientResult(result);
  refresh();
  redirect(`/finance/bank-reconciliation/${result.data!.reconciliationId}`);
}

export async function setReconciledLinesAction(
  reconciliationId: string,
  lineIds: string[],
  ticked: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    setReconciledLines(user, reconciliationId, { lineIds, ticked }),
  );
  if (result.ok) refresh(reconciliationId);
  return toClientResult(result);
}

export async function completeReconciliationAction(
  reconciliationId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => completeReconciliation(user, reconciliationId));
  if (result.ok) refresh(reconciliationId);
  return toClientResult(result);
}

export async function reopenReconciliationAction(reconciliationId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => reopenReconciliation(user, reconciliationId));
  if (result.ok) refresh(reconciliationId);
  return toClientResult(result);
}

export async function discardReconciliationAction(reconciliationId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => discardReconciliation(user, reconciliationId));
  if (!result.ok) return toClientResult(result);
  refresh();
  redirect('/finance/bank-reconciliation');
}

/** Uploads a statement onto a new reconciliation, then opens it. */
export async function uploadStatementAction(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => uploadStatement(user, input));
  if (!result.ok) return toClientResult(result);
  refresh();
  redirect(`/finance/bank-reconciliation/${result.data!.reconciliationId}`);
}

export async function matchStatementLineAction(
  reconciliationId: string,
  statementLineId: string,
  bookLineIds: string[],
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    matchStatementLine(user, reconciliationId, { statementLineId, bookLineIds }),
  );
  if (result.ok) refresh(reconciliationId);
  return toClientResult(result);
}

export async function unmatchStatementLineAction(
  reconciliationId: string,
  statementLineId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    unmatchStatementLine(user, reconciliationId, statementLineId),
  );
  if (result.ok) refresh(reconciliationId);
  return toClientResult(result);
}

export async function rematchStatementAction(
  reconciliationId: string,
): Promise<ActionResult<{ matched: number }>> {
  const user = await requireUser();
  const result = await runAction(() => rematchStatement(user, reconciliationId));
  if (result.ok) refresh(reconciliationId);
  return result;
}
