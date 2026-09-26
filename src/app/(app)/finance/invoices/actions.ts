'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { prisma } from '@/lib/prisma';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { recordInvoicePayment } from '@/lib/billing/invoice';
import { reverseInvoicePayment, updateInvoice, voidInvoice } from '@/lib/billing/invoice-changes';

/*
 * Invoices as documents in their own right. Both actions call the shared
 * billing services — the same numbering, VAT, balance and payment rules the
 * job-card billing screen uses.
 */

/** Refreshes everywhere an invoice shows up, including its job card when it has one. */
async function refreshInvoice(invoiceId: string) {
  revalidatePath('/finance/invoices');
  revalidatePath(`/finance/invoices/${invoiceId}`);
  revalidatePath('/finance');
  revalidatePath('/finance/payments');
  revalidatePath('/finance/outstanding');
  revalidatePath('/');
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { jobCardId: true },
  });
  if (invoice?.jobCardId) {
    revalidatePath(`/job-cards/${invoice.jobCardId}`, 'layout');
    revalidatePath('/job-cards');
  }
}

export async function createDirectInvoiceAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  // The lines arrive as a JSON payload so one field can carry a whole table.
  let items: unknown = [];
  try {
    items = input.items ? JSON.parse(input.items) : [];
  } catch {
    return { ok: false, error: 'The invoice lines could not be read. Refresh and try again.' };
  }

  const result = await runAction(() => createDirectInvoice(user, { ...input, items }));
  if (!result.ok) {
    // A double-submitted form already issued it — open that invoice.
    if (result.duplicate && result.duplicateOf) {
      redirect(`/finance/invoices/${result.duplicateOf}`);
    }
    return toClientResult(result);
  }
  await refreshInvoice(result.data!.invoiceId);
  redirect(`/finance/invoices/${result.data!.invoiceId}`);
}

export async function recordInvoicePaymentAction(
  invoiceId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    recordInvoicePayment(user, invoiceId, formDataToObject(formData)),
  );
  if (result.ok || result.duplicate) await refreshInvoice(invoiceId);
  return toClientResult(result);
}

/** Saves corrected lines on an unpaid invoice, then opens it. */
export async function updateInvoiceAction(
  invoiceId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  let items: unknown = [];
  try {
    items = input.items ? JSON.parse(input.items) : [];
  } catch {
    return { ok: false, error: 'The invoice lines could not be read. Refresh and try again.' };
  }
  const result = await runAction(() => updateInvoice(user, invoiceId, { ...input, items }));
  if (!result.ok && !result.duplicate) return toClientResult(result);
  await refreshInvoice(invoiceId);
  redirect(`/finance/invoices/${invoiceId}`);
}

export async function voidInvoiceAction(
  invoiceId: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => voidInvoice(user, invoiceId, input));
  if (result.ok || result.duplicate) await refreshInvoice(invoiceId);
  return toClientResult(result);
}

export async function reverseInvoicePaymentAction(
  invoiceId: string,
  paymentId: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => reverseInvoicePayment(user, paymentId, input));
  if (result.ok || result.duplicate) {
    await refreshInvoice(invoiceId);
    revalidatePath('/customers', 'layout');
  }
  return toClientResult(result);
}
