/**
 * Integration tests for the permission grid and the audit log:
 *
 * - a role's ticks change and the change is audited; the View rule holds;
 *   someone without role.edit can't; the Owner role can't lose anything and
 *   can't be taken from the last active owner;
 * - a view-only Partner opens every list and report but can't change a thing;
 * - the audit log needs audit.view, reads as plain sentences, filters, exports
 *   only with audit.export, and the database refuses to edit or delete it.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { PERMISSION_CODES, ROLE_PRESETS } from '@/lib/auth/permission-catalog';
import { createRole, getRoleDetail, updateRolePermissions } from '@/lib/access/roles';
import { setUserActive, updateUser, listUsers } from '@/lib/access/users';
import { exportAuditLog, listAuditLog } from '@/lib/access/audit';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { recordInvoicePayment } from '@/lib/billing/invoice';
import { reverseInvoicePayment } from '@/lib/billing/invoice-changes';
import { listInvoices, listPayments } from '@/lib/billing/lists';
import { listCreditNotes } from '@/lib/billing/credit-notes';
import { recordExpense, voidExpense, listExpenses } from '@/lib/finance/expenses';
import { mergeCustomers } from '@/lib/customers/merge';
import { listCustomers } from '@/lib/customers/service';
import { listVehicles } from '@/lib/vehicles/service';
import { runPayroll, getPayrollOverview } from '@/lib/hr/payroll';
import { listEmployees } from '@/lib/hr/employees';
import { listLeave } from '@/lib/hr/leave';
import { getAttendanceDay } from '@/lib/hr/attendance';
import { createManualEntry } from '@/lib/accounting/entries';
import {
  getBalanceSheet,
  getLedgerProfitAndLoss,
  getTrialBalance,
  listJournal,
} from '@/lib/accounting/reports';
import { getCashFlowStatement } from '@/lib/accounting/cash-flow';
import { listAccounts } from '@/lib/finance/accounting';
import { getVatReturn } from '@/lib/finance/vat';
import { getFinanceDashboard } from '@/lib/finance/dashboard';
import { getWorkshopReport } from '@/lib/reports/workshop';
import { getPayables } from '@/lib/finance/supplier-payments';
import { getOrganizationSettings } from '@/lib/organization/settings';
import { listTaxCodes } from '@/lib/accounting/tax-codes';
import { listPaymentModes } from '@/lib/accounting/payment-modes';
import { listFixedAssets } from '@/lib/accounting/fixed-assets';
import { getAppointmentBoard } from '@/lib/appointments/service';
import { listJobCards } from '@/lib/workshop/job-card-list';
import { listQuotations } from '@/lib/workshop/quotations';
import { listParts } from '@/lib/inventory/parts';
import { listSuppliers } from '@/lib/inventory/suppliers';
import { listPurchases } from '@/lib/inventory/purchases';
import { listRoles } from '@/lib/access/roles';
import { toLocalDateTimeInput, localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let partner: AuthenticatedUser;
let customerId: string;

const now = () => toLocalDateTimeInput(new Date(Date.now() + 60_000));
const today = () => localDateString();
const isAuthError = (error: unknown) => error instanceof AuthError;

/** A real Role row with these codes, as the access screens read them. */
async function makeRole(name: string, codes: string[], isSystem = false) {
  const role = await prisma.role.create({
    data: { organizationId: a.organizationId, name: `${name} ${RUN}`, isSystem },
    select: { id: true },
  });
  const permissions = await prisma.permission.findMany({
    where: { code: { in: codes } },
    select: { id: true },
  });
  await prisma.rolePermission.createMany({
    data: permissions.map((permission) => ({
      organizationId: a.organizationId,
      roleId: role.id,
      permissionId: permission.id,
    })),
  });
  return role.id;
}

before(async () => {
  a = await createTestOrg('Grid');
  partner = {
    ...a.owner,
    orgWidePermissions: new Set(ROLE_PRESETS.find((preset) => preset.key === 'partner')!.codes),
  };
  customerId = (
    await prisma.customer.create({
      data: {
        organizationId: a.organizationId,
        name: `Grid Customer ${RUN}`,
        phone: '050 123 4567',
      },
    })
  ).id;
});

after(async () => {
  await prisma.$disconnect();
});

describe('the catalogue in the database', () => {
  test('every code exists (npm run db:permissions has been run)', async () => {
    const rows = await prisma.permission.findMany({
      where: { code: { in: PERMISSION_CODES } },
      select: { code: true },
    });
    assert.equal(rows.length, PERMISSION_CODES.length);
  });
});

