/**
 * Integration tests for the VAT return, the profit & loss, the cash summary,
 * the chart of accounts and the workshop reports — that each figure follows
 * the rule it states, in exact money, from the records already kept.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { checkInVehicle } from '@/lib/workshop/check-in';
import { startInspection, saveInspection } from '@/lib/workshop/inspection';
import { saveDiagnosis } from '@/lib/workshop/diagnosis';
import {
  createEstimate,
  recordCustomerDecision,
  saveEstimateDraft,
  sendEstimate,
} from '@/lib/workshop/estimates';
import { recordLabour, startRepair } from '@/lib/workshop/repair';
import { recordQualityCheck } from '@/lib/workshop/quality-check';
import { createInvoice, recordInvoicePayment, recordPayment } from '@/lib/billing/invoice';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { reverseInvoicePayment } from '@/lib/billing/invoice-changes';
import { getFinanceSnapshot, getTodaysActivity } from '@/lib/data/dashboard';
import { recordExpense, voidExpense } from '@/lib/finance/expenses';
import { getVatReturn, splitSupplies, vatDueDate } from '@/lib/finance/vat';
import {
  createAccount,
  getCashSummary,
  getProfitAndLoss,
  listAccounts,
  updateAccount,
} from '@/lib/finance/accounting';
import { getWorkshopReport } from '@/lib/reports/workshop';
import { getFinanceDashboard, resolvePeriod } from '@/lib/finance/dashboard';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let b: TestOrg;
let jobCardId: string;
const today = localDateString();
const plate = `V${RUN.slice(-4)} 55`;

/** 3 h at 300.00 = 900.00 net, 5% VAT = 45.00, total 945.00. */
async function invoicedJob(org: TestOrg) {
  const { jobCardId: id } = await checkInVehicle(org.owner, {
    mode: 'new',
    customer: { name: 'Accounts Customer', phone: '050 909 7171', email: '' },
    vehicle: { plateNumber: plate, make: 'Nissan', model: 'Patrol' },
    visit: { complaint: 'Service', mileage: '50000' },
  });
  const inspection = await startInspection(org.owner, id, org.technicianIds[0]);
  await saveInspection(
    org.owner,
    inspection.id,
    { items: [{ description: 'Service', result: 'ATTENTION_NEEDED', notes: 'Due' }] },
    { complete: true },
  );
  await saveDiagnosis(org.owner, id, {
    findings: 'Service due',
    recommendedAction: 'Service',
    employeeId: org.technicianIds[0],
  });
  const estimate = await createEstimate(org.owner, id);
  await saveEstimateDraft(org.owner, estimate.id, {
    validUntil: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
    items: [
      {
        itemType: 'LABOUR',
        description: 'Service',
        quantity: '3',
        unitPrice: '300.00',
        taxRate: '5',
      },
    ],
  });
  await sendEstimate(org.owner, estimate.id);
  await recordCustomerDecision(org.owner, estimate.id, {
    decision: 'APPROVED',
    method: 'IN_PERSON',
    notes: 'Approved',
  });
  await startRepair(org.owner, id);
  const [line] = await prisma.estimateItem.findMany({ where: { estimateId: estimate.id } });
  await recordLabour(org.owner, id, {
    description: 'Service',
    hours: '3',
    rate: '300.00',
    employeeId: org.technicianIds[0],
    estimateItemId: line.id,
  });
  await recordQualityCheck(org.owner, id, { result: 'PASSED', employeeId: org.technicianIds[0] });
  await createInvoice(org.owner, id);
  return id;
}

before(async () => {
  a = await createTestOrg('AccA');
  b = await createTestOrg('AccB');
  jobCardId = await invoicedJob(a);
  // 100.00 + 5% VAT, paid in cash; and one voided, which must never count.
  await recordExpense(a.owner, {
    description: 'Workshop supplies',
    amount: '100.00',
    taxRate: '5',
    supplierTrn: '100123456700003',
    expenseDate: today,
    paymentMethod: 'CASH',
  });
  const voided = await recordExpense(a.owner, {
    description: 'Entered twice',
    amount: '100.00',
    taxRate: '5',
    expenseDate: today,
    paymentMethod: 'CASH',
  });
  await voidExpense(a.owner, voided.id, { reason: 'Duplicate' });
  await recordPayment(a.owner, jobCardId, {
    amount: '945.00',
    method: 'CARD',
    receivedAt: toLocalDateTimeInput(new Date(Date.now() + 60_000)),
  });
});

after(async () => {
  await prisma.$disconnect();
});

describe('periods', () => {
  test('quarters and last month are whole calendar ranges', () => {
    const quarter = resolvePeriod({ period: 'quarter' });
    const month = Number(today.slice(5, 7));
    const first = month - ((month - 1) % 3);
    assert.equal(quarter.from, `${today.slice(0, 4)}-${String(first).padStart(2, '0')}-01`);
    assert.equal(quarter.to, today);
    const last = resolvePeriod({ period: 'last-month' });
    assert.equal(last.from.slice(8), '01');
    assert.ok(last.to < `${today.slice(0, 7)}-01`);
    assert.equal(resolvePeriod({ period: 'year' }).from, `${today.slice(0, 4)}-01-01`);
  });
});

