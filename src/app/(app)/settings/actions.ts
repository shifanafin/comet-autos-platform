'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import {
  setDetailedJobCards,
  setHiddenMenus,
  updateOrganizationSettings,
} from '@/lib/organization/settings';
import { updateBranch } from '@/lib/organization/branches';

export async function saveOrganizationSettingsAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    updateOrganizationSettings(user, formDataToObject(formData)),
  );
  if (result.ok || result.duplicate) {
    // The workshop's details head every document and decide the default VAT,
    // and its name is the app's name — in the sidebar and every tab title.
    revalidatePath('/', 'layout');
  }
  return toClientResult(result);
}

export async function setJobCardStyleAction(detailed: boolean): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => setDetailedJobCards(user, detailed));
  if (result.ok) {
    // Decides which job card every job card opens as, and whether the
    // standard job card's menus show — both around every page.
    revalidatePath('/', 'layout');
  }
  return toClientResult(result);
}

export async function setHiddenMenusAction(hrefs: string[]): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => setHiddenMenus(user, hrefs));
  // The menus sit in the layout around every page.
  if (result.ok) revalidatePath('/', 'layout');
  return toClientResult(result);
}

export async function updateBranchAction(
  branchId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => updateBranch(user, branchId, formDataToObject(formData)));
  // The branch name sits in the top bar on every page.
  if (result.ok) revalidatePath('/', 'layout');
  return toClientResult(result);
}
