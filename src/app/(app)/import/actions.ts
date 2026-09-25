'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { DomainError } from '@/lib/errors';
import {
  importCsv,
  isImportable,
  MAX_IMPORT_BYTES,
  type ImportOutcome,
} from '@/lib/data-transfer/imports';

/** Where each import shows up once it has landed. */
const REVALIDATE: Record<string, string[]> = {
  customers: ['/customers', '/'],
  vehicles: ['/vehicles', '/customers', '/'],
  parts: ['/inventory/parts', '/'],
  suppliers: ['/inventory/suppliers', '/inventory/parts'],
};

export async function importCsvAction(
  entity: string,
  _prev: ActionResult<ImportOutcome>,
  formData: FormData,
): Promise<ActionResult<ImportOutcome>> {
  const user = await requireUser();
  if (!isImportable(entity)) {
    return { ok: false, error: 'That list cannot be imported.' };
  }

  const result = await runAction(async () => {
    const file = formData.get('file');
    if (!(file instanceof File) || file.size === 0) {
      throw new DomainError('Choose a CSV file to import.', 'file');
    }
    if (file.size > MAX_IMPORT_BYTES) {
      throw new DomainError('That file is larger than 2 MB. Split it and import in parts.', 'file');
    }
    const text = await file.text();
    return importCsv(user, entity, text, String(formData.get('requestKey') ?? ''));
  });

  if (result.ok && (result.data?.created ?? 0) > 0) {
    for (const path of REVALIDATE[entity] ?? []) revalidatePath(path);
  }
  return result;
}
