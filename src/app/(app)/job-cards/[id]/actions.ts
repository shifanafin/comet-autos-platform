'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { WorkflowStatus } from '@/lib/workshop/stages';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { transitionJobStatus } from '@/lib/workshop/job-status';
import { assignPrimaryTechnician } from '@/lib/workshop/assignment';
import { startInspection, saveInspection } from '@/lib/workshop/inspection';
import { saveDiagnosis } from '@/lib/workshop/diagnosis';
import {
  createEstimate,
  saveEstimateDraft,
  sendEstimate,
  reissueEstimateLink,
  reviseEstimate,
  recordCustomerDecision,
  createAdditionalEstimate,
} from '@/lib/workshop/estimates';
import {
  recordLabour,
  recordPartUsage,
  returnPartFromJob,
  startRepair,
} from '@/lib/workshop/repair';
import { recordQualityCheck } from '@/lib/workshop/quality-check';
import { removeJobPhoto } from '@/lib/media/photos';
import { updateJobCardDetails } from '@/lib/workshop/job-card-details';
import { createInvoice, deliverVehicle, recordPayment } from '@/lib/billing/invoice';
import { customerQuotePath, getRequestOrigin } from '@/lib/request-origin';
import { quotationWhatsApp } from '@/lib/customer-access/share';

function refreshJob(jobCardId: string) {
  revalidatePath(`/job-cards/${jobCardId}`, 'layout');
  revalidatePath('/job-cards');
  revalidatePath('/');
}

export async function changeJobStatusAction(
  jobCardId: string,
  toStatus: WorkflowStatus,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(async () => {
    await prisma.$transaction((tx) => transitionJobStatus(tx, user, jobCardId, toStatus));
  });
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

export async function assignTechnicianAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    assignPrimaryTechnician(user, jobCardId, String(formData.get('employeeId') ?? '')),
  );
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

export async function startInspectionAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    startInspection(user, jobCardId, String(formData.get('employeeId') ?? '')),
  );
  if (!result.ok) return toClientResult(result);
  refreshJob(jobCardId);
  redirect(`/job-cards/${jobCardId}/inspection`);
}

export async function saveInspectionAction(
  jobCardId: string,
  inspectionId: string,
  payload: unknown,
  complete: boolean,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => saveInspection(user, inspectionId, payload, { complete }));
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

export async function saveDiagnosisAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => saveDiagnosis(user, jobCardId, formDataToObject(formData)));
  if (!result.ok) return toClientResult(result);
  refreshJob(jobCardId);
  redirect(`/job-cards/${jobCardId}/estimate`);
}

/**
 * Opens the job card's quotation and goes to it. A quotation raised this
 * way and one raised straight for a customer are the same document on the
 * same screen, so both land on /quotations/<id>.
 */
export async function createEstimateAction(jobCardId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createEstimate(user, jobCardId));
  if (!result.ok) return toClientResult(result);
  refreshJob(jobCardId);
  revalidatePath('/quotations');
  redirect(`/quotations/${result.data!.id}`);
}

export async function saveEstimateDraftAction(
  jobCardId: string,
  estimateId: string,
  payload: unknown,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => saveEstimateDraft(user, estimateId, payload));
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

/** Saves the draft, then sends it. Returns the customer link — the only time the raw link exists. */
export async function saveAndSendEstimateAction(
  jobCardId: string,
  estimateId: string,
  payload: unknown,
): Promise<ActionResult<{ link: string; whatsappUrl: string }>> {
  const user = await requireUser();
  const origin = await getRequestOrigin();
  const result = await runAction(async () => {
    await saveEstimateDraft(user, estimateId, payload);
    const { rawToken } = await sendEstimate(user, estimateId);
    const link = `${origin}${customerQuotePath(rawToken)}`;
    return { link, whatsappUrl: await quotationWhatsApp(user, estimateId, link) };
  });
  // No revalidation here: re-rendering would unmount the panel that shows the
  // one-time link. The client refreshes when the user closes the panel.
  return result;
}

export async function reissueLinkAction(
  jobCardId: string,
  estimateId: string,
): Promise<ActionResult<{ link: string; whatsappUrl: string }>> {
  const user = await requireUser();
  const origin = await getRequestOrigin();
  const result = await runAction(async () => {
    const { rawToken } = await reissueEstimateLink(user, estimateId);
    const link = `${origin}${customerQuotePath(rawToken)}`;
    return { link, whatsappUrl: await quotationWhatsApp(user, estimateId, link) };
  });
  return result;
}

export async function reviseEstimateAction(
  jobCardId: string,
  estimateId: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => reviseEstimate(user, estimateId));
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

export async function recordDecisionAction(
  jobCardId: string,
  estimateId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    recordCustomerDecision(user, estimateId, formDataToObject(formData)),
  );
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

// ---------------------------------------------------------------------------
// Repair → quality check
// ---------------------------------------------------------------------------

export async function startRepairAction(jobCardId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => startRepair(user, jobCardId));
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

export async function recordPartUsageAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    recordPartUsage(user, jobCardId, formDataToObject(formData)),
  );
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

/** Takes a recorded part back into stock (a JOB_RETURN ledger entry); the original record stays. */
export async function returnPartAction(
  jobCardId: string,
  partUsageId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    returnPartFromJob(user, jobCardId, partUsageId, formDataToObject(formData)),
  );
  if (result.ok) {
    refreshJob(jobCardId);
    revalidatePath('/inventory', 'layout');
  }
  return toClientResult(result);
}

export async function recordLabourAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => recordLabour(user, jobCardId, formDataToObject(formData)));
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

export async function recordQualityCheckAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    recordQualityCheck(user, jobCardId, formDataToObject(formData)),
  );
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

export async function createAdditionalEstimateAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    createAdditionalEstimate(user, jobCardId, formDataToObject(formData)),
  );
  if (!result.ok || !result.data) return toClientResult(result);
  refreshJob(jobCardId);
  redirect(`/job-cards/${jobCardId}/additional/${result.data.id}`);
}

// ---------------------------------------------------------------------------
// Invoice → payment → delivery
// ---------------------------------------------------------------------------

function refreshFinance(jobCardId: string) {
  refreshJob(jobCardId);
  revalidatePath('/customers', 'layout');
}

export async function createInvoiceAction(jobCardId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createInvoice(user, jobCardId));
  if (result.ok) refreshFinance(jobCardId);
  return toClientResult(result);
}

export async function recordPaymentAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => recordPayment(user, jobCardId, formDataToObject(formData)));
  if (result.ok) refreshFinance(jobCardId);
  return toClientResult(result);
}

export async function deliverVehicleAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => deliverVehicle(user, jobCardId, formDataToObject(formData)));
  if (result.ok) refreshFinance(jobCardId);
  return toClientResult(result);
}

/** Removes a photo from the job (kept on record as removed, with who removed it). */
export async function removePhotoAction(jobCardId: string, documentId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => removeJobPhoto(user, jobCardId, documentId));
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}

/** Corrects the request and mileage written at check-in. */
export async function updateJobCardDetailsAction(
  jobCardId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    updateJobCardDetails(user, jobCardId, formDataToObject(formData)),
  );
  if (result.ok) refreshJob(jobCardId);
  return toClientResult(result);
}
