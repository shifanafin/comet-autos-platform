/**
 * Integration tests for users, roles and access.
 *
 * The rules that matter here are the ones that stop a workshop hurting
 * itself: one employee never gets two logins, nobody removes their own
 * access by accident, and no change may leave the business with nobody able
 * to let anyone back in.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { verifyPassword } from '@/lib/auth/password';
import { PERMISSION_CODES } from '@/lib/auth/permission-catalog';
import {
  createUser,
  getAccessOptions,
  getUserDetail,
  listUsers,
  resetUserPassword,
  setUserActive,
  updateUser,
} from '@/lib/access/users';
import {
  createRole,
  getRoleDetail,
  listRoles,
  updateRole,
  updateRolePermissions,
} from '@/lib/access/roles';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

/** Emails are stored lower-cased, so build the test ones that way too. */
const R = RUN.toLowerCase();

let a: TestOrg;
let b: TestOrg;

/** Real Role rows, since access management reads grants from the database. */
async function makeRole(organizationId: string, name: string, codes: string[], isSystem = false) {
  const role = await prisma.role.create({
    data: { organizationId, name, isSystem, description: `${name} (test)` },
    select: { id: true },
  });
  const permissions = await prisma.permission.findMany({
    where: { code: { in: codes } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({
      organizationId,
      roleId: role.id,
      permissionId: permission.id,
    })),
  });
  return role.id;
}

let adminRoleA: string;
let techRoleA: string;
let adminRoleB: string;

const account = (over: Record<string, unknown> = {}) => ({
  fullName: 'Nadia Hassan',
  email: `nadia-${R}@test.local`,
  phone: '050 444 5566',
  password: 'Workshop2026x',
  roleIds: [techRoleA],
  ...over,
});

before(async () => {
  a = await createTestOrg('AccessA');
  b = await createTestOrg('AccessB');

  adminRoleA = await makeRole(a.organizationId, 'Administrator', PERMISSION_CODES);
  techRoleA = await makeRole(a.organizationId, 'Technician', [
    'job_card.view',
    'job_card.edit',
    'customer.view',
    'vehicle.view',
  ]);
  adminRoleB = await makeRole(b.organizationId, 'Administrator', PERMISSION_CODES);

  // The caller must really hold the admin role, or the "last administrator"
  // guard has nothing to count.
  await prisma.userRole.create({
    data: { organizationId: a.organizationId, userId: a.owner.id, roleId: adminRoleA },
  });
  await prisma.userRole.create({
    data: { organizationId: b.organizationId, userId: b.owner.id, roleId: adminRoleB },
  });
});

after(async () => {
  await prisma.$disconnect();
});