describe('the role grid', () => {
  test('ticks are added and removed, and the change is audited with before and after', async () => {
    const role = await createRole(a.owner, {
      name: `Desk ${RUN}`,
      preset: 'front_desk',
      requestKey: `grid-create-${RUN}`,
    });
    const start = await getRoleDetail(a.owner, role.id);
    assert.ok(start.granted.includes('payment.create'), 'the preset is the starting point');

    const wanted = start.granted
      .filter((code) => code !== 'payment.create')
      .concat('invoice.delete');
    const result = await updateRolePermissions(a.owner, role.id, { permissions: wanted });
    assert.deepEqual(result.added, ['invoice.delete']);
    assert.deepEqual(result.removed, ['payment.create']);

    const detail = await getRoleDetail(a.owner, role.id);
    assert.ok(detail.granted.includes('invoice.delete'));
    assert.ok(!detail.granted.includes('payment.create'));

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: role.id, action: 'role.permissions_changed' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(entry, 'the change is in the audit log');
    const before = entry.beforeData as { permissions: string[] };
    const afterData = entry.afterData as { permissions: string[] };
    assert.ok(before.permissions.includes('payment.create'));
    assert.ok(!afterData.permissions.includes('payment.create'));
    assert.deepEqual((entry.metadata as { added: string[] }).added, ['Sales invoices · Delete']);
  });

  test('ticking an action ticks its View, whatever the browser sent', async () => {
    const role = await createRole(a.owner, {
      name: `Credits ${RUN}`,
      requestKey: `grid-cn-${RUN}`,
    });
    await updateRolePermissions(a.owner, role.id, { permissions: ['credit_note.create'] });
    const detail = await getRoleDetail(a.owner, role.id);
    assert.deepEqual(detail.granted.sort(), ['credit_note.create', 'credit_note.view']);
  });

  test('someone without role.edit can look but not change', async () => {
    const role = await makeRole('Look only', ['customer.view']);
    const looker = { ...a.owner, orgWidePermissions: new Set(['role.view']) };
    assert.ok(await getRoleDetail(looker, role));
    await assert.rejects(
      updateRolePermissions(looker, role, { permissions: ['customer.view', 'customer.edit'] }),
      isAuthError,
    );
    await assert.rejects(createRole(looker, { name: `Nope ${RUN}` }), isAuthError);
  });

  test('the Owner role cannot lose a permission', async () => {
    const owner = await makeRole('Owner', PERMISSION_CODES, true);
    await expectDomainError(
      updateRolePermissions(a.owner, owner, {
        permissions: PERMISSION_CODES.filter((code) => code !== 'audit.view'),
      }),
      /built-in role/i,
    );
    const detail = await getRoleDetail(a.owner, owner);
    assert.equal(detail.granted.length, PERMISSION_CODES.length);
  });

  test('the Owner role cannot be taken from the last active owner, and assignments are audited', async () => {
    const owner = await makeRole('Sole owner', PERMISSION_CODES, true);
    // An admin who is not an Owner can't touch an Owner's account at all, and
    // the sole Owner can't drop the role or deactivate themselves — so the
    // workshop is never left without an Owner.
    const admin = await makeRole('Admin', ['user.view', 'user.edit', 'user.delete']);
    await prisma.userRole.create({
      data: { organizationId: a.organizationId, userId: a.owner.id, roleId: admin },
    });
    await prisma.userRole.create({
      data: { organizationId: a.organizationId, userId: a.viewer.id, roleId: owner },
    });
    const viewer = await prisma.user.findUniqueOrThrow({ where: { id: a.viewer.id } });

    await expectDomainError(
      updateUser(a.owner, viewer.id, {
        fullName: viewer.fullName,
        email: viewer.email,
        roleIds: [admin],
      }),
      /Only an Owner can change an Owner's account/,
    );
    await expectDomainError(
      setUserActive(a.owner, viewer.id, { isActive: 'false' }),
      /Only an Owner can deactivate an Owner's account/,
    );
    const soleOwner = { ...a.owner, id: viewer.id };
    await expectDomainError(
      updateUser(soleOwner, viewer.id, {
        fullName: viewer.fullName,
        email: viewer.email,
        roleIds: [admin],
      }),
      /your own roles/,
    );
    await expectDomainError(
      setUserActive(soleOwner, viewer.id, { isActive: 'false' }),
      /your own account/,
    );

    // With a second active owner, the role can move — and the move is audited.
    await prisma.userRole.create({
      data: { organizationId: a.organizationId, userId: a.owner.id, roleId: owner },
    });
    await updateUser(a.owner, viewer.id, {
      fullName: viewer.fullName,
      email: viewer.email,
      roleIds: [admin],
    });
    const entry = await prisma.auditLog.findFirst({
      where: { entityId: viewer.id, action: 'user.roles_changed' },
      orderBy: { createdAt: 'desc' },
    });
    assert.ok(entry);
    assert.deepEqual((entry.beforeData as { roles: string[] }).roles, [`Sole owner ${RUN}`]);
    assert.deepEqual((entry.afterData as { roles: string[] }).roles, [`Admin ${RUN}`]);
  });
});

