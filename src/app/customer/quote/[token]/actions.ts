'use server';

import { revalidatePath } from 'next/cache';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { decideQuoteAsCustomer } from '@/lib/customer-access/quote';

/*
 * Public Server Actions for the customer quotation page. They take only the
 * raw token from the URL plus what the customer typed — never an internal id.
 * No staff session is read or required.
 */

export async function decideQuoteAction(
  rawToken: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const decision = formData.get('decision');
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    return { ok: false, error: 'Choose approve or reject.' };
  }
  const result = await runAction(() =>
    decideQuoteAsCustomer(
      rawToken,
      decision,
      String(formData.get('notes') ?? '') || null,
      String(formData.get('signature') ?? '') || null,
    ),
  );
  if (result.ok) revalidatePath(`/customer/quote/${rawToken}`);
  return toClientResult(result);
}
