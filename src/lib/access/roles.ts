import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { assertCanEditRolePermissions } from '@/lib/access/escalation';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import {
  ACTION_LABELS,
  PERMISSION_ACTIONS,
  PERMISSION_CODES,
  PERMISSION_MODULES,
  ROLE_PRESETS,
  permissionCode,
  permissionLabel,
} from '@/lib/auth/permission-catalog';

/*
 * Roles: the named bundles of permissions this workshop grants.
 *
 * A role carries permission codes; a user holds roles; a session resolves
 * the union. That is the whole model and this module does not add to it —
 * it only lets someone with `role.edit` edit the bundles from a screen.
 *
 * System roles (`isSystem`) are read-only here. The seed marks Owner as one
 * — it always holds every permission — because a workshop that can edit its
 * own full-access role can remove its own last way in; the lockout guard
 * below is the second line of defence for every other role.
 */

const ACTIVE_GRANT = { revokedAt: null } as const;

const roleSchema = z.object({
  name: z
    .string({ error: 'Enter a name for the role.' })
    .trim()
    .min(2, 'Enter a name for the role.')
    .max(60),
  description: z.string().trim().max(300).optional(),
  requestKey: z.string().optional(),
});

const newRoleSchema = roleSchema.extend({
  preset: z.string().trim().optional(),
});

/**
 * A module's View is implied by anything else ticked on it: someone who may
 * edit invoices must be able to open them. The screen ticks it for the
 * admin; this makes the rule hold whatever the browser sent.
 */
export function withImpliedView(codes: Iterable<string>): string[] {
  const set = new Set(codes);
  for (const code of [...set]) {
    const view = `${code.split('.')[0]}.view`;
    if (!code.endsWith('.view') && PERMISSION_CODES.includes(view)) set.add(view);
  }
  return PERMISSION_CODES.filter((code) => set.has(code));
}

const permissionsSchema = z.object({
  permissions: z.union([z.string(), z.array(z.string())]).optional(),
  requestKey: z.string().optional(),
});

function codeList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list.map((code) => code.trim()).filter(Boolean))];
}

// ─── Reading ────────────────────────────────────────────────────────────────

/**
 * Every role with how many permissions it carries and how many people hold
 * it. Both counts come back as aggregates on the same read, so the list
 * costs one query however many roles there are.
 */
export async function listRoles(user: AuthenticatedUser) {
  requirePermission(user, 'role.view');
  const roles = await prisma.role.findMany({
    where: { organizationId: user.organizationId },
    select: {
      id: true,
      name: true,
      description: true,
      isSystem: true,
      _count: {
        select: {
          rolePermissions: true,
          userRoles: { where: { ...ACTIVE_GRANT, user: { isActive: true } } },
        },
      },
    },
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
  });
  return roles.map((role) => ({
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissionCount: role._count.rolePermissions,
    userCount: role._count.userRoles,
  }));
}

export type RoleRow = Awaited<ReturnType<typeof listRoles>>[number];

/**
 * One role: which permissions it carries, laid out by module so it reads as
 * "what this person can do", and who currently holds it.
 */
export async function getRoleDetail(user: AuthenticatedUser, roleId: string) {
  requirePermission(user, 'role.view');
  const role = await prisma.role.findFirst({
    where: { id: roleId, organizationId: user.organizationId },
    select: {
      id: true,
      name: true,
      description: true,
      isSystem: true,
      updatedAt: true,
      rolePermissions: { select: { permission: { select: { code: true } } } },
      userRoles: {
        where: ACTIVE_GRANT,
        select: {
          user: { select: { id: true, fullName: true, email: true, isActive: true } },
        },
        orderBy: { assignedAt: 'asc' },
        take: 100,
      },
    },
  });
  if (!role) throw new NotFoundError('role');

  const held = new Set(role.rolePermissions.map((row) => row.permission.code));
  // One row per module, one cell per action; a cell is null where the
  // action doesn't exist for that module.
  const modules = PERMISSION_MODULES.map((module) => ({
    key: module.key,
    label: module.label,
    description: module.description,
    cells: PERMISSION_ACTIONS.map((action) => {
      const detail = module.actions[action];
      if (!detail) return null;
      const code = permissionCode(module.key, action);
      return { action, label: ACTION_LABELS[action], code, detail, granted: held.has(code) };
    }),
  }));

  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    updatedAt: role.updatedAt,
    granted: [...held],
    modules,
    members: role.userRoles.map((grant) => grant.user),
  };
}

export type RoleDetail = Awaited<ReturnType<typeof getRoleDetail>>;

// ─── Writing ────────────────────────────────────────────────────────────────

/**
 * Creates a role, optionally starting from a preset's ticks. The admin
 * adjusts them on the role's grid afterwards.
 */