describe('a view-only Partner', () => {
  test('opens every list and report', async () => {
    const reads: [string, () => Promise<unknown>][] = [
      ['invoices', () => listInvoices(partner, {})],
      ['receipts', () => listPayments(partner, {})],
      ['credit notes', () => listCreditNotes(partner)],
      ['customers', () => listCustomers(partner, '')],
      ['vehicles', () => listVehicles(partner, '')],
      ['job cards', () => listJobCards(partner, {})],
      ['quotations', () => listQuotations(partner)],
      ['appointments', () => getAppointmentBoard(partner)],
      ['parts', () => listParts(partner, {})],
      ['suppliers', () => listSuppliers(partner, '')],
      ['purchases', () => listPurchases(partner, {})],
      ['payables', () => getPayables(partner)],
      ['expenses', () => listExpenses(partner)],
      ['chart of accounts', () => listAccounts(partner)],
      ['journal', () => listJournal(partner)],
      ['trial balance', () => getTrialBalance(partner)],
      ['profit & loss', () => getLedgerProfitAndLoss(partner)],
      ['balance sheet', () => getBalanceSheet(partner)],
      ['cash flow', () => getCashFlowStatement(partner)],
      ['fixed assets', () => listFixedAssets(partner)],
      ['VAT return', () => getVatReturn(partner)],
      ['finance overview', () => getFinanceDashboard(partner, { period: 'month' })],
      ['workshop report', () => getWorkshopReport(partner, { period: 'month' })],
      ['employees', () => listEmployees(partner)],
      ['attendance', () => getAttendanceDay(partner)],
      ['leave', () => listLeave(partner)],
      ['payroll', () => getPayrollOverview(partner)],
      ['settings', () => getOrganizationSettings(partner)],
      ['tax codes', () => listTaxCodes(partner)],
      ['payment modes', () => listPaymentModes(partner)],
      ['users', () => listUsers(partner, {})],
      ['roles', () => listRoles(partner)],
      ['audit log', () => listAuditLog(partner)],
    ];
    for (const [name, read] of reads) {
      await assert.doesNotReject(read(), `the Partner can open ${name}`);
    }
  });

  test('gets AuthError on every change', async () => {
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'LABOUR', description: 'Service', quantity: '1', unitPrice: '220' }],
    });
    const payment = await recordInvoicePayment(a.owner, invoiceId, {
      amount: '100',
      method: 'CASH',
      receivedAt: now(),
    });
    const expense = await recordExpense(a.owner, {
      description: `Partner check ${RUN}`,
      amount: '50',
      taxRate: '0',
      expenseDate: today(),
      paymentMethod: 'CASH',
    });
    const duplicate = await prisma.customer.create({
      data: {
        organizationId: a.organizationId,
        name: `Grid Duplicate ${RUN}`,
        phone: '050 765 4321',
      },
    });
    const accounts = await listAccounts(a.owner);
    const cash = accounts.flatMap((group) => group.accounts).find((row) => row.isPaymentAccount);
    const other = accounts.flatMap((group) => group.accounts).find((row) => row.id !== cash?.id);

    const changes: [string, () => Promise<unknown>][] = [
      [
        'createDirectInvoice',
        () =>
          createDirectInvoice(partner, {
            customerId,
            items: [
              { itemType: 'LABOUR', description: 'Not allowed', quantity: '1', unitPrice: '10' },
            ],
          }),
      ],
      [
        'recordInvoicePayment',
        () =>
          recordInvoicePayment(partner, invoiceId, {
            amount: '1',
            method: 'CASH',
            receivedAt: now(),
          }),
      ],
      [
        'reverseInvoicePayment',
        () => reverseInvoicePayment(partner, payment.id, { reason: 'Not allowed' }),
      ],
      [
        'recordExpense',
        () =>
          recordExpense(partner, {
            description: 'Not allowed',
            amount: '1',
            taxRate: '0',
            expenseDate: today(),
            paymentMethod: 'CASH',
          }),
      ],
      ['voidExpense', () => voidExpense(partner, expense.id, { reason: 'Not allowed' })],
      ['mergeCustomers', () => mergeCustomers(partner, duplicate.id, { targetId: customerId })],
      ['runPayroll', () => runPayroll(partner, { month: today().slice(0, 7) })],
      [
        'manual journal',
        () =>
          createManualEntry(partner, {
            date: today(),
            description: 'Not allowed',
            lines: [
              { accountId: cash?.id, debit: '1' },
              { accountId: other?.id, credit: '1' },
            ],
          }),
      ],
    ];
    for (const [name, change] of changes) {
      await assert.rejects(change(), isAuthError, `${name} is refused`);
    }
  });
});

