import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { hashPassword } from '@/lib/auth/password';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull, normalizePhone } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';

/*
 * Who can sign in to the app, and what they are allowed to do.
 *
 * Nothing here is a new authorization system. A user's reach is still the
 * union of the permissions on their non-revoked role grants, resolved by
 * `lib/auth/session` at sign-in — this module only lets someone with
 * `user.manage` change those grants from a screen instead of from SQL.
 *
 * Three rules are enforced here and nowhere else, because only this module
 * can see the whole picture:
 *
 *   1. One login per employee. The database already refuses a second
 *      (`@@unique([organizationId, userId])` on Employee); this explains it
 *      in words the person on the screen can act on.
 *   2. Nobody removes their own access. Deactivating yourself or changing
 *      your own roles is refused, so a mis-click cannot lock you out.
 *   3. The workshop never loses its last administrator. A change that would
 *      leave no active user able to manage access is refused outright.
 */

export const PAGE_SIZE = 25;
/** A hard ceiling, so a hand-typed page size can never ask for everything. */
const MAX_PAGE_SIZE = 100;

/** Revoking a role grant is a soft delete, so the history stays readable. */
const ACTIVE_GRANT = { revokedAt: null } as const;

const passwordSchema = z
  .string({ error: 'Enter a password.' })
  .min(10, 'Use at least 10 characters.')
  .max(200)
  .refine(
    (value) => /[a-zA-Z]/.test(value) && /\d/.test(value),
    'Use letters and at least one number.',
  );

const baseUserSchema = z.object({
  fullName: z
    .string({ error: 'Enter the person’s name.' })
    .trim()
    .min(2, 'Enter the person’s name.')
    .max(120),
  email: z.email('Enter a valid email address.'),
  phone: z
    .string()
    .trim()
    .max(30)
    .optional()
    .refine(
      (value) => !value || /^[+\d][\d\s()-]{5,}$/.test(value),
      'Enter a valid mobile number.',
    ),
  primaryBranchId: z.union([z.literal(''), z.uuid('Choose a branch.')]).optional(),
  /** Role ids to grant organization-wide. At least one is required. */
  roleIds: z.union([z.string(), z.array(z.string())]).optional(),
  requestKey: z.string().optional(),
});

const createUserSchema = baseUserSchema.extend({
  employeeId: z.union([z.literal(''), z.uuid('Choose an employee.')]).optional(),
  password: passwordSchema,
});

/** Form fields arrive as one value or several; roles are always a list. */
function roleIdList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((id) => id.trim()).filter(Boolean))];
}

// ─── Reading ────────────────────────────────────────────────────────────────

const listSelect = {
  id: true,
  fullName: true,
  email: true,
  phone: true,
  isActive: true,
  lastLoginAt: true,
  createdAt: true,
  primaryBranch: { select: { id: true, name: true } },
  employee: {
    select: { id: true, employeeCode: true, firstName: true, lastName: true, jobTitle: true },
  },
  userRoles: {
    where: ACTIVE_GRANT,
    select: {
      id: true,
      branchId: true,
      role: { select: { id: true, name: true, isSystem: true } },
    },
  },
} satisfies Prisma.UserSelect;

function shape(row: Prisma.UserGetPayload<{ select: typeof listSelect }>) {
  return {
    ...row,
    employeeName: row.employee ? `${row.employee.firstName} ${row.employee.lastName}` : null,
    roles: row.userRoles.map((grant) => ({
      id: grant.role.id,
      name: grant.role.name,
      isSystem: grant.role.isSystem,
      branchId: grant.branchId,
    })),
  };
}

export interface UserFilters {
  q?: string;
  status?: 'active' | 'inactive' | 'all';
  roleId?: string;
  branchId?: string;
  page?: string | number;
}

/**
 * The user list, newest sign-ins first. One query for the page and one for
 * the count — roles, branch and employee come back as joins on the same
 * read, so the list never grows a query per row.
 */