describe('VAT return', () => {
  test('zero-rated lines are split out, a bill discount spread over them', () => {
    const lines = [
      { lineTotal: '600.00', taxRate: '5.00' },
      { lineTotal: '400.00', taxRate: '0' },
    ];
    assert.deepEqual(splitSupplies(100000, lines), { standard: 60000, zero: 40000 });
    assert.deepEqual(splitSupplies(90000, lines), { standard: 54000, zero: 36000 });
    assert.deepEqual(splitSupplies(50000, [{ lineTotal: '500.00', taxRate: null }]), {
      standard: 0,
      zero: 50000,
    });
  });

  test('output from tax invoices, input from expenses carrying VAT', async () => {
    const vat = await getVatReturn(a.owner, { period: 'month' });
    assert.equal(vat.registered, true);
    assert.equal(vat.boxes.standardSupplies, '900.00');
    assert.equal(vat.boxes.outputVat, '45.00');
    assert.equal(vat.boxes.zeroRatedSupplies, '0.00');
    assert.equal(vat.boxes.expenseVat, '5.00', 'the voided expense is not reclaimed');
    assert.equal(vat.boxes.inputVat, '5.00');
    assert.equal(vat.boxes.net, '40.00');
    assert.equal(vat.sales.length, 1);
  });

  test('a workshop that is not VAT-registered reports nothing', async () => {
    await prisma.organization.update({
      where: { id: a.organizationId },
      data: { isVatRegistered: false },
    });
    try {
      const vat = await getVatReturn(a.owner, { period: 'month' });
      assert.equal(vat.registered, false);
      assert.equal(vat.boxes.outputVat, '0.00');
      assert.equal(vat.boxes.net, '0.00');
    } finally {
      await prisma.organization.update({
        where: { id: a.organizationId },
        data: { isVatRegistered: true },
      });
    }
  });

  test('needs accounting.view, and never shows another workshop', async () => {
    await assert.rejects(getVatReturn(a.viewer, {}), AuthError);
    const other = await getVatReturn(b.owner, { period: 'month' });
    assert.equal(other.sales.length, 0);
    assert.equal(other.boxes.outputVat, '0.00');
  });
});

describe('profit & loss', () => {
  test('sales less expenses, net of VAT, voided expenses excluded', async () => {
    const pl = await getProfitAndLoss(a.owner, { period: 'month' });
    assert.equal(pl.sales.total, '900.00');
    assert.equal(pl.sales.labour, '900.00');
    assert.equal(pl.sales.parts, '0.00');
    assert.equal(pl.partsCost, '0.00');
    assert.equal(pl.grossProfit, '900.00');
    assert.equal(pl.expenses.total, '100.00');
    assert.equal(pl.operatingCosts, '100.00');
    assert.equal(pl.netProfit, '800.00');
  });

  test('cash counts money that actually moved, with the VAT paid on expenses', async () => {
    const cash = await getCashSummary(a.owner, { period: 'month' });
    assert.equal(cash.in.total, '945.00');
    assert.deepEqual(cash.in.rows, [{ label: 'Card', amount: '945.00' }]);
    assert.equal(cash.out.rows.find((row) => row.label === 'Expenses paid')?.amount, '105.00');
    assert.equal(cash.net, '840.00');
  });
});

describe('chart of accounts', () => {
  test('an account is added, its code kept unique, and retired rather than deleted', async () => {
    const account = await createAccount(a.owner, {
      accountCode: `ins-${RUN.slice(-4)}`,
      accountName: 'Insurance',
      accountType: 'EXPENSE',
    });
    assert.equal(account.accountCode, `INS-${RUN.slice(-4)}`);
    await expectDomainError(
      createAccount(a.owner, {
        accountCode: account.accountCode.toLowerCase(),
        accountName: 'Insurance again',
        accountType: 'EXPENSE',
      }),
      /already used/,
    );
    await updateAccount(a.owner, account.id, {
      accountCode: account.accountCode,
      accountName: 'Vehicle insurance',
      isActive: 'false',
    });
    const groups = await listAccounts(a.owner);
    const found = groups
      .find((group) => group.type === 'EXPENSE')
      ?.accounts.find((row) => row.id === account.id);
    assert.equal(found?.accountName, 'Vehicle insurance');
    assert.equal(found?.isActive, false);
  });

  test('the chart can be searched by code or name, however it is typed', async () => {
    const matches = (groups: Awaited<ReturnType<typeof listAccounts>>) =>
      groups.flatMap((group) => group.accounts.map((row) => row.accountCode));
    const byName = await listAccounts(a.owner, { q: 'sales DISCOUNT' });
    assert.deepEqual(matches(byName), ['4090']);
    assert.equal(byName.find((group) => group.type === 'REVENUE')?.accounts.length, 1);
    assert.deepEqual(matches(await listAccounts(a.owner, { q: '1020' })), ['1020']);
    assert.deepEqual(matches(await listAccounts(a.owner, { q: 'no such account' })), []);
    // Every group is still there, so the screen can say which have nothing.
    assert.equal((await listAccounts(a.owner, { q: 'zzz' })).length, byName.length);
    // A blank search is the whole chart.
    assert.deepEqual(
      matches(await listAccounts(a.owner, { q: '  ' })),
      matches(await listAccounts(a.owner)),
    );
  });

  test('changing the chart needs more than accounting.view', async () => {
    const reader = { ...a.owner, orgWidePermissions: new Set(['accounting.view']) };
    await assert.rejects(
      createAccount(reader, { accountCode: 'X1', accountName: 'Nope', accountType: 'EXPENSE' }),
      AuthError,
    );
  });
});