describe('users', () => {
  test('an authorized admin can list users, and a viewer cannot', async () => {
    const page = await listUsers(a.owner, { status: 'all' });
    assert.ok(page.total >= 2, 'the test organization has staff');
    assert.ok(page.users.every((row) => Array.isArray(row.roles)));
    assert.equal(page.pageSize, 25);

    await assert.rejects(listUsers(a.viewer), (error: unknown) => error instanceof AuthError);
    await assert.rejects(
      getAccessOptions(a.viewer),
      (error: unknown) => error instanceof AuthError,
    );
  });

  test('viewing is not managing', async () => {
    const readOnly = { ...a.owner, orgWidePermissions: new Set(['user.view']) };
    assert.ok(await listUsers(readOnly));
    await assert.rejects(
      createUser(readOnly, account()),
      (error: unknown) => error instanceof AuthError,
      'user.view alone cannot create an account',
    );
    await assert.rejects(
      createRole(readOnly, { name: 'Nope' }),
      (error: unknown) => error instanceof AuthError,
    );
  });

  test('a login is created, hashed, roled and audited', async () => {
    const created = await createUser(a.owner, account({ requestKey: `access-create-${RUN}` }));
    assert.equal(created.email, `nadia-${R}@test.local`);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: created.id },
      select: { passwordHash: true, isActive: true, phone: true },
    });
    assert.notEqual(row.passwordHash, 'Workshop2026x', 'the password is never stored as typed');
    assert.ok(await verifyPassword('Workshop2026x', row.passwordHash));
    assert.equal(row.isActive, true);

    const detail = await getUserDetail(a.owner, created.id);
    assert.deepEqual(
      detail.roles.map((role) => role.name),
      ['Technician'],
    );
    assert.ok(detail.permissions.includes('job_card.edit'));
    assert.ok(!detail.permissions.includes('payment.create'), 'only what the role carries');

    const audit = await prisma.auditLog.findFirst({
      where: { entityId: created.id, action: 'user.created' },
      select: { afterData: true },
    });
    assert.ok(audit, 'the new account is audited');
    assert.ok(
      !JSON.stringify(audit.afterData).includes('Workshop2026x'),
      'and the password is not in the audit trail',
    );
  });

  test('the same email cannot sign in twice', async () => {
    await expectDomainError(
      createUser(a.owner, account({ requestKey: `access-dup-email-${RUN}` })),
      /already signs in with that email/i,
    );
  });

  test('one employee, one login', async () => {
    const employee = await prisma.employee.findFirstOrThrow({
      where: { organizationId: a.organizationId, userId: null },
      select: { id: true },
    });
    const first = await createUser(
      a.owner,
      account({
        fullName: 'Linked Tech',
        email: `linked-${R}@test.local`,
        employeeId: employee.id,
        requestKey: `access-link-${RUN}`,
      }),
    );
    const linked = await prisma.employee.findUniqueOrThrow({
      where: { id: employee.id },
      select: { userId: true },
    });
    assert.equal(linked.userId, first.id, 'the employee is linked to the account');

    await expectDomainError(
      createUser(
        a.owner,
        account({
          fullName: 'Second Account',
          email: `second-${R}@test.local`,
          employeeId: employee.id,
          requestKey: `access-link-2-${RUN}`,
        }),
      ),
      /already has a login/i,
    );

    // And an employee with a login is not offered for linking again.
    const options = await getAccessOptions(a.owner);
    assert.ok(
      !options.employees.some((candidate) => candidate.id === employee.id),
      'the picker only offers employees without an account',
    );
  });

  test('a role from another workshop cannot be granted', async () => {
    await expectDomainError(
      createUser(
        a.owner,
        account({
          fullName: 'Cross Org',
          email: `cross-${R}@test.local`,
          roleIds: [adminRoleB],
          requestKey: `access-cross-${RUN}`,
        }),
      ),
      /role from the list/i,
    );
    await expectDomainError(
      createUser(
        a.owner,
        account({
          fullName: 'No Role',
          email: `norole-${R}@test.local`,
          roleIds: [],
          requestKey: `access-norole-${RUN}`,
        }),
      ),
      /at least one role/i,
    );
  });

  test('a branch from another workshop cannot be assigned', async () => {
    await expectDomainError(
      createUser(
        a.owner,
        account({
          fullName: 'Cross Branch',
          email: `crossbranch-${R}@test.local`,
          primaryBranchId: b.branchId,
          requestKey: `access-crossbranch-${RUN}`,
        }),
      ),
      /branch from the list/i,
    );
  });

  test('one workshop cannot read or change another’s users', async () => {
    const [mine] = (await listUsers(a.owner, { status: 'all' })).users;
    await assert.rejects(
      getUserDetail(b.owner, mine.id),
      (error: unknown) => error instanceof NotFoundError,
      'another workshop gets "not found", never the record',
    );
    await assert.rejects(
      setUserActive(b.owner, mine.id, { isActive: 'false' }),
      (error: unknown) => error instanceof NotFoundError,
    );
    await assert.rejects(
      updateUser(b.owner, mine.id, {
        fullName: 'Hijacked',
        email: mine.email,
        roleIds: [adminRoleB],
      }),
      (error: unknown) => error instanceof NotFoundError,
    );
    // And the list never crosses the boundary either.
    const theirs = await listUsers(b.owner, { status: 'all' });
    assert.ok(
      theirs.users.every((row) => row.id !== mine.id),
      'nobody from another workshop appears in the list',
    );
  });

  test('a role change is recorded as a revoke and a new grant', async () => {
    const target = await prisma.user.findFirstOrThrow({
      where: { organizationId: a.organizationId, email: `nadia-${R}@test.local` },
      select: { id: true, email: true },
    });
    await updateUser(a.owner, target.id, {
      fullName: 'Nadia Hassan',
      email: target.email,
      roleIds: [adminRoleA],
    });

    const grants = await prisma.userRole.findMany({
      where: { userId: target.id },
      select: { roleId: true, revokedAt: true, revokedByUserId: true, assignedByUserId: true },
    });
    const revoked = grants.find((grant) => grant.roleId === techRoleA);
    assert.ok(revoked?.revokedAt, 'the old grant is kept, marked revoked');
    assert.equal(revoked.revokedByUserId, a.owner.id);
    const added = grants.find((grant) => grant.roleId === adminRoleA);
    assert.ok(added && !added.revokedAt);
    assert.equal(added.assignedByUserId, a.owner.id, 'and who granted it is on record');

    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: target.id, action: 'user.roles_changed' },
      }),
    );
    const detail = await getUserDetail(a.owner, target.id);
    assert.ok(detail.permissions.includes('payment.create'), 'the new role takes effect');
  });

  test('nobody changes their own roles or deactivates themselves', async () => {
    await expectDomainError(
      updateUser(a.owner, a.owner.id, {
        fullName: a.owner.fullName,
        email: a.owner.email,
        roleIds: [techRoleA],
      }),
      /own roles/i,
    );
    await expectDomainError(
      setUserActive(a.owner, a.owner.id, { isActive: 'false' }),
      /own account/i,
    );
  });

  test('deactivating and reactivating is audited, and ends the session', async () => {
    const target = await prisma.user.findFirstOrThrow({
      where: { organizationId: a.organizationId, email: `linked-${R}@test.local` },
      select: { id: true },
    });
    await setUserActive(a.owner, target.id, { isActive: 'false', reason: 'Left the workshop' });
    assert.equal(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: target.id },
          select: { isActive: true },
        })
      ).isActive,
      false,
    );
    const off = await prisma.auditLog.findFirst({
      where: { entityId: target.id, action: 'user.deactivated' },
      select: { metadata: true },
    });
    assert.match(JSON.stringify(off?.metadata), /Left the workshop/);

    // An inactive account is excluded from the default list but findable.
    const active = await listUsers(a.owner, { status: 'active' });
    assert.ok(!active.users.some((row) => row.id === target.id));
    const inactive = await listUsers(a.owner, { status: 'inactive' });
    assert.ok(inactive.users.some((row) => row.id === target.id));

    await setUserActive(a.owner, target.id, { isActive: 'true' });
    assert.ok(
      await prisma.auditLog.findFirst({ where: { entityId: target.id, action: 'user.activated' } }),
    );
  });

  test('the workshop cannot be left with nobody able to manage access', async () => {
    // The owner's admin grant is the only live route to user.manage once
    // Nadia's is revoked, so both ways of removing it must be refused.
    await prisma.userRole.updateMany({
      where: { userId: { not: a.owner.id }, roleId: adminRoleA, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    const secondAdmin = await prisma.user.create({
      data: {
        organizationId: a.organizationId,
        email: `lockout-${R}@test.local`,
        fullName: 'Lockout Probe',
        passwordHash: 'x',
        isActive: true,
      },
      select: { id: true },
    });
    await prisma.userRole.create({
      data: { organizationId: a.organizationId, userId: secondAdmin.id, roleId: adminRoleA },
    });
    // Two admins: removing one is allowed.
    await setUserActive(a.owner, secondAdmin.id, { isActive: 'false' });

    // One admin left (the owner). Another administrator tries to remove it.
    const deputy = { ...a.owner, id: secondAdmin.id };
    await expectDomainError(
      setUserActive(deputy, a.owner.id, { isActive: 'false' }),
      /only active account that can manage access/i,
    );
    await expectDomainError(
      updateUser(deputy, a.owner.id, {
        fullName: a.owner.fullName,
        email: a.owner.email,
        roleIds: [techRoleA],
      }),
      /only active account that can manage access/i,
    );

    const still = await prisma.user.findUniqueOrThrow({
      where: { id: a.owner.id },
      select: { isActive: true },
    });
    assert.equal(still.isActive, true, 'and the account is untouched');
  });

  test('a password reset re-hashes and ends every session', async () => {
    const target = await prisma.user.findFirstOrThrow({
      where: { organizationId: a.organizationId, email: `nadia-${R}@test.local` },
      select: { id: true },
    });
    await prisma.session.create({
      data: {
        organizationId: a.organizationId,
        userId: target.id,
        tokenHash: `reset-probe-${RUN}`,
        expiresAt: new Date(Date.now() + 864e5),
      },
    });
    await resetUserPassword(a.owner, target.id, { password: 'BrandNew2026x' });

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: target.id },
      select: { passwordHash: true },
    });
    assert.ok(await verifyPassword('BrandNew2026x', row.passwordHash));
    const live = await prisma.session.count({ where: { userId: target.id, revokedAt: null } });
    assert.equal(live, 0, 'every signed-in device is logged out');
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: target.id, action: 'user.password_reset' },
      select: { afterData: true, metadata: true },
    });
    assert.ok(audit);
    assert.ok(!JSON.stringify(audit).includes('BrandNew2026x'), 'the password is never audited');

    await expectDomainError(
      resetUserPassword(a.owner, target.id, { password: 'short' }),
      /at least 10 characters/i,
    );
  });

  test('the same submission twice creates one account', async () => {
    const input = account({
      fullName: 'Double Submit',
      email: `double-${R}@test.local`,
      requestKey: `access-double-submit-${RUN}`,
    });
    const results = await Promise.allSettled([
      createUser(a.owner, input),
      createUser(a.owner, input),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(
      await prisma.user.count({
        where: { organizationId: a.organizationId, email: `double-${R}@test.local` },
      }),
      1,
    );
  });

  test('search and filters narrow the list without crossing the boundary', async () => {
    const byName = await listUsers(a.owner, { q: 'Double', status: 'all' });
    assert.ok(byName.users.some((row) => row.fullName === 'Double Submit'));
    const byRole = await listUsers(a.owner, { roleId: techRoleA, status: 'all' });
    assert.ok(
      byRole.users.every((row) => row.roles.some((role) => role.id === techRoleA)),
      'the role filter only returns holders of that role',
    );
    const byBranch = await listUsers(a.owner, { branchId: a.branchId, status: 'all' });
    assert.ok(byBranch.users.every((row) => row.primaryBranch?.id === a.branchId));
    const nothing = await listUsers(a.owner, { q: 'no-such-person-anywhere', status: 'all' });
    assert.equal(nothing.total, 0);
    assert.equal(nothing.pageCount, 1, 'an empty list is still one page');
  });
});

