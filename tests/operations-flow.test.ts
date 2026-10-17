/**
 * Integration tests for the workshop's operational records: the people who
 * do the work (employees) and what the workshop spends to keep running
 * (expenses). Both are records that must survive correction rather than be
 * deleted, so these tests check what stays behind as much as what changes.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import {
  createEmployee,
  getEmployeeDetail,
  getEmployeeFormOptions,
  listEmployees,
  updateEmployee,
} from '@/lib/hr/employees';
import { listExpenses, recordExpense, voidExpense } from '@/lib/finance/expenses';
import { toFils } from '@/lib/money';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let b: TestOrg;
let categoryId: string;

before(async () => {
  a = await createTestOrg('OpsA');
  b = await createTestOrg('OpsB');
  const category = await prisma.chartOfAccount.create({
    data: {
      organizationId: a.organizationId,
      accountCode: `5100-${RUN}`,
      accountName: 'Rent',
      accountType: 'EXPENSE',
    },
  });
  categoryId = category.id;
});

after(async () => {
  await prisma.$disconnect();
});

const employeeInput = (over: Record<string, unknown> = {}) => ({
  firstName: 'Omar',
  lastName: 'Farooq',
  employeeCode: `EMP-${RUN}`,
  jobTitle: 'Technician',
  hireDate: '2025-03-01',
  branchId: a.branchId,
  ...over,
});

describe('employees', () => {
  test('an employee is created with their branch and code, and the change is audited', async () => {
    const employee = await createEmployee(a.owner, employeeInput());
    assert.equal(employee.firstName, 'Omar');
    assert.equal(employee.employeeCode, `EMP-${RUN}`.toUpperCase());
    assert.equal(employee.isActive, true);
    assert.equal(employee.userId, null, 'a technician needs no login');
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: employee.id, action: 'employee.created' },
      }),
    );
  });

  test('the employee code is unique within the workshop, and free in another', async () => {
    await expectDomainError(
      createEmployee(a.owner, employeeInput({ firstName: 'Someone', lastName: 'Else' })),
      /already has this code/,
    );
    // Another organization is a separate world.
    const other = await createEmployee(b.owner, {
      ...employeeInput(),
      branchId: b.branchId,
    });
    assert.ok(other.id);
  });

  test('a branch must belong to this workshop', async () => {
    await expectDomainError(
      createEmployee(a.owner, employeeInput({ employeeCode: `X-${RUN}`, branchId: b.branchId })),
      /branch of this workshop/,
    );
  });

  test('a leaving date before the joining date is refused', async () => {
    await expectDomainError(
      createEmployee(
        a.owner,
        employeeInput({ employeeCode: `Y-${RUN}`, terminationDate: '2024-01-01' }),
      ),
      /before the joining date/,
    );
  });

  test('one login stands for one employee', async () => {
    const first = await createEmployee(
      a.owner,
      employeeInput({ employeeCode: `L1-${RUN}`, userId: a.viewer.id }),
    );
    assert.equal(first.userId, a.viewer.id);
    await expectDomainError(
      createEmployee(a.owner, employeeInput({ employeeCode: `L2-${RUN}`, userId: a.viewer.id })),
      /already/,
    );
    // A login from another organization is not selectable.
    await expectDomainError(
      createEmployee(a.owner, employeeInput({ employeeCode: `L3-${RUN}`, userId: b.owner.id })),
      /login from this workshop/,
    );
  });

  test('someone who leaves is marked inactive and keeps their work history', async () => {
    // Two test employees are called Omar Farooq; take the one with this code.
    const [employee] = await listEmployees(a.owner, { query: `EMP-${RUN}` });
    assert.ok(employee);
    await updateEmployee(a.owner, employee.id, {
      ...employeeInput(),
      isActive: 'false',
      terminationDate: '2026-06-30',
    });

    const stillThere = await prisma.employee.findUniqueOrThrow({ where: { id: employee.id } });
    assert.equal(stillThere.isActive, false, 'the record is kept, not deleted');
    assert.ok(stillThere.terminationDate);
    assert.equal(
      (await listEmployees(a.owner, { show: 'active' })).some((e) => e.id === employee.id),
      false,
      'they drop off the working list',
    );
    assert.ok(
      (await listEmployees(a.owner, { show: 'all' })).some((e) => e.id === employee.id),
      'but are still findable',
    );
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: employee.id, action: 'employee.updated' },
      }),
    );
  });

  test('another organization cannot read or change this workshop’s people', async () => {
    const [employee] = await listEmployees(a.owner, { show: 'all' });
    await assert.rejects(
      getEmployeeDetail(b.owner, employee.id),
      (error: unknown) => error instanceof NotFoundError,
    );
    await assert.rejects(
      updateEmployee(b.owner, employee.id, { ...employeeInput(), branchId: b.branchId }),
      (error: unknown) => error instanceof NotFoundError,
    );
  });

  test('managing people needs permission; a viewer is refused', async () => {
    await assert.rejects(
      createEmployee(a.viewer, employeeInput({ employeeCode: `V-${RUN}` })),
      (error: unknown) => error instanceof AuthError,
    );
    await assert.rejects(
      listEmployees(a.viewer),
      (error: unknown) => error instanceof AuthError,
      'the team list is not public to every signed-in user',
    );
    await assert.rejects(
      getEmployeeFormOptions(a.viewer),
      (error: unknown) => error instanceof AuthError,
    );
  });

  test('the profile shows the work attributed to the person', async () => {
    const [employee] = await listEmployees(a.owner, { show: 'all' });
    const detail = await getEmployeeDetail(a.owner, employee.id);
    assert.equal(detail.employee.name, `${detail.employee.firstName} ${detail.employee.lastName}`);
    assert.ok(Array.isArray(detail.openJobs));
    assert.ok(Array.isArray(detail.recentLabour));
    assert.equal(typeof detail.counts.inspections, 'number');
  });
});

const expenseInput = (over: Record<string, unknown> = {}) => ({
  description: 'Monthly workshop rent',
  amount: '5000.00',
  taxRate: '5',
  expenseDate: '2026-09-01',
  vendorName: 'Al Qusais Properties',
  paymentMethod: 'BANK_TRANSFER',
  categoryId,
  ...over,
});

describe('expenses', () => {
  test('VAT is split exactly, and the record says who entered it', async () => {
    const expense = await recordExpense(a.owner, expenseInput());
    // 5000.00 net at 5% = 250.00 VAT, 5250.00 paid. Exact, not floating point.
    assert.equal(expense.amount.toString(), '5000');
    assert.equal(expense.taxAmount?.toString(), '250');
    assert.equal(expense.recordedByUserId, a.owner.id);
    assert.equal(expense.status, 'RECORDED');
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: expense.id, action: 'expense.recorded' },
      }),
    );
  });

  test('an expense with no VAT records none', async () => {
    const expense = await recordExpense(
      a.owner,
      expenseInput({ description: 'Municipality fee', amount: '300.00', taxRate: '' }),
    );
    assert.equal(expense.taxRate, null);
    assert.equal(expense.taxAmount, null);
  });

  test('the amount and date are checked', async () => {
    await expectDomainError(
      recordExpense(a.owner, expenseInput({ amount: '0.00' })),
      /more than zero/,
    );
    await expectDomainError(
      recordExpense(a.owner, expenseInput({ amount: 'lots' })),
      /amount like/,
    );
    await expectDomainError(
      recordExpense(a.owner, expenseInput({ expenseDate: 'last tuesday' })),
      /Choose the date/,
    );
    await expectDomainError(
      recordExpense(a.owner, expenseInput({ description: '' })),
      /what this was for/,
    );
  });

  test('a category must be one of this workshop’s expense accounts', async () => {
    const theirs = await prisma.chartOfAccount.create({
      data: {
        organizationId: b.organizationId,
        accountCode: `5100-${RUN}`,
        accountName: 'Rent',
        accountType: 'EXPENSE',
      },
    });
    await expectDomainError(
      recordExpense(a.owner, expenseInput({ categoryId: theirs.id })),
      /category from the list/,
    );
  });

  test('totals add up in exact money and exclude voided expenses', async () => {
    const before = await listExpenses(a.owner, {});
    const beforeTotal = toFils(before.totals.total);

    const expense = await recordExpense(
      a.owner,
      expenseInput({ description: 'Duplicate entry', amount: '100.00', taxRate: '5' }),
    );
    const withIt = await listExpenses(a.owner, {});
    assert.equal(
      toFils(withIt.totals.total) - beforeTotal,
      toFils('105.00'),
      '100.00 net plus 5% VAT',
    );

    await voidExpense(a.owner, expense.id, { reason: 'Entered twice by mistake' });
    const afterVoid = await listExpenses(a.owner, {});
    assert.equal(toFils(afterVoid.totals.total), beforeTotal, 'a voided expense stops counting');

    const kept = await prisma.expense.findUniqueOrThrow({ where: { id: expense.id } });
    assert.equal(kept.status, 'VOID', 'the record is kept, not deleted');
    const audit = await prisma.auditLog.findFirst({
      where: { entityId: expense.id, action: 'expense.voided' },
    });
    assert.ok(audit, 'voiding is audited');
    assert.match(JSON.stringify(audit?.metadata), /Entered twice/, 'with the reason');

    assert.ok(
      (await listExpenses(a.owner, { show: 'all' })).expenses.some((e) => e.id === expense.id),
      'and is still visible when asked for',
    );
  });

  test('an expense cannot be voided twice, and needs permission', async () => {
    const expense = await recordExpense(a.owner, expenseInput({ description: 'Once only' }));
    await voidExpense(a.owner, expense.id, { reason: 'Wrong amount' });
    await expectDomainError(
      voidExpense(a.owner, expense.id, { reason: 'Again' }),
      /already voided/,
    );
    await assert.rejects(
      recordExpense(a.viewer, expenseInput()),
      (error: unknown) => error instanceof AuthError,
    );
    await assert.rejects(
      listExpenses(a.viewer, {}),
      (error: unknown) => error instanceof AuthError,
    );
  });

  test('another organization sees none of these expenses', async () => {
    const theirs = await listExpenses(b.owner, { show: 'all' });
    assert.equal(theirs.expenses.length, 0);
    const [mine] = (await listExpenses(a.owner, { show: 'all' })).expenses;
    await assert.rejects(
      voidExpense(b.owner, mine.id, { reason: 'Not mine' }),
      (error: unknown) => error instanceof NotFoundError,
    );
  });

  test('the same submission twice records one expense', async () => {
    const input = expenseInput({
      description: 'Double click',
      requestKey: `expense-duplicate-${RUN}`,
    });
    const results = await Promise.allSettled([
      recordExpense(a.owner, input),
      recordExpense(a.owner, input),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const matches = await prisma.expense.count({
      where: { organizationId: a.organizationId, description: 'Double click' },
    });
    assert.equal(matches, 1);
  });
});
