/**
 * Integration tests for designations and employee logins:
 *
 *  - a designation carries a role: a new one started from a preset, or the
 *    existing role of the same name; only someone who may edit employees
 *    creates one;
 *  - an employee left without a code gets the next EMP- code;
 *  - "create a login" makes a login that signs in with the employee code,
 *    whose first password is the code, that must choose its own, and that
 *    holds the designation's role — and it needs a designation;
 *  - moving the employee to another designation moves the login's role;
 *  - a reset puts the password back on the code, to be changed again.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npx tsx --test tests/designations-logins.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { authenticate } from '@/lib/auth/sign-in';
import { throttleKey } from '@/lib/auth/throttle';
import { setOwnPassword } from '@/lib/auth/account';
import { createDesignation, updateDesignation } from '@/lib/hr/designations';
import {
  createEmployee,
  NEW_LOGIN,
  resetEmployeeLogin,
  updateEmployee,
} from '@/lib/hr/employees';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
const ADDRESS = `test-designations-${RUN}`;
// Codes unique to this run, so sign-in by code is never ambiguous with
// another test organization's employees.
const CODE = `D${RUN}-1`;
let technicianId: string;
let technicianRoleId: string;
let supervisorId: string;
let supervisorRoleId: string;

const person = (over: Record<string, unknown> = {}) => ({
  firstName: 'Rashid',
  lastName: 'Ali',
  hireDate: '2026-01-05',
  branchId: a.branchId,
  ...over,
});

/** The session user a login would have, for the calls a signed-in user makes. */
async function asLogin(userId: string): Promise<AuthenticatedUser> {
  const login = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return {
    id: login.id,
    organizationId: login.organizationId,
    primaryBranchId: login.primaryBranchId,
    email: login.email,
    fullName: login.fullName,
    mustChangePassword: login.mustChangePassword,
    roleNames: [],
    orgWidePermissions: new Set(),
    branchPermissions: new Map(),
  };
}

const activeRoles = async (userId: string) =>
  (
    await prisma.userRole.findMany({
      where: { userId, revokedAt: null },
      select: { roleId: true },
    })
  ).map((grant) => grant.roleId);

before(async () => {
  a = await createTestOrg('Designations');
});

after(async () => {
  await prisma.authThrottle.deleteMany({
    where: {
      key: {
        in: [
          throttleKey('login', CODE.toUpperCase()),
          throttleKey('login-address', ADDRESS),
        ],
      },
    },
  });
  await prisma.$disconnect();
});

describe('designations', () => {
  test('a new designation gets its own role, started from the chosen preset', async () => {
    const designation = await createDesignation(a.owner, {
      name: '  Technician ',
      preset: 'technician',
    });
    technicianId = designation.id;
    const role = await prisma.role.findUniqueOrThrow({
      where: { id: designation.roleId! },
      include: { rolePermissions: { include: { permission: true } } },
    });
    technicianRoleId = role.id;
    assert.equal(designation.name, 'Technician');
    assert.equal(role.name, 'Technician');
    assert.ok(role.rolePermissions.length > 0, 'the preset’s permissions are ticked');
    assert.ok(role.rolePermissions.some((rp) => rp.permission.code === 'job_card.view'));

    await expectDomainError(
      createDesignation(a.owner, { name: 'technician' }),
      /already a designation/,
    );
  });

  test('a role that already has the name is used, not duplicated', async () => {
    const existing = await prisma.role.create({
      data: { organizationId: a.organizationId, name: 'Supervisor' },
    });
    const designation = await createDesignation(a.owner, { name: 'Supervisor' });
    supervisorId = designation.id;
    supervisorRoleId = existing.id;
    assert.equal(designation.roleId, existing.id);
  });

  test('only someone who may edit employees creates designations', async () => {
    await assert.rejects(createDesignation(a.viewer, { name: 'Helper' }), AuthError);
  });
});