describe('the audit log', () => {
  test('needs audit.view', async () => {
    await assert.rejects(listAuditLog(a.viewer), isAuthError);
    await assert.rejects(
      listAuditLog({ ...a.owner, orgWidePermissions: new Set(['user.view', 'role.view']) }),
      isAuthError,
    );
  });

  test('reads as plain sentences, newest first, with a link and the sensitive flag', async () => {
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'LABOUR', description: 'Brake job', quantity: '1', unitPrice: '220' }],
    });
    const payment = await recordInvoicePayment(a.owner, invoiceId, {
      amount: '231',
      method: 'CASH',
      receivedAt: now(),
    });
    await reverseInvoicePayment(a.owner, payment.id, { reason: 'wrong amount' });

    const log = await listAuditLog(a.owner, { module: 'payment' });
    const [latest] = log.entries;
    assert.equal(latest.action, 'payment.reversed');
    assert.match(latest.sentence, new RegExp(`^Reversed receipt ${payment.paymentNumber} `));
    assert.match(latest.sentence, /231\.00/);
    assert.match(latest.sentence, /— reason: wrong amount$/);
    assert.equal(latest.sensitive, true);
    assert.equal(latest.href, `/finance/invoices/${invoiceId}`);
    assert.equal(latest.who, a.owner.fullName);

    const recorded = log.entries.find((entry) => entry.action === 'payment.recorded');
    assert.ok(recorded);
    assert.match(recorded.sentence, new RegExp(`^Recorded receipt ${payment.paymentNumber} `));
    assert.equal(recorded.sensitive, false);
    assert.ok(latest.at >= recorded.at, 'newest first');
  });

  test('filters by person, module, type and date', async () => {
    const reversals = await listAuditLog(a.owner, { type: 'delete' });
    assert.ok(reversals.entries.length > 0);
    assert.ok(
      reversals.entries.every((entry) =>
        /\.(reversed|voided|cancelled|deleted|archived|removed|discarded|draft_deleted|bill_removed|merged_away)$/.test(
          entry.action,
        ),
      ),
    );
    const sensitive = await listAuditLog(a.owner, { type: 'sensitive' });
    assert.ok(sensitive.entries.every((entry) => entry.sensitive));

    const mine = await listAuditLog(a.owner, { who: a.owner.id });
    assert.ok(mine.entries.every((entry) => entry.whoId === a.owner.id));

    const invoices = await listAuditLog(a.owner, { module: 'invoice' });
    assert.ok(invoices.entries.length > 0);
    assert.ok(invoices.entries.every((entry) => entry.module === 'invoice'));

    const todays = await listAuditLog(a.owner, { from: today(), to: today() });
    assert.ok(todays.total > 0);
    const future = await listAuditLog(a.owner, { from: '2099-01-01' });
    assert.equal(future.total, 0);
  });

  test('pages hold 50 rows', async () => {
    const log = await listAuditLog(a.owner);
    assert.ok(log.entries.length <= 50);
    assert.equal(log.pages, Math.max(1, Math.ceil(log.total / 50)));
  });

  test('exporting needs audit.export as well', async () => {
    await assert.rejects(
      exportAuditLog({ ...a.owner, orgWidePermissions: new Set(['audit.view']) }),
      isAuthError,
    );
    const csv = await exportAuditLog(a.owner, { module: 'payment' });
    assert.match(csv, /Date & time \(Dubai\),Who,What happened/);
    assert.match(csv, /reason: wrong amount/);
  });

  test('the database refuses to change or delete an entry', async () => {
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { organizationId: a.organizationId },
    });
    await assert.rejects(
      prisma.auditLog.update({ where: { id: entry.id }, data: { action: 'tampered' } }),
      /permanent/,
    );
    await assert.rejects(prisma.auditLog.delete({ where: { id: entry.id } }), /permanent/);
    const still = await prisma.auditLog.findUniqueOrThrow({ where: { id: entry.id } });
    assert.equal(still.action, entry.action);
  });
});
