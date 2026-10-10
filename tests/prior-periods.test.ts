/**
 * Months before the books, entered as totals: booked against opening
 * balance equity (never the bank), counted in the VAT return of their
 * quarter, checked against the opening VAT, reversed when removed.
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { NotFoundError } from '@/lib/errors';
import { toFils } from '@/lib/money';
import { ensureChart } from '@/lib/accounting/chart';
import { saveOpeningBalances } from '@/lib/accounting/opening-balances';
import {
  getPriorPeriods,
  removePriorPeriod,
  savePriorPeriod,
} from '@/lib/accounting/prior-periods';
import { getVatReturn } from '@/lib/finance/vat';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let b: TestOrg;
let roles: Record<AccountRole, string>;
let augustId: string;

const BOOKS_START = '2025-09-16';
const d = (value: string) => new Date(`${value}T00:00:00Z`);

/** Net debit per account role, in fils, over one record's standing and reversed entries. */
async function bookedByRole(sourceId: string) {
  const lines = await prisma.journalEntryLine.findMany({
    where: {
      organizationId: a.organizationId,
      journalEntry: { sourceType: 'PRIOR_PERIOD', sourceId },
    },
    select: { chartOfAccountId: true, debitAmount: true, creditAmount: true },
  });
  const byRole = new Map<string, number>();
  for (const line of lines) {
    const role = Object.entries(roles).find(([, id]) => id === line.chartOfAccountId)?.[0] ?? '?';
    byRole.set(
      role,
      (byRole.get(role) ?? 0) +
        toFils(line.debitAmount.toString()) -
        toFils(line.creditAmount.toString()),
    );
  }
  return byRole;
}

before(async () => {
  a = await createTestOrg('PriorA');
  b = await createTestOrg('PriorB');
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  await prisma.organization.update({
    where: { id: a.organizationId },
    data: {
      taxNumber: '100000000000003',
      vatFirstPeriodStart: d('2025-02-01'),
      vatFirstPeriodEnd: d('2025-04-30'),
      vatPeriodMonths: 3,
    },
  });
  // The VAT of 1 Aug – 15 Sep, not yet filed when the books began.
  await saveOpeningBalances(a.owner, {
    date: BOOKS_START,
    lines: [
      { accountId: roles.BANK, debit: '10000.00' },
      { accountId: roles.VAT_OUTPUT, credit: '250.00' },
      { accountId: roles.VAT_INPUT, debit: '40.00' },
    ],
  });
});

after(async () => {
  await prisma.$disconnect();
});

describe('months before the books', () => {
  test('booked to income and costs, the profit against opening balance equity', async () => {
    const saved = await savePriorPeriod(a.owner, {
      month: '2025-08',
      sales: '5000.00',
      salesVat: '250.00',
      partsBought: '1000.00',
      purchasesVat: '40.00',
      costsWithoutVat: '300.00',
      salaries: '2000.00',
      requestKey: `prior-aug-${RUN}`,
    });
    augustId = saved.id;
    const booked = await bookedByRole(augustId);
    assert.equal(booked.get('SALES_OTHER'), -5_000_00);
    assert.equal(booked.get('COST_OF_PARTS'), 1_000_00);
    assert.equal(booked.get('OTHER_EXPENSES'), 300_00);
    assert.equal(booked.get('SALARIES_EXPENSE'), 2_000_00);
    assert.equal(booked.get('OPENING_BALANCE'), 1_700_00, 'the month’s profit');
    assert.equal(booked.get('BANK'), undefined, 'the bank is never touched');
    assert.equal(booked.get('VAT_OUTPUT'), undefined, 'VAT goes in the return, not the ledger');
  });

  test('the month counts in its quarter’s VAT return', async () => {
    const vat = await getVatReturn(a.owner, {
      period: 'custom',
      from: '2025-08-01',
      to: '2025-10-31',
    });
    assert.equal(vat.boxes.standardSupplies, '5000.00');
    assert.equal(vat.boxes.outputVat, '250.00');
    assert.equal(vat.boxes.standardExpenses, '1000.00');
    assert.equal(vat.boxes.inputVat, '40.00');
    assert.equal(vat.priorPeriods.length, 1);
  });

  test('the opening VAT is checked against the months', async () => {
    const screen = await getPriorPeriods(a.owner);
    assert.equal(screen.openingVat?.periodFrom, '2025-08-01');
    assert.equal(screen.openingVat?.expectedOutput, '250.00');
    assert.equal(screen.openingVat?.openingOutput, '250.00');
    assert.equal(screen.openingVat?.matches, true);
  });

  test('the month the books began covers only the days before them', async () => {
    const saved = await savePriorPeriod(a.owner, { month: '2025-09', sales: '800.00' });
    const row = await prisma.priorPeriodSummary.findUniqueOrThrow({ where: { id: saved.id } });
    assert.equal(row.periodTo.toISOString().slice(0, 10), '2025-09-15');
    await expectDomainError(
      savePriorPeriod(a.owner, { month: '2025-10', sales: '1.00' }),
      /already in them/,
    );
  });

  test('no VAT before registration, no more than 5%, no month twice', async () => {
    await expectDomainError(
      savePriorPeriod(a.owner, { month: '2025-01', sales: '1000.00', salesVat: '50.00' }),
      /VAT registration began/,
    );
    await expectDomainError(
      savePriorPeriod(a.owner, { month: '2025-07', sales: '1000.00', salesVat: '90.00' }),
      /5% of them at most/,
    );
    await expectDomainError(
      savePriorPeriod(a.owner, { month: '2025-08', sales: '1.00' }),
      /already entered/,
    );
  });

  test('another workshop can’t remove it; removing reverses the entry', async () => {
    await assert.rejects(
      removePriorPeriod(b.owner, augustId, { reason: 'Not ours' }),
      NotFoundError,
    );
    await removePriorPeriod(a.owner, augustId, { reason: 'Entered twice' });
    const booked = await bookedByRole(augustId);
    for (const [role, net] of booked) assert.equal(net, 0, `${role} nets to zero`);
  });
});