describe('roles', () => {
  test('roles list with how many hold them, and what they allow', async () => {
    const roles = await listRoles(a.owner);
    const admin = roles.find((role) => role.id === adminRoleA);
    assert.ok(admin);
    assert.equal(admin.permissionCount, PERMISSION_CODES.length);
    assert.ok(admin.userCount >= 1);

    const detail = await getRoleDetail(a.owner, techRoleA);
    assert.equal(detail.name, 'Technician');
    const cell = (key: string, action: string) =>
      detail.modules.find((module) => module.key === key)?.cells.find((c) => c?.action === action);
    assert.ok(cell('job_card', 'edit')?.granted);
    assert.equal(cell('job_card', 'approve')?.granted, false);
    const jobs = detail.modules.find((module) => module.key === 'job_card');
    assert.equal(jobs?.cells.length, 6, 'one cell per action');
    const vat = detail.modules.find((module) => module.key === 'vat');
    assert.equal(vat?.cells[3], null, 'an action a module doesn’t have is an empty cell');
    const access = detail.modules.find((module) => module.key === 'user');
    assert.ok(access, 'users are shown as their own module');
    assert.equal(access.cells.filter((c) => c?.granted).length, 0);

    await assert.rejects(listRoles(a.viewer), (error: unknown) => error instanceof AuthError);
    await assert.rejects(
      getRoleDetail(b.owner, techRoleA),
      (error: unknown) => error instanceof NotFoundError,
    );
  });

  test('a role is created and its permissions set', async () => {
    const role = await createRole(a.owner, {
      name: `Receptionist ${RUN}`,
      description: 'Front desk',
      requestKey: `role-create-${RUN}`,
    });
    await updateRolePermissions(a.owner, role.id, {
      permissions: ['customer.view', 'customer.create', 'job_card.view'],
    });
    const detail = await getRoleDetail(a.owner, role.id);
    assert.deepEqual(detail.granted.sort(), ['customer.create', 'customer.view', 'job_card.view']);
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: role.id, action: 'role.permissions_changed' },
      }),
    );

    await expectDomainError(
      createRole(a.owner, { name: `Receptionist ${RUN}`, requestKey: `role-dup-${RUN}` }),
      /already exists/i,
    );
    await expectDomainError(
      updateRolePermissions(a.owner, role.id, { permissions: ['not.a.permission'] }),
      /isn’t one this system has/i,
    );
  });

  test('a built-in role is read-only', async () => {
    const systemRole = await makeRole(a.organizationId, `Owner ${RUN}`, PERMISSION_CODES, true);
    await expectDomainError(
      updateRolePermissions(a.owner, systemRole.valueOf(), { permissions: ['customer.view'] }),
      /built-in role/i,
    );
    await expectDomainError(
      updateRole(a.owner, systemRole, { name: `Renamed ${RUN}` }),
      /can’t be renamed/i,
    );
    // Its description can still be kept up to date.
    const kept = await updateRole(a.owner, systemRole, {
      name: `Owner ${RUN}`,
      description: 'Full access.',
    });
    assert.equal(kept.description, 'Full access.');
  });

  test('the last role that can manage access keeps that permission', async () => {
    // adminRoleA is the only live route to user.edit in this workshop.
    const without = PERMISSION_CODES.filter((code) => code !== 'user.edit');
    // Someone holding the role may not edit it at all.
    await expectDomainError(
      updateRolePermissions(a.owner, adminRoleA, { permissions: without }),
      /You hold this role/i,
    );
    // Someone who may edit roles but doesn't hold this one reaches the lockout guard.
    const roleEditor = {
      ...a.owner,
      id: a.viewer.id,
      orgWidePermissions: new Set(['role.view', 'role.edit']),
    };
    await expectDomainError(
      updateRolePermissions(roleEditor, adminRoleA, { permissions: without }),
      /only role that can manage access/i,
    );
    const detail = await getRoleDetail(a.owner, adminRoleA);
    assert.ok(detail.granted.includes('user.edit'), 'and the role is unchanged');
  });

  test('a role from another workshop cannot be edited', async () => {
    await assert.rejects(
      updateRolePermissions(b.owner, techRoleA, { permissions: ['customer.view'] }),
      (error: unknown) => error instanceof NotFoundError,
    );
    await assert.rejects(
      updateRole(b.owner, techRoleA, { name: 'Hijacked' }),
      (error: unknown) => error instanceof NotFoundError,
    );
    const untouched = await getRoleDetail(a.owner, techRoleA);
    assert.equal(untouched.name, 'Technician');
  });
});
