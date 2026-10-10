import type { Prisma } from '@/generated/prisma/client';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission } from '@/lib/auth/authorize';
import { DomainError } from '@/lib/errors';

/*
 * No one can give themselves — or anyone — more power than they hold.
 *
 *   - A role can be granted only by someone who holds every permission in it.
 *   - The Owner role (the built-in system role) is granted only by an Owner.
 *   - An Owner's account — its email, password, roles, being active — is
 *     changed only by an Owner.
 *   - The permissions of a role are changed only by someone who doesn't hold
 *     that role, and only to permissions they hold themselves.
 *
 * Without these, anyone with "manage users" or "manage roles" could reset
 * the Owner's password, or tick their own role up to everything.
 */

type Tx = Prisma.TransactionClient;
const ACTIVE = { revokedAt: null } as const;

/** Whether this login holds the built-in Owner role. */
export async function isOwner(tx: Tx, organizationId: string, userId: string) {
  const held = await tx.userRole.count({
    where: { userId, ...ACTIVE, role: { organizationId, isSystem: true } },
  });
  return held > 0;
}

/** Permissions the actor lacks, of those given. */
function lacking(user: AuthenticatedUser, codes: Iterable<string>) {
  return [...new Set(codes)].filter((code) => !hasPermission(user, code)).sort();
}

/** Refuses granting roles the actor couldn't hold. */
export async function assertCanGrantRoles(tx: Tx, user: AuthenticatedUser, roleIds: string[]) {
  if (roleIds.length === 0) return;
  if (await isOwner(tx, user.organizationId, user.id)) return;
  const roles = await tx.role.findMany({
    where: { id: { in: roleIds }, organizationId: user.organizationId },
    select: {
      name: true,
      isSystem: true,
      rolePermissions: { select: { permission: { select: { code: true } } } },
    },
  });
  if (roles.some((role) => role.isSystem)) {
    throw new DomainError('Only an Owner can make someone an Owner.', 'roleIds');
  }
  const missing = lacking(
    user,
    roles.flatMap((role) => role.rolePermissions.map((row) => row.permission.code)),
  );
  if (missing.length) {
    throw new DomainError(
      `You can only give roles whose permissions you hold yourself. You don't hold: ${missing.join(', ')}.`,
      'roleIds',
    );
  }
}

/** Refuses changing an Owner's account unless the actor is an Owner. */
export async function assertCanManageAccount(
  tx: Tx,
  user: AuthenticatedUser,
  targetUserId: string,
  what: string,
) {
  if (targetUserId === user.id) return;
  if (!(await isOwner(tx, user.organizationId, targetUserId))) return;
  if (await isOwner(tx, user.organizationId, user.id)) return;
  throw new DomainError(`Only an Owner can ${what} an Owner's account.`);
}

/** Refuses editing a role's permissions by someone holding it, or to permissions they lack. */
export async function assertCanEditRolePermissions(
  tx: Tx,
  user: AuthenticatedUser,
  roleId: string,
  added: string[],
) {
  if (await isOwner(tx, user.organizationId, user.id)) return;
  const holdsIt = await tx.userRole.count({ where: { userId: user.id, roleId, ...ACTIVE } });
  if (holdsIt > 0) {
    throw new DomainError(
      'You hold this role, so you can’t change its permissions. Ask an Owner or another administrator.',
      'permissions',
    );
  }
  const missing = lacking(user, added);
  if (missing.length) {
    throw new DomainError(
      `You can only grant permissions you hold yourself. You don't hold: ${missing.join(', ')}.`,
      'permissions',
    );
  }
}