describe('employee codes and logins', () => {
  let employeeId: string;
  let loginId: string;

  test('an employee without a code gets the next EMP- code', async () => {
    const first = await createEmployee(a.owner, person());
    const second = await createEmployee(a.owner, person({ firstName: 'Sami' }));
    assert.match(first.employeeCode, /^EMP-\d{3,}$/);
    assert.equal(
      Number(second.employeeCode.slice(4)),
      Number(first.employeeCode.slice(4)) + 1,
      'codes run in sequence',
    );
    assert.equal(first.userId, null, 'no login unless asked for');
  });

  test('a login needs a designation — it decides what the login can do', async () => {
    await expectDomainError(
      createEmployee(a.owner, person({ employeeCode: `${CODE}-X`, userId: NEW_LOGIN })),
      /designation/i,
    );
  });

  test('“create a login”: signs in with the code and a one-time password — never the code', async () => {
    const employee = await createEmployee(
      a.owner,
      person({ employeeCode: CODE.toLowerCase(), designationId: technicianId, userId: NEW_LOGIN }),
    );
    employeeId = employee.id;
    loginId = employee.userId!;
    assert.equal(employee.employeeCode, CODE.toUpperCase());
    assert.equal(employee.jobTitle, 'Technician', 'the job title follows the designation');

    const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });
    assert.equal(login.username, CODE.toUpperCase());
    assert.equal(login.email, null);
    assert.equal(login.mustChangePassword, true);
    assert.deepEqual(await activeRoles(loginId), [technicianRoleId]);

    assert.ok(employee.temporaryPassword && employee.temporaryPassword.length >= 10);
    assert.equal(
      (await authenticate(CODE, CODE.toUpperCase(), ADDRESS)).ok,
      false,
      'the employee code is never the password',
    );
    const signedIn = await authenticate(` ${CODE.toLowerCase()} `, employee.temporaryPassword!, ADDRESS);
    assert.equal(signedIn.ok && signedIn.user.id, loginId);
  });

  test('the first sign-in chooses its own password, not the code', async () => {
    const me = await asLogin(loginId);
    await expectDomainError(
      setOwnPassword(me, { newPassword: 'abc', confirmPassword: 'abc' }, null),
      /8 characters/,
    );
    await expectDomainError(
      setOwnPassword(me, { newPassword: 'Garage2026', confirmPassword: 'Garage2027' }, null),
      /different/,
    );
    await setOwnPassword(me, { newPassword: 'Garage2026', confirmPassword: 'Garage2026' }, null);
    const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });
    assert.equal(login.mustChangePassword, false);
    assert.equal((await authenticate(CODE, CODE.toUpperCase(), ADDRESS)).ok, false);
    assert.equal((await authenticate(CODE, 'Garage2026', ADDRESS)).ok, true);
    await expectDomainError(
      setOwnPassword(await asLogin(loginId), { newPassword: 'Other2026', confirmPassword: 'Other2026' }, null),
      /already your own/,
    );
  });

  test('a new designation moves the login to its role', async () => {
    await updateEmployee(
      a.owner,
      employeeId,
      person({ employeeCode: CODE, designationId: supervisorId, userId: loginId }),
    );
    assert.deepEqual(await activeRoles(loginId), [supervisorRoleId]);
    const employee = await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } });
    assert.equal(employee.jobTitle, 'Supervisor');

    // A rename carries to the job title.
    await updateDesignation(a.owner, supervisorId, { name: 'Senior Supervisor' });
    assert.equal(
      (await prisma.employee.findUniqueOrThrow({ where: { id: employeeId } })).jobTitle,
      'Senior Supervisor',
    );
  });

  test('a reset gives a new one-time password, to be changed again', async () => {
    const reset = await resetEmployeeLogin(a.owner, employeeId);
    const login = await prisma.user.findUniqueOrThrow({ where: { id: loginId } });
    assert.equal(login.mustChangePassword, true);
    assert.equal((await authenticate(CODE, CODE.toUpperCase(), ADDRESS)).ok, false);
    assert.equal((await authenticate(CODE, reset.temporaryPassword, ADDRESS)).ok, true);
    await assert.rejects(resetEmployeeLogin(a.viewer, employeeId), AuthError);
  });
});
