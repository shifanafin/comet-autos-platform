import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { DomainError, NotFoundError, toActionError } from '@/lib/errors';
import { archiveCustomer, archiveVehicle } from '@/lib/customers/archive';
import { deleteDraftQuotation } from '@/lib/workshop/estimates';
import {
  JOB_STATUS_LABEL,
  getAllowedNextStatuses,
  transitionJobStatus,
} from '@/lib/workshop/job-status';
import { reverseInvoicePayment, voidInvoice } from '@/lib/billing/invoice-changes';
import { deletePart, reverseMovement } from '@/lib/inventory/parts';
import { deleteSupplier } from '@/lib/inventory/suppliers';
import { cancelPurchase } from '@/lib/inventory/purchases';
import {
  MAX_REMOVE_AT_ONCE,
  REMOVAL,
  type RemovableEntity,
  type RemovalOutcome,
} from '@/lib/records/removal';

/*
 * Delete — one row or many — on every list. Each record goes through the
 * same service its own screen uses (archive, void, cancel, reverse), so a
 * bulk action can never do what a single one would refuse: every rule,
 * permission check and audit entry is the service's own.
 *
 * Each record is its own transaction. One that can't be removed is skipped
 * with the reason and the rest carry on; nothing is ever half-done.
 */

type Outcome = 'done' | 'archived';
type Remover = (user: AuthenticatedUser, id: string, reason: string | null) => Promise<Outcome>;

/** A job card is cancelled, never erased: its number and history stay. */
async function cancelJobCard(user: AuthenticatedUser, jobCardId: string): Promise<Outcome> {
  const job = await prisma.jobCard.findFirst({
    where: { id: jobCardId, organizationId: user.organizationId },
    select: { jobNumber: true, status: true },
  });
  if (!job) throw new NotFoundError('job card');
  if (job.status === 'CANCELLED') throw new DomainError(`${job.jobNumber} is already cancelled.`);
  if (!getAllowedNextStatuses(job.status).includes('CANCELLED')) {
    throw new DomainError(
      `${job.jobNumber} is ${JOB_STATUS_LABEL[job.status].toLowerCase()} and can’t be cancelled.${
        ['INVOICED', 'PAID'].includes(job.status) ? ' Void its invoice first.' : ''
      }`,
    );
  }
  await prisma.$transaction((tx) => transitionJobStatus(tx, user, jobCardId, 'CANCELLED'));
  return 'done';
}

const REMOVERS: Record<RemovableEntity, Remover> = {
  customers: async (user, id, reason) => {
    await archiveCustomer(user, id, { reason: reason ?? undefined });
    return 'done';
  },
  vehicles: async (user, id, reason) => {
    await archiveVehicle(user, id, { reason: reason ?? undefined });
    return 'done';
  },
  'job-cards': (user, id) => cancelJobCard(user, id),
  quotations: async (user, id) => {
    await deleteDraftQuotation(user, id);
    return 'done';
  },
  invoices: async (user, id, reason) => {
    await voidInvoice(user, id, { reason });
    return 'done';
  },
  payments: async (user, id, reason) => {
    await reverseInvoicePayment(user, id, { reason });
    return 'done';
  },
  parts: async (user, id) =>
    (await deletePart(user, id)).outcome === 'archived' ? 'archived' : 'done',
  suppliers: async (user, id) =>
    (await deleteSupplier(user, id)).outcome === 'archived' ? 'archived' : 'done',
  purchases: async (user, id) => {
    await cancelPurchase(user, id);
    return 'done';
  },
  movements: async (user, id, reason) => {
    await reverseMovement(user, id, { reason });
    return 'done';
  },
};

const inputSchema = z.object({
  entity: z.enum(Object.keys(REMOVAL) as [RemovableEntity, ...RemovableEntity[]]),
  ids: z
    .array(z.uuid())
    .min(1, 'Choose at least one row.')
    .max(MAX_REMOVE_AT_ONCE, `Choose up to ${MAX_REMOVE_AT_ONCE} rows at a time.`),
  reason: z.string().trim().max(500).optional(),
});

export async function removeRecords(
  user: AuthenticatedUser,
  rawInput: unknown,
): Promise<RemovalOutcome> {
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new DomainError(parsed.error.issues[0]?.message ?? 'Choose the rows again.');
  }
  const { entity, ids } = parsed.data;
  const copy = REMOVAL[entity];
  const reason = parsed.data.reason || null;
  if (copy.reason === 'required' && (!reason || reason.length < 3)) {
    throw new DomainError(
      `Say why, in a few words — it is kept with each ${copy.singular}.`,
      'reason',
    );
  }

  const outcome: RemovalOutcome = { done: [], archived: 0, skipped: [] };
  // One at a time, in the order shown: each is its own transaction, and a
  // refusal for one never undoes or blocks the others.
  for (const id of [...new Set(ids)]) {
    try {
      const result = await REMOVERS[entity](user, id, reason);
      outcome.done.push(id);
      if (result === 'archived') outcome.archived += 1;
    } catch (error) {
      const mapped = toActionError(error);
      if (mapped.ok)
        outcome.done.push(id); // the same request already went through
      else outcome.skipped.push({ id, reason: mapped.error ?? 'This one couldn’t be changed.' });
    }
  }
  return outcome;
}