export async function listUsers(user: AuthenticatedUser, filters: UserFilters = {}) {
  requirePermission(user, 'user.view');

  const q = (filters.q ?? '').trim();
  const status = filters.status ?? 'active';
  const page = Math.max(1, Number(filters.page) || 1);
  const take = Math.min(PAGE_SIZE, MAX_PAGE_SIZE);

  const where: Prisma.UserWhereInput = {
    organizationId: user.organizationId,
    ...(status === 'all' ? {} : { isActive: status === 'active' }),
    ...(filters.branchId ? { primaryBranchId: filters.branchId } : {}),
    ...(filters.roleId ? { userRoles: { some: { ...ACTIVE_GRANT, roleId: filters.roleId } } } : {}),
    ...(q
      ? {
          OR: [
            { fullName: { contains: q, mode: 'insensitive' } },
            { email: { contains: q, mode: 'insensitive' } },
            { phone: { contains: q } },
            { employee: { employeeCode: { contains: q, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: listSelect,
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      skip: (page - 1) * take,
      take,
    }),
    prisma.user.count({ where }),
  ]);

  return {
    users: rows.map(shape),
    total,
    page,
    pageSize: take,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export type UserRow = Awaited<ReturnType<typeof listUsers>>['users'][number];

/** The filter choices and the pickers on the create/edit forms. */
export async function getAccessOptions(user: AuthenticatedUser, forUserId?: string) {
  requirePermission(user, 'user.view');
  const [roles, branches, employees] = await Promise.all([
    prisma.role.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, description: true, isSystem: true },
      orderBy: { name: 'asc' },
    }),
    prisma.branch.findMany({
      where: { organizationId: user.organizationId },
      select: { id: true, name: true, code: true },
      orderBy: { name: 'asc' },
    }),
    // Only employees without a login — one employee, one account. The
    // employee already linked to the user being edited stays selectable.
    prisma.employee.findMany({
      where: {
        organizationId: user.organizationId,
        isActive: true,
        OR: [{ userId: null }, ...(forUserId ? [{ userId: forUserId }] : [])],
      },
      select: {
        id: true,
        employeeCode: true,
        firstName: true,
        lastName: true,
        jobTitle: true,
        branchId: true,
      },
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: 500,
    }),
  ]);
  return { roles, branches, employees };
}

/** One user, with the access their roles give them and what they have done. */
export async function getUserDetail(user: AuthenticatedUser, userId: string) {
  requirePermission(user, 'user.view');
  const row = await prisma.user.findFirst({
    where: { id: userId, organizationId: user.organizationId },
    select: {
      ...listSelect,
      userRoles: {
        where: ACTIVE_GRANT,
        select: {
          id: true,
          branchId: true,
          assignedAt: true,
          assignedBy: { select: { fullName: true } },
          branch: { select: { name: true } },
          role: {
            select: {
              id: true,
              name: true,
              isSystem: true,
              description: true,
              rolePermissions: { select: { permission: { select: { code: true } } } },
            },
          },
        },
      },
    },
  });
  if (!row) throw new NotFoundError('user');

  // What this person can actually do: the union of their live grants.
  const permissions = new Set<string>();
  for (const grant of row.userRoles) {
    for (const rp of grant.role.rolePermissions) permissions.add(rp.permission.code);
  }

  const activity = await prisma.auditLog.findMany({
    where: { organizationId: user.organizationId, actorUserId: userId },
    select: { id: true, action: true, entityType: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });

  return {
    ...shape({
      ...row,
      userRoles: row.userRoles.map((g) => ({ id: g.id, branchId: g.branchId, role: g.role })),
    }),
    grants: row.userRoles.map((grant) => ({
      id: grant.id,
      roleName: grant.role.name,
      description: grant.role.description,
      isSystem: grant.role.isSystem,
      scope: grant.branch?.name ?? null,
      assignedAt: grant.assignedAt,
      assignedBy: grant.assignedBy?.fullName ?? null,
    })),
    permissions: [...permissions].sort(),
    activity,
  };
}

export type UserDetail = Awaited<ReturnType<typeof getUserDetail>>;

// ─── Lockout protection ─────────────────────────────────────────────────────

/**
 * Active users in this organization who can still manage access, ignoring
 * one user (the one about to change). Used to refuse any change that would
 * leave the workshop with nobody able to let anyone back in.
 */
async function otherAdminCount(
  tx: Prisma.TransactionClient,
  organizationId: string,
  exceptUserId: string,
) {
  return tx.user.count({
    where: {
      organizationId,
      isActive: true,
      id: { not: exceptUserId },
      userRoles: {
        some: {
          ...ACTIVE_GRANT,
          role: { rolePermissions: { some: { permission: { code: 'user.manage' } } } },
        },
      },
    },
  });
}

async function refuseIfLastAdmin(
  tx: Prisma.TransactionClient,
  organizationId: string,
  userId: string,
  what: string,
) {
  const holdsManage = await tx.user.count({
    where: {
      id: userId,
      userRoles: {
        some: {
          ...ACTIVE_GRANT,
          role: { rolePermissions: { some: { permission: { code: 'user.manage' } } } },
        },
      },
    },
  });
  if (holdsManage === 0) return;
  if ((await otherAdminCount(tx, organizationId, userId)) === 0) {
    throw new DomainError(
      `This is the only active account that can manage access. ${what} would leave the workshop locked out. Give someone else that role first.`,
    );
  }
}

/** Roles must be this organization's, and at least one must be chosen. */
async function resolveRoles(
  tx: Prisma.TransactionClient,
  organizationId: string,
  roleIds: string[],
) {
  if (roleIds.length === 0) throw new DomainError('Choose at least one role.', 'roleIds');
  const roles = await tx.role.findMany({
    where: { id: { in: roleIds }, organizationId },
    select: { id: true, name: true },
  });
  if (roles.length !== roleIds.length) {
    // A role from another workshop is not reported as "another workshop's".
    throw new DomainError('Choose a role from the list.', 'roleIds');
  }
  return roles;
}

async function resolveBranch(
  tx: Prisma.TransactionClient,
  organizationId: string,
  branchId: string | null,
) {
  if (!branchId) return null;
  const branch = await tx.branch.findFirst({
    where: { id: branchId, organizationId },
    select: { id: true },
  });
  if (!branch) throw new DomainError('Choose a branch from the list.', 'primaryBranchId');
  return branch.id;
}

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Creates a login, optionally attached to an employee record. The password
 * is hashed before it reaches the database and never appears in the audit
 * trail — only the fact that an account was created, and by whom.
 */
export async function createUser(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(createUserSchema, rawInput);
  requirePermission(user, 'user.manage');

  const email = input.email.trim().toLowerCase();
  const roleIds = roleIdList(input.roleIds);
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'user.create');
    const roles = await resolveRoles(tx, user.organizationId, roleIds);
    const primaryBranchId = await resolveBranch(
      tx,
      user.organizationId,
      emptyToNull(input.primaryBranchId),
    );

    const taken = await tx.user.findFirst({
      where: { organizationId: user.organizationId, email },
      select: { id: true },
    });
    if (taken) throw new DomainError('Someone already signs in with that email address.', 'email');

    const employeeId = emptyToNull(input.employeeId);
    let employee = null;
    if (employeeId) {
      employee = await tx.employee.findFirst({
        where: { id: employeeId, organizationId: user.organizationId },
        select: { id: true, userId: true, firstName: true, lastName: true, branchId: true },
      });
      if (!employee) throw new DomainError('Choose an employee from the list.', 'employeeId');
      if (employee.userId) {
        throw new DomainError(
          'That employee already has a login. Open their existing account instead of creating a second one.',
          'employeeId',
        );
      }
    }

    const created = await tx.user.create({
      data: {
        organizationId: user.organizationId,
        primaryBranchId: primaryBranchId ?? employee?.branchId ?? null,
        email,
        fullName: input.fullName.replace(/\s+/g, ' '),
        phone: input.phone ? normalizePhone(input.phone) : null,
        passwordHash,
        isActive: true,
      },
      select: { id: true, email: true, fullName: true, primaryBranchId: true },
    });

    if (employee) {
      await tx.employee.update({ where: { id: employee.id }, data: { userId: created.id } });
    }

    await tx.userRole.createMany({
      data: roles.map((role) => ({
        organizationId: user.organizationId,
        userId: created.id,
        roleId: role.id,
        assignedByUserId: user.id,
      })),
    });

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: created.primaryBranchId,
      actorUserId: user.id,
      action: 'user.created',
      entityType: 'User',
      entityId: created.id,
      afterData: {
        fullName: created.fullName,
        email: created.email,
        roles: roles.map((role) => role.name),
        employeeId: employee?.id ?? null,
      },
    });
    await settleRequestKey(tx, user, rawInput, created.id);
    return created;
  });
}