describe('reports', () => {
  test('sales, jobs and technician hours for the period', async () => {
    const report = await getWorkshopReport(a.owner, { period: 'month' });
    assert.equal(report.sales?.total, '900.00');
    assert.equal(report.sales?.count, 1);
    assert.equal(report.sales?.monthly.length, 12);
    assert.equal(report.sales?.monthly[11].value, '900.00');
    assert.equal(report.sales?.topCustomers[0].name, 'Accounts Customer');
    assert.equal(report.workshop?.opened, 1);
    assert.equal(report.workshop?.technicians[0].hours, '3');
    assert.deepEqual(report.workshop?.makes, [{ make: 'Nissan', count: 1, valueFils: 1 }]);
  });

  test('a section the role does not cover is not produced', async () => {
    // Only a role given reports opens the report at all.
    await assert.rejects(getWorkshopReport(a.viewer, { period: 'month' }), AuthError);
    const withReports = {
      ...a.viewer,
      orgWidePermissions: new Set([...a.viewer.orgWidePermissions, 'reports.view']),
    };
    const report = await getWorkshopReport(withReports, { period: 'month' });
    assert.equal(report.sales, null, 'the viewer has no invoice.view');
    assert.ok(report.workshop, 'but may see the workshop');
    assert.ok(report.parts);
    const nobody = { ...a.owner, orgWidePermissions: new Set<string>() };
    await assert.rejects(getWorkshopReport(nobody, {}), AuthError);
  });
});

describe('collected, when a payment is reversed', () => {
  // A reversed payment keeps status COMPLETED; the reversal is a second row
  // with status REVERSED pointing back at it. Neither may count as money in.
  test('both dashboards count only the payment that stands', async () => {
    const c = await createTestOrg('AccCollected');
    const customer = await prisma.customer.create({
      data: {
        organizationId: c.organizationId,
        name: `Collected Customer ${RUN}`,
        phone: '050 808 1122',
      },
    });
    // 219.00 + 5% VAT = 229.95 — the shape of the real RCT-000002 case.
    const { invoiceId } = await createDirectInvoice(c.owner, {
      customerId: customer.id,
      items: [
        { itemType: 'LABOUR', description: 'Periodic service', quantity: '1', unitPrice: '219' },
      ],
    });
    const now = () => toLocalDateTimeInput(new Date());

    const wrong = await recordInvoicePayment(c.owner, invoiceId, {
      amount: '100.00',
      method: 'CASH',
      receivedAt: now(),
    });
    await reverseInvoicePayment(c.owner, wrong.id, { reason: 'Wrong amount entered' });
    await recordInvoicePayment(c.owner, invoiceId, {
      amount: '229.95',
      method: 'CASH',
      receivedAt: now(),
    });

    // Finance → Overview: "Collected".
    const finance = await getFinanceDashboard(c.owner, { period: 'today' });
    assert.equal(finance.revenue?.collected, '229.95', 'the reversed 100.00 is not collected');

    // Home: "Collected today".
    const snapshot = await getFinanceSnapshot(c.organizationId);
    assert.equal(snapshot.todaysCollections, '229.95');

    // Home: today's activity lists only the receipt that stands.
    const activity = await getTodaysActivity(c.organizationId, { includeMoney: true });
    const receipts = activity.filter((item) => item.kind === 'payment');
    assert.equal(receipts.length, 1, 'the reversed receipt is not listed');
    assert.equal(receipts[0].amount, '229.95');
  });
});

describe('VAT due date', () => {
  test('the current quarter is due 28 days after the quarter ends, not after today', async () => {
    const vat = await getVatReturn(a.owner, { period: 'quarter' });

    // The last day of the calendar quarter today falls in, worked out here
    // independently of the code under test.
    const [year, month] = today.split('-').map(Number);
    const lastMonth = month - ((month - 1) % 3) + 2;
    const quarterEnd = new Date(Date.UTC(year, lastMonth, 0));
    const expected = new Date(quarterEnd.getTime() + 28 * 86_400_000).toISOString().slice(0, 10);

    assert.equal(vat.period.periodEnd, quarterEnd.toISOString().slice(0, 10));
    assert.equal(vat.dueDate.toISOString().slice(0, 10), expected);
    assert.equal(vat.period.to, today, 'the figures still run only to today');
  });

  test('July to September is due on 28 October', () => {
    assert.equal(vatDueDate('2026-09-30').toISOString().slice(0, 10), '2026-10-28');
  });
});
