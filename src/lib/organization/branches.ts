import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull, normalizePhone } from '@/lib/normalize';

/*
 * The workshop's branches — where it works from. Their names appear in the
 * top bar, on stock and staff screens, and in user access. Editable in
 * Settings alongside the workshop's own details, under the same rights.
 *
 * The branch code is not editable: document numbering and imports key on it.
 */

const branchSchema = z.object({
  name: z
    .string({ error: 'Enter the branch name.' })
    .trim()
    .min(2, 'Enter the branch name.')
    .max(120, 'Keep the name under 120 characters.'),
  address: z.string().trim().max(300).optional(),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .refine((value) => !value || /^[+\d][\d\s()-]{5,}$/.test(value), 'Enter a valid phone number.'),
});

export async function listBranches(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  return prisma.branch.findMany({
    where: { organizationId: user.organizationId },
    orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    select: { id: true, code: true, name: true, address: true, phone: true, isActive: true },
  });
}

export type BranchSettings = Awaited<ReturnType<typeof listBranches>>[number];

export async function updateBranch(user: AuthenticatedUser, branchId: string, rawInput: unknown) {
  const input = parseInput(branchSchema, rawInput);
  requirePermission(user, 'accounting.edit');
  const data = {
    name: input.name.replace(/\s+/g, ' '),
    address: emptyToNull(input.address),
    phone: input.phone ? normalizePhone(input.phone) : null,
  };

  return prisma.$transaction(async (tx) => {
    const before = await tx.branch.findFirst({
      where: { id: branchId, organizationId: user.organizationId },
      select: { id: true, name: true, address: true, phone: true },
    });
    if (!before) throw new NotFoundError('branch');
    const clash = await tx.branch.findFirst({
      where: {
        organizationId: user.organizationId,
        id: { not: before.id },
        name: { equals: data.name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (clash) throw new DomainError('Another branch already has this name.', 'name');

    await tx.branch.update({ where: { id: before.id }, data });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: before.id,
      actorUserId: user.id,
      action: 'branch.updated',
      entityType: 'Branch',
      entityId: before.id,
      beforeData: { name: before.name, address: before.address, phone: before.phone },
      afterData: data,
    });
    return { branchId: before.id };
  });
}