/** Details and role grants. Who did what in the past is never rewritten. */
export async function updateUser(user: AuthenticatedUser, userId: string, rawInput: unknown) {
  const input = parseInput(baseUserSchema, rawInput);
  requirePermission(user, 'user.manage');

  const email = input.email.trim().toLowerCase();
  const roleIds = roleIdList(input.roleIds);

  return prisma.$transaction(async (tx) => {
    const before = await tx.user.findFirst({
      where: { id: userId, organizationId: user.organizationId },
      select: {
        id: true,
        fullName: true,
        email: true,
        phone: true,
        primaryBranchId: true,
        userRoles: {
          where: ACTIVE_GRANT,
          select: { id: true, roleId: true, role: { select: { name: true } } },
        },
      },
    });
    if (!before) throw new NotFoundError('user');

    const roles = await resolveRoles(tx, user.organizationId, roleIds);
    const primaryBranchId = await resolveBranch(
      tx,
      user.organizationId,
      emptyToNull(input.primaryBranchId),
    );

    const held = new Set(before.userRoles.map((grant) => grant.roleId));
    const wanted = new Set(roles.map((role) => role.id));
    const rolesChanged = held.size !== wanted.size || [...wanted].some((id) => !held.has(id));

    if (rolesChanged && userId === user.id) {
      throw new DomainError(
        'You can’t change your own roles. Ask another administrator to do it.',
        'roleIds',
      );
    }
    if (rolesChanged) {
      const losingManage = [...held].some((id) => !wanted.has(id));
      if (losingManage)
        await refuseIfLastAdmin(tx, user.organizationId, userId, 'Changing its roles');
    }

    if (email !== before.email) {
      const taken = await tx.user.findFirst({
        where: { organizationId: user.organizationId, email, id: { not: userId } },
        select: { id: true },
      });
      if (taken)
        throw new DomainError('Someone already signs in with that email address.', 'email');
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        fullName: input.fullName.replace(/\s+/g, ' '),
        email,
        phone: input.phone ? normalizePhone(input.phone) : null,
        primaryBranchId,
      },
      select: { id: true, fullName: true, email: true, phone: true, primaryBranchId: true },
    });

    if (rolesChanged) {
      // Revoked, never deleted: the grant stays on record with who ended it.
      await tx.userRole.updateMany({
        where: { userId, ...ACTIVE_GRANT, roleId: { notIn: [...wanted] } },
        data: { revokedAt: new Date(), revokedByUserId: user.id },
      });
      const toAdd = [...wanted].filter((id) => !held.has(id));
      if (toAdd.length > 0) {
        await tx.userRole.createMany({
          data: toAdd.map((roleId) => ({
            organizationId: user.organizationId,
            userId,
            roleId,
            assignedByUserId: user.id,
          })),
        });
      }
    }

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: updated.primaryBranchId,
      actorUserId: user.id,
      action: rolesChanged ? 'user.roles_changed' : 'user.updated',
      entityType: 'User',
      entityId: userId,
      beforeData: {
        fullName: before.fullName,
        email: before.email,
        phone: before.phone,
        primaryBranchId: before.primaryBranchId,
        roles: before.userRoles.map((grant) => grant.role.name),
      },
      afterData: {
        fullName: updated.fullName,
        email: updated.email,
        phone: updated.phone,
        primaryBranchId: updated.primaryBranchId,
        roles: roles.map((role) => role.name),
      },
    });
    return updated;
  });
}

