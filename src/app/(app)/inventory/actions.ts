'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { convertPartUnit } from '@/lib/inventory/unit-conversion';
import { adjustStock, createPart, reverseMovement, updatePart } from '@/lib/inventory/parts';
import { createSupplier, updateSupplier } from '@/lib/inventory/suppliers';
import { getPartOption, type PartOption } from '@/lib/inventory/part-options';
import { mergeSuppliers } from '@/lib/inventory/supplier-merge';
import {
  cancelPurchase,
  createPurchase,
  receivePurchase,
  updatePurchase,
  updatePurchaseDetails,
} from '@/lib/inventory/purchases';

import { removeAttachment } from '@/lib/documents/attachments';
import { buyPartForJob, refuseLikelyDuplicate } from '@/lib/inventory/quick-purchase';
import { matchBill } from '@/lib/inventory/bills';
import { postStockCount } from '@/lib/inventory/stock-count';

function refreshInventory() {
  revalidatePath('/inventory', 'layout');
}

export async function createPartAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createPart(user, formDataToObject(formData)));
  const id = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !id) return toClientResult(result);
  refreshInventory();
  redirect(`/inventory/parts/${id}?created=1`);
}

/**
 * A new part added from a line's part picker (invoice, quotation, purchase):
 * saved like any other part, then handed back so the line can use it — no
 * page change.
 */
export async function quickCreatePartAction(
  _prev: ActionResult<PartOption>,
  formData: FormData,
): Promise<ActionResult<PartOption>> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  const result = await runAction(async () => {
    // Not a second copy of a part already there under another spelling.
    if (input.confirmNew !== '1') {
      await refuseLikelyDuplicate(prisma, user.organizationId, {
        name: input.name ?? '',
        sku: input.sku,
      });
    }
    return createPart(user, input);
  });
  const id = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !id) return { ...toClientResult(result), data: undefined };
  refreshInventory();
  return { ok: true, data: await getPartOption(user, id) };
}

export async function updatePartAction(
  partId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => updatePart(user, partId, formDataToObject(formData)));
  if (!result.ok) return toClientResult(result);
  refreshInventory();
  redirect(`/inventory/parts/${partId}`);
}

export async function convertPartUnitAction(
  partId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => convertPartUnit(user, partId, formDataToObject(formData)));
  if (result.ok) refreshInventory();
  return toClientResult(result);
}

export async function adjustStockAction(
  partId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => adjustStock(user, partId, formDataToObject(formData)));
  if (result.ok) refreshInventory();
  return toClientResult(result);
}

export async function reverseMovementAction(
  transactionId: string,
  reason: string,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => reverseMovement(user, transactionId, { reason }));
  if (result.ok) refreshInventory();
  return toClientResult(result);
}

export async function createSupplierAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => createSupplier(user, formDataToObject(formData)));
  const id = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !id) return toClientResult(result);
  refreshInventory();
  redirect(`/inventory/suppliers/${id}`);
}

/** A new supplier added from a supplier list (purchase, new part): handed back to be selected — no page change. */
export async function quickCreateSupplierAction(
  _prev: ActionResult<{ id: string; name: string }>,
  formData: FormData,
): Promise<ActionResult<{ id: string; name: string }>> {
  const user = await requireUser();
  const result = await runAction(() => createSupplier(user, formDataToObject(formData)));
  const id = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !id) return { ...toClientResult(result), data: undefined };
  refreshInventory();
  const supplier = await prisma.supplier.findFirst({
    where: { id, organizationId: user.organizationId },
    select: { id: true, name: true },
  });
  return supplier ? { ok: true, data: supplier } : { ok: false, error: 'Supplier not found.' };
}

export async function updateSupplierAction(
  supplierId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    updateSupplier(user, supplierId, formDataToObject(formData)),
  );
  if (!result.ok) return toClientResult(result);
  refreshInventory();
  redirect(`/inventory/suppliers/${supplierId}`);
}

/** Saves a new purchase; the submit button's `intent` decides whether it is received straight away. */
export async function createPurchaseAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  const result = await runAction(() =>
    createPurchase(user, input, { receive: input.intent === 'receive' }),
  );
  const id = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !id) return toClientResult(result);
  refreshInventory();
  revalidatePath('/finance/payables', 'layout');
  revalidatePath('/finance/money', 'layout');
  redirect(`/inventory/purchases/${id}`);
}

/**
 * Creates a purchase filled by Scan bill. Answers with its id instead of
 * redirecting, so the browser can attach the scanned file first.
 */
