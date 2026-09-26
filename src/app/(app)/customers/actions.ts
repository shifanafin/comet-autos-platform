'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireUser } from '@/lib/auth/authorize';
import { runAction, toClientResult } from '@/lib/action';
import {
  archiveCustomer,
  archiveVehicle,
  restoreCustomer,
  restoreVehicle,
} from '@/lib/customers/archive';
import type { ActionResult } from '@/lib/errors';
import { formDataToObject } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import {
  createCustomer,
  findCustomersByPhone,
  updateCustomer,
  type CustomerInput,
} from '@/lib/customers/service';
import {
  createVehicle,
  transferVehicleOwnership,
  updateVehicle,
  type VehicleInput,
} from '@/lib/vehicles/service';

// Shape is validated by the services' zod schemas; missing fields become field errors there.
const asCustomer = (formData: FormData) => formDataToObject(formData) as unknown as CustomerInput;
const asVehicle = (input: Record<string, string>) => input as unknown as VehicleInput;

const fail = (result: ActionResult<unknown>): ActionResult => ({
  ok: false,
  error: result.error,
  fieldErrors: result.fieldErrors,
});

export async function createCustomerAction(
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  const result = await runAction(() =>
    prisma.$transaction(async (tx) => {
      await claimRequestKey(tx, user, input, 'customer.create');
      const customer = await createCustomer(tx, user, asCustomer(formData));
      await settleRequestKey(tx, user, input, customer.id);
      return customer;
    }),
  );
  const customerId = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !customerId) return fail(result);
  revalidatePath('/customers');
  redirect(`/customers/${customerId}/vehicles/new?new=1`);
}

export async function updateCustomerAction(
  customerId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => updateCustomer(user, customerId, asCustomer(formData)));
  if (!result.ok) return fail(result);
  revalidatePath('/customers');
  revalidatePath(`/customers/${customerId}`);
  redirect(`/customers/${customerId}`);
}

/** Warns (never blocks) when the mobile number already belongs to another customer. */
export async function checkDuplicatePhoneAction(phone: string, excludeCustomerId?: string) {
  const user = await requireUser();
  try {
    return await findCustomersByPhone(user, phone, excludeCustomerId);
  } catch {
    return [];
  }
}

export async function createVehicleAction(
  customerId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const input = formDataToObject(formData);
  const result = await runAction(() =>
    prisma.$transaction(async (tx) => {
      await claimRequestKey(tx, user, input, 'vehicle.create');
      const vehicle = await createVehicle(tx, user, customerId, asVehicle(input));
      await settleRequestKey(tx, user, input, vehicle.id);
      return vehicle;
    }),
  );
  const vehicleId = result.data?.id ?? (result.duplicate ? result.duplicateOf : null);
  if (!result.ok || !vehicleId) return fail(result);
  revalidatePath(`/customers/${customerId}`);
  revalidatePath('/vehicles');
  redirect(input.next === 'check-in' ? `/check-in?vehicle=${vehicleId}` : `/vehicles/${vehicleId}`);
}

export async function updateVehicleAction(
  vehicleId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    updateVehicle(user, vehicleId, asVehicle(formDataToObject(formData))),
  );
  if (!result.ok) return fail(result);
  revalidatePath('/vehicles');
  revalidatePath(`/vehicles/${vehicleId}`);
  redirect(`/vehicles/${vehicleId}`);
}

export async function transferVehicleAction(
  vehicleId: string,
  _prev: ActionResult,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() =>
    transferVehicleOwnership(user, vehicleId, formDataToObject(formData)),
  );
  if (!result.ok && !result.duplicate) return fail(result);
  revalidatePath('/vehicles');
  revalidatePath(`/vehicles/${vehicleId}`);
  revalidatePath('/customers', 'layout');
  redirect(`/vehicles/${vehicleId}?transferred=1`);
}

// ---------------------------------------------------------------------------
// Delete (archive) and restore
// ---------------------------------------------------------------------------

function refreshPeople(customerId: string | null, vehicleId: string | null) {
  revalidatePath('/customers');
  revalidatePath('/vehicles');
  if (customerId) revalidatePath(`/customers/${customerId}`);
  if (vehicleId) revalidatePath(`/vehicles/${vehicleId}`);
}

export async function archiveCustomerAction(
  customerId: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => archiveCustomer(user, customerId, input));
  if (result.ok || result.duplicate) refreshPeople(customerId, null);
  return toClientResult(result);
}

export async function restoreCustomerAction(customerId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => restoreCustomer(user, customerId));
  if (result.ok) refreshPeople(customerId, null);
  return toClientResult(result);
}

export async function archiveVehicleAction(
  vehicleId: string,
  input: { reason: string; requestKey: string },
): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => archiveVehicle(user, vehicleId, input));
  if (result.ok || result.duplicate) refreshPeople(result.data?.customerId ?? null, vehicleId);
  return toClientResult(result);
}

export async function restoreVehicleAction(vehicleId: string): Promise<ActionResult> {
  const user = await requireUser();
  const result = await runAction(() => restoreVehicle(user, vehicleId));
  if (result.ok) refreshPeople(null, vehicleId);
  return toClientResult(result);
}
