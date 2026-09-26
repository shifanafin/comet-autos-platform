'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/authorize';
import { runAction } from '@/lib/action';
import { toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { customerQuotePath, getRequestOrigin } from '@/lib/request-origin';
import { quotationWhatsApp } from '@/lib/customer-access/share';
import {
  createQuotation,
  deleteDraftQuotation,
  recordCustomerDecision,
  reissueEstimateLink,
  reviseEstimate,
  saveEstimateDraft,
  sendEstimate,
} from '@/lib/workshop/estimates';
import { prisma } from '@/lib/prisma';

/*
 * The quotation screen's actions. Every one of them calls the same estimate
 * services the job-card flow calls — a quotation raised on its own and a
 * quotation raised from a job card are the same document, priced, sent and
 * decided by the same code.
 */

/** Refreshes everywhere a quotation shows up, including its job card when it has one. */
async function refreshQuotation(estimateId: string) {
  revalidatePath('/quotations');
  revalidatePath(`/quotations/${estimateId}`);
  revalidatePath('/');
  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { jobCardId: true },
  });
  if (estimate?.jobCardId) {
    revalidatePath(`/job-cards/${estimate.jobCardId}`);
    revalidatePath(`/job-cards/${estimate.jobCardId}/estimate`);
    revalidatePath('/job-cards');
  }
}

/** Opens a quotation for a customer and goes straight to it, ready to price. */
export async function createQuotationAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createQuotation(user, formDataToObject(formData)));
  if (!result.ok) {
    // A double-submitted form already created it — open that one.
    if (result.duplicate && result.duplicateOf) redirect(`/quotations/${result.duplicateOf}`);
    return toClientResult(result);
  }
  revalidatePath('/quotations');
  revalidatePath('/');
  redirect(`/quotations/${result.data!.id}`);
}

export async function saveQuotationDraftAction(
  estimateId: string,
  payload: unknown,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => saveEstimateDraft(user, estimateId, payload));
  if (result.ok) await refreshQuotation(estimateId);
  return toClientResult(result);
}

/** Saves the draft, then sends it. Returns the customer link — the only time the raw link exists. */
export async function saveAndSendQuotationAction(
  estimateId: string,
  payload: unknown,
): Promise<ActionResult<{ link: string; whatsappUrl: string }>> {
  const user = await requireUser();
  const origin = await getRequestOrigin();
  // No revalidation here: re-rendering would unmount the panel showing the
  // one-time link. The client refreshes when the user closes it.
  return runAction(async () => {
    await saveEstimateDraft(user, estimateId, payload);
    const { rawToken } = await sendEstimate(user, estimateId);
    const link = `${origin}${customerQuotePath(rawToken)}`;
    return { link, whatsappUrl: await quotationWhatsApp(user, estimateId, link) };
  });
}

export async function reissueQuotationLinkAction(
  estimateId: string,
): Promise<ActionResult<{ link: string; whatsappUrl: string }>> {
  const user = await requireUser();
  const origin = await getRequestOrigin();
  return runAction(async () => {
    const { rawToken } = await reissueEstimateLink(user, estimateId);
    const link = `${origin}${customerQuotePath(rawToken)}`;
    return { link, whatsappUrl: await quotationWhatsApp(user, estimateId, link) };
  });
}

export async function reviseQuotationAction(estimateId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => reviseEstimate(user, estimateId));
  if (!result.ok) return toClientResult(result);
  await refreshQuotation(estimateId);
  redirect(`/quotations/${result.data!.id}`);
}

export async function recordQuotationDecisionAction(
  estimateId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    recordCustomerDecision(user, estimateId, formDataToObject(formData)),
  );
  if (result.ok) await refreshQuotation(estimateId);
  return toClientResult(result);
}

/** Deletes an unsent first draft, then goes back to the quotation list. */
export async function deleteDraftQuotationAction(estimateId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => deleteDraftQuotation(user, estimateId));
  if (!result.ok) return toClientResult(result);
  revalidatePath('/quotations');
  redirect('/quotations');
}
