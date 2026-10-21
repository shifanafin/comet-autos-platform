/**
 * Integration tests for rent & other income (INC-):
 *
 * - rent received in cash: Dr cash, Cr the income account, Cr Output VAT
 *   with the 5% inside the amount; numbered INC-, apart from the invoices;
 * - in the VAT return on the day received: Box 1 and output VAT with its tax
 *   code; out of scope stays out of the boxes;
 * - voided: kept on record, its entry gone, out of the return;
 * - refused: a future date, an account that isn't income, card settlements;
 *   someone who may only look can't record one.
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
import { ensureChart, type RoleAccounts } from '@/lib/accounting/chart';
import { createAccount } from '@/lib/finance/accounting';
import { countUnbooked } from '@/lib/accounting/entries';
import { getTrialBalance } from '@/lib/accounting/reports';
import { getVatReturn } from '@/lib/finance/vat';
import {
  getOtherIncome,
  getOtherIncomeForm,
  listOtherIncome,
  recordOtherIncome,
  voidOtherIncome,
} from '@/lib/finance/other-income';
import { localDateString } from '@/lib/format';
import { toFils } from '@/lib/money';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: RoleAccounts;
let rentAccountId: string;
let standard: string;
let outOfScope: string;
let rentId: string;

const today = () => localDateString();

/** What the standing entry for a receipt books, by account id, in fils (debit positive). */
async function booked(id: string) {
  const lines = await prisma.journalEntryLine.findMany({
    where: {
      organizationId: a.organizationId,
      journalEntry: { sourceType: 'OTHER_INCOME', sourceId: id },
    },
  });
  const sums = new Map<string, number>();
  for (const line of lines) {
    const value = toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString());
    sums.set(line.chartOfAccountId, (sums.get(line.chartOfAccountId) ?? 0) + value);
  }
  return sums;
}

before(async () => {
  a = await createTestOrg('OtherIncome');
  await prisma.organization.update({
    where: { id: a.organizationId },
    data: { isVatRegistered: true },
  });
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  const rent = await createAccount(a.owner, {
    accountCode: '4030',
    accountName: `Rental income ${RUN}`,
    accountType: 'REVENUE',
  });
  rentAccountId = rent.id;
  const form = await getOtherIncomeForm(a.owner);
  standard = form.taxCodes.find((code) => code.treatment === 'STANDARD')!.id;
  outOfScope = form.taxCodes.find((code) => code.treatment === 'OUT_OF_SCOPE')!.id;
});

after(async () => {
  await prisma.$disconnect();
});

describe('rent received', () => {
  test('the form defaults to the rental account, cash and standard rate', async () => {
    const form = await getOtherIncomeForm(a.owner);
    assert.equal(form.defaults.incomeAccountId, rentAccountId);
    assert.equal(form.defaults.taxCodeId, standard);
    assert.ok(form.moneyAccounts.every((account) => account.kind !== 'card-settlements'));
    assert.ok(
      !form.incomeAccounts.some((account) => account.id === roles.SALES_LABOUR),
      'the workshop’s own sales accounts are not offered',
    );
  });

  test('2,000 in cash: rent 1,904.76 and VAT 95.24, numbered INC-', async () => {
    const row = await recordOtherIncome(a.owner, {
      receivedOn: today(),
      receivedFrom: 'Nassiru',
      description: 'Rent — outside space, this month',
      incomeAccountId: rentAccountId,
      accountId: roles.CASH,
      taxCodeId: standard,
      amount: '2000',
    });
    rentId = row.id;
    assert.match(row.incomeNumber, /^INC-\d+$/);
    const lines = await booked(row.id);
    assert.equal(lines.get(roles.CASH), 200_000);
    assert.equal(lines.get(rentAccountId), -190_476);
    assert.equal(lines.get(roles.VAT_OUTPUT), -9_524);
    const stored = await getOtherIncome(a.owner, row.id);
    assert.equal(stored.netAmount.toString(), '1904.76');
    assert.equal(stored.vatAmount.toString(), '95.24');
    assert.equal((await getTrialBalance(a.owner)).balanced, true);
    assert.equal(await countUnbooked(a.owner), 0);
  });

  test('out of scope: no VAT, and not in the return’s boxes', async () => {
    const row = await recordOtherIncome(a.owner, {
      receivedOn: today(),
      receivedFrom: 'Insurer',
      description: `Claim ${RUN}`,
      incomeAccountId: rentAccountId,
      accountId: roles.CASH,
      taxCodeId: outOfScope,
      amount: '500',
    });
    const lines = await booked(row.id);
    assert.equal(lines.get(roles.CASH), 50_000);
    assert.equal(lines.get(rentAccountId), -50_000);
    assert.equal(lines.get(roles.VAT_OUTPUT) ?? 0, 0);
    await voidOtherIncome(a.owner, row.id, { reason: 'Test' });
  });

  test('the VAT return counts it in Box 1 on the day received', async () => {
    const vat = await getVatReturn(a.owner, { period: 'month' });
    assert.ok(vat.otherIncome.some((row) => row.id === rentId));
    assert.equal(vat.boxes.standardSupplies, '1904.76');
    assert.equal(vat.boxes.outputVat, '95.24');
  });

  test('refused: a future date, card settlements, an account that is not income', async () => {
    const base = {
      receivedOn: today(),
      receivedFrom: 'Someone',
      description: 'Something received',
      incomeAccountId: rentAccountId,
      accountId: roles.CASH,
      taxCodeId: standard,
      amount: '100',
    };
    await expectDomainError(
      recordOtherIncome(a.owner, { ...base, receivedOn: '2999-01-01' }),
      /future/,
    );
    await expectDomainError(
      recordOtherIncome(a.owner, { ...base, accountId: roles.CARD_CLEARING }),
      /cash, petty cash or bank/,
    );
    await expectDomainError(
      recordOtherIncome(a.owner, { ...base, incomeAccountId: roles.SALES_LABOUR }),
      /income account/,
    );
  });

  test('someone who may only look cannot record it', async () => {
    await assert.rejects(
      recordOtherIncome(a.viewer, {
        receivedOn: today(),
        receivedFrom: 'Someone',
        description: 'Something received',
        incomeAccountId: rentAccountId,
        accountId: roles.CASH,
        taxCodeId: standard,
        amount: '100',
      }),
      (error) => error instanceof AuthError,
    );
  });
});

describe('a receipt voided', () => {
  test('stays on record; its entry and its VAT are gone', async () => {
    await voidOtherIncome(a.owner, rentId, { reason: 'Entered on the wrong day.' });
    const lines = await booked(rentId);
    assert.ok([...lines.values()].every((value) => value === 0));
    const list = await listOtherIncome(a.owner);
    assert.equal(list.rows.find((row) => row.id === rentId)?.status, 'VOID');
    const vat = await getVatReturn(a.owner, { period: 'month' });
    assert.ok(!vat.otherIncome.some((row) => row.id === rentId));
    assert.equal(vat.boxes.outputVat, '0.00');
    await expectDomainError(voidOtherIncome(a.owner, rentId, { reason: 'Again' }), /already void/);
  });
});