export async function createRole(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(newRoleSchema, rawInput);
  requirePermission(user, 'role.create');
  const name = input.name.replace(/\s+/g, ' ');
  const presetKey = emptyToNull(input.preset);
  const preset = presetKey ? ROLE_PRESETS.find((option) => option.key === presetKey) : null;
  if (presetKey && !preset)
    throw new DomainError('Choose a starting point from the list.', 'preset');
  const codes = withImpliedView(preset?.codes ?? []);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'role.create');
    const taken = await tx.role.findFirst({
      where: { organizationId: user.organizationId, name },
      select: { id: true },
    });
    if (taken) throw new DomainError('A role with that name already exists.', 'name');

    const role = await tx.role.create({
      data: {
        organizationId: user.organizationId,
        name,
        description: emptyToNull(input.description),
        isSystem: false,
      },
      select: { id: true, name: true },
    });
    if (codes.length > 0) {
      const permissions = await tx.permission.findMany({
        where: { code: { in: codes } },
        select: { id: true },
      });
      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({
          organizationId: user.organizationId,
          roleId: role.id,
          permissionId: permission.id,
        })),
      });
    }
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'role.created',
      entityType: 'Role',
      entityId: role.id,
      afterData: {
        name: role.name,
        description: emptyToNull(input.description),
        preset: preset?.label ?? null,
        permissions: codes,
      },
    });
    await settleRequestKey(tx, user, rawInput, role.id);
    return role;
  });
}

/** Renames a role or changes its description. System roles keep their name. */
export async function updateRole(user: AuthenticatedUser, roleId: string, rawInput: unknown) {
  const input = parseInput(roleSchema, rawInput);
  requirePermission(user, 'role.edit');
  const name = input.name.replace(/\s+/g, ' ');

  return prisma.$transaction(async (tx) => {
    const before = await tx.role.findFirst({
      where: { id: roleId, organizationId: user.organizationId },
      select: { id: true, name: true, description: true, isSystem: true },
    });
    if (!before) throw new NotFoundError('role');
    if (before.isSystem && name !== before.name) {
      throw new DomainError('A built-in role can’t be renamed.', 'name');
    }
    if (name !== before.name) {
      const taken = await tx.role.findFirst({
        where: { organizationId: user.organizationId, name, id: { not: roleId } },
        select: { id: true },
      });
      if (taken) throw new DomainError('A role with that name already exists.', 'name');
    }

    const role = await tx.role.update({
      where: { id: roleId },
      data: { name, description: emptyToNull(input.description) },
      select: { id: true, name: true, description: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'role.updated',
      entityType: 'Role',
      entityId: roleId,
      beforeData: { name: before.name, description: before.description },
      afterData: { name: role.name, description: role.description },
    });
    return role;
  });
}

/**
 * Replaces the permissions a role carries. Refused if it would leave the
 * workshop with no active user able to manage access — the same guard that
 * protects the last administrator from being deactivated.
 */
export async function updateRolePermissions(
  user: AuthenticatedUser,
  roleId: string,
  rawInput: unknown,
) {
  const input = parseInput(permissionsSchema, rawInput);
  requirePermission(user, 'role.edit');
  const sent = codeList(input.permissions);

  const unknown = sent.filter((code) => !PERMISSION_CODES.includes(code));
  if (unknown.length > 0) {
    throw new DomainError('That permission isn’t one this system has.', 'permissions');
  }
  const codes = withImpliedView(sent);

  return prisma.$transaction(async (tx) => {
    const role = await tx.role.findFirst({
      where: { id: roleId, organizationId: user.organizationId },
      select: {
        id: true,
        name: true,
        isSystem: true,
        rolePermissions: { select: { permissionId: true, permission: { select: { code: true } } } },
      },
    });
    if (!role) throw new NotFoundError('role');
    if (role.isSystem) {
      throw new DomainError(
        'This built-in role always has every permission, so its ticks can’t be changed. Create a role of your own to grant something different.',
      );
    }

    const held = new Set(role.rolePermissions.map((row) => row.permission.code));
    const wanted = new Set(codes);
    const added = codes.filter((code) => !held.has(code));
    const removed = PERMISSION_CODES.filter((code) => held.has(code) && !wanted.has(code)).concat(
      // A retired code still on the role (never after `db:permissions`).
      [...held].filter((code) => !PERMISSION_CODES.includes(code)),
    );
    if (added.length === 0 && removed.length === 0) {
      return { id: role.id, changed: false, added, removed };
    }
    await assertCanEditRolePermissions(tx, user, role.id, added);

    // Dropping `user.edit` from this role must not empty the workshop of
    // people who can manage access. Anyone whose only route to it is this
    // role loses it.
    if (held.has('user.edit') && !wanted.has('user.edit')) {
      const remaining = await tx.user.count({
        where: {
          organizationId: user.organizationId,
          isActive: true,
          userRoles: {
            some: {
              ...ACTIVE_GRANT,
              roleId: { not: roleId },
              role: { rolePermissions: { some: { permission: { code: 'user.edit' } } } },
            },
          },
        },
      });
      if (remaining === 0) {
        throw new DomainError(
          'This is the only role that can manage access. Removing it would leave the workshop locked out.',
        );
      }
    }

    const permissions = await tx.permission.findMany({
      where: { code: { in: codes } },
      select: { id: true, code: true },
    });
    await tx.rolePermission.deleteMany({ where: { roleId } });
    if (permissions.length > 0) {
      await tx.rolePermission.createMany({
        data: permissions.map((permission) => ({
          organizationId: user.organizationId,
          roleId,
          permissionId: permission.id,
        })),
      });
    }

    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'role.permissions_changed',
      entityType: 'Role',
      entityId: roleId,
      beforeData: { name: role.name, permissions: [...held].sort() },
      afterData: { name: role.name, permissions: [...wanted].sort() },
      metadata: {
        added: added.map(permissionLabel),
        removed: removed.map(permissionLabel),
      },
    });
    return { id: role.id, changed: true, added, removed };
  });
}