const activeSchema = z.object({
  isActive: z.enum(['true', 'false'], { error: 'Say whether the account should be active.' }),
  reason: z.string().trim().max(300).optional(),
});

/**
 * Turns an account on or off. Deactivating takes effect immediately —
 * `lib/auth/session` refuses a session whose user is inactive, so any
 * signed-in device stops working on its next request.
 */
export async function setUserActive(user: AuthenticatedUser, userId: string, rawInput: unknown) {
  const input = parseInput(activeSchema, rawInput);
  requirePermission(user, 'user.manage');
  const isActive = input.isActive === 'true';

  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findFirst({
      where: { id: userId, organizationId: user.organizationId },
      select: { id: true, isActive: true, fullName: true, primaryBranchId: true },
    });
    if (!target) throw new NotFoundError('user');
    if (target.isActive === isActive) return target;

    if (!isActive) {
      if (userId === user.id) {
        throw new DomainError('You can’t deactivate your own account.');
      }
      await refuseIfLastAdmin(tx, user.organizationId, userId, 'Deactivating it');
    }

    const updated = await tx.user.update({
      where: { id: userId },
      data: { isActive },
      select: { id: true, isActive: true, fullName: true, primaryBranchId: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: updated.primaryBranchId,
      actorUserId: user.id,
      action: isActive ? 'user.activated' : 'user.deactivated',
      entityType: 'User',
      entityId: userId,
      beforeData: { isActive: target.isActive },
      afterData: { isActive },
      metadata: { reason: emptyToNull(input.reason) },
    });
    return updated;
  });
}

const resetSchema = z.object({ password: passwordSchema });

/**
 * Sets a new password for someone who cannot sign in. Existing sessions are
 * revoked, so a password handed out to the wrong person does not leave an
 * old device signed in. The password is never written to the audit trail.
 */
export async function resetUserPassword(
  user: AuthenticatedUser,
  userId: string,
  rawInput: unknown,
) {
  const input = parseInput(resetSchema, rawInput);
  requirePermission(user, 'user.manage');
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    const target = await tx.user.findFirst({
      where: { id: userId, organizationId: user.organizationId },
      select: { id: true, fullName: true, primaryBranchId: true },
    });
    if (!target) throw new NotFoundError('user');

    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    const { count } = await tx.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: target.primaryBranchId,
      actorUserId: user.id,
      action: 'user.password_reset',
      entityType: 'User',
      entityId: userId,
      metadata: { sessionsRevoked: count },
    });
    return target;
  });
}
