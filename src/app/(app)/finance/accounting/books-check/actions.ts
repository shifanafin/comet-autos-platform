'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { bringBooksIntoStep, checkBooks } from '@/lib/accounting/books-check';
import type { PostedSource } from '@/lib/accounting/journal';

/*
 * The books check (lib/accounting/books-check.ts): run on demand — it looks
 * at every record — and bring what it finds into step by each record's own
 * rule, one at a time or all.
 */

/** Dates as text, so the result crosses to the screen as plain data. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export async function runBooksCheckAction(): Promise<
  ActionResult<Awaited<ReturnType<typeof checkBooks>>>
> {
  const user = await requireUser();
  const result = await runAction(() => checkBooks(user));
  return result.ok ? { ok: true, data: plain(result.data) } : { ok: false, error: result.error };
}

export async function bringIntoStepAction(
  only?: { source: PostedSource; sourceId: string },
): Promise<ActionResult<Awaited<ReturnType<typeof bringBooksIntoStep>>>> {
  const user = await requireUser();
  const result = await runAction(() => bringBooksIntoStep(user, only));
  if (result.ok) {
    revalidatePath('/finance/accounting', 'layout');
    revalidatePath('/finance', 'layout');
  }
  return result.ok ? { ok: true, data: plain(result.data) } : { ok: false, error: result.error };
}
