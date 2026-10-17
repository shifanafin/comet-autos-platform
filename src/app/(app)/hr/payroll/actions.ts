'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import {
  adjustDeduction,
  approvePayroll,
  cancelPayroll,
  markPayrollPaid,
  recalculatePayroll,
  runPayroll,
  setSalary,
} from '@/lib/hr/payroll';
import { setPayDetails } from '@/lib/hr/wps';

function refresh() {
  revalidatePath('/hr', 'layout');
  revalidatePath('/finance', 'layout');
}

export async function runPayrollAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => runPayroll(user, formDataToObject(formData)));
  const id = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !id) return toClientResult(result);
  refresh();
  redirect(`/hr/payroll/${id}`);
}

export async function recalculatePayrollAction(payrollId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => recalculatePayroll(user, payrollId));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function approvePayrollAction(payrollId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => approvePayroll(user, payrollId));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function markPayrollPaidAction(
  payrollId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    markPayrollPaid(user, payrollId, formDataToObject(formData)),
  );
  if (result.ok || result.duplicate) refresh();
  return toClientResult(result);
}

export async function cancelPayrollAction(
  payrollId: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => cancelPayroll(user, payrollId, input));
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function adjustDeductionAction(
  payrollId: string,
  itemId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    adjustDeduction(user, payrollId, itemId, formDataToObject(formData)),
  );
  if (result.ok) refresh();
  return toClientResult(result);
}

export async function setSalaryAction(
  employeeId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => setSalary(user, employeeId, formDataToObject(formData)));
  if (result.ok || result.duplicate) {
    refresh();
    revalidatePath(`/hr/employees/${employeeId}`);
  }
  return toClientResult(result);
}

export async function setPayDetailsAction(
  employeeId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => setPayDetails(user, employeeId, formDataToObject(formData)));
  if (result.ok || result.duplicate) revalidatePath(`/hr/employees/${employeeId}`);
  return toClientResult(result);
}