export async function createScannedPurchaseAction(
  _prev: ActionResult<{ id: string }>,
  formData: FormData,
): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  const result = await runAction(() =>
    createPurchase(user, input, { receive: input.intent === 'receive' }),
  );
  const id = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (result.ok || result.duplicate) refreshInventory();
  return { ...toClientResult(result), data: id ? { id } : undefined };
}

export async function removePurchaseBillAction(documentId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => removeAttachment(user, 'Purchase', documentId));
  if (result.ok) refreshInventory();
  return toClientResult(result);
}

export async function updatePurchaseAction(
  purchaseId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    updatePurchase(user, purchaseId, formDataToObject(formData)),
  );
  if (!result.ok) return toClientResult(result);
  refreshInventory();
  redirect(`/inventory/purchases/${purchaseId}`);
}

/** Corrects a received purchase's invoice number, date, due date and notes. */
export async function updatePurchaseDetailsAction(
  purchaseId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    updatePurchaseDetails(user, purchaseId, formDataToObject(formData)),
  );
  if (result.ok) refreshInventory();
  return toClientResult(result);
}

/** Receives the quantities typed per line (fields named `line:<purchaseItemId>`). */
export async function receivePurchaseAction(
  purchaseId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const quantities: Record<string, string> = {};
  const input = formDataToObject(formData);
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith('line:')) quantities[key.slice(5)] = value;
  }
  const result = await runAction(() =>
    receivePurchase(user, purchaseId, quantities, {
      requestKey: input.requestKey,
      payment: input.payment,
      payAmount: input.payAmount,
      method: input.method,
      accountId: input.accountId,
      payReference: input.payReference,
      dueDate: input.dueDate,
      updateCostPrice: input.updateCostPrice,
    }),
  );
  if (result.ok) {
    // Paid now: the supplier screens change too.
    revalidatePath('/finance/payables', 'layout');
    revalidatePath('/finance/outstanding');
    revalidatePath('/finance/money', 'layout');
  }
  if (result.ok) refreshInventory();
  const client = toClientResult(result);
  // Line errors are keyed by purchase line id; surface them on the matching input.
  if (client.fieldErrors) {
    client.fieldErrors = Object.fromEntries(
      Object.entries(client.fieldErrors).map(([key, message]) => [`line:${key}`, message]),
    );
  }
  return client;
}

export async function cancelPurchaseAction(purchaseId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => cancelPurchase(user, purchaseId));
  if (result.ok) refreshInventory();
  return toClientResult(result);
}

/** Merges this supplier into the one kept, then opens the kept supplier. */
export async function mergeSupplierAction(
  duplicateId: string,
  input: { targetId: string; reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => mergeSuppliers(user, duplicateId, input));
  const targetId = result.data?.targetId ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !targetId) return toClientResult(result);
  refreshInventory();
  revalidatePath('/finance', 'layout');
  redirect(`/inventory/suppliers/${targetId}?merged=1`);
}

/**
 * A part bought for a job, recorded from an invoice line: the part (picked
 * or added), its purchase received into stock, and the payment. The line
 * gets the part back with its new stock and the cost paid.
 */
export async function buyPartForJobAction(
  _prev: ActionResult<BoughtPart>,
  formData: FormData,
): Promise<ActionResult<BoughtPart>> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  const result = await runAction(() => buyPartForJob(user, input));
  if (!result.ok || !result.data) return { ...toClientResult(result), data: undefined };
  refreshInventory();
  revalidatePath('/finance/payables', 'layout');
  revalidatePath('/finance/money', 'layout');
  return {
    ok: true,
    data: {
      part: await getPartOption(user, result.data.partId),
      unitCost: input.unitCost ?? '',
      purchaseNumber: result.data.purchaseNumber,
      billAwaited: result.data.billAwaited,
    },
  };
}

export interface BoughtPart {
  part: PartOption;
  /** What one cost, as paid — the invoice line's cost. */
  unitCost: string;
  purchaseNumber: string;
  billAwaited: boolean;
}

/** The supplier's tax invoice matched to a purchase — or recorded as never coming. */
export async function matchBillAction(
  purchaseId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => matchBill(user, purchaseId, formDataToObject(formData)));
  if (!result.ok) return toClientResult(result);
  refreshInventory();
  revalidatePath('/finance', 'layout');
  redirect('/inventory/purchases/bills?matched=1');
}

/** Posts a stock count: each part's stock corrected to what was counted. */
export async function postStockCountAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => postStockCount(user, formDataToObject(formData)));
  if (!result.ok || !result.data) return toClientResult(result);
  refreshInventory();
  revalidatePath('/finance', 'layout');
  redirect(
    `/inventory/stock-count?posted=${result.data.countNumber}&corrected=${result.data.corrected}&counted=${result.data.counted}`,
  );
}
