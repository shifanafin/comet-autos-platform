/**
 * Integration tests for expenses an owner paid with their own money:
 *
 * - "Paid personally by" books Dr the expense and Input VAT, Cr Due to owner
 *   (2520) with the owner's name on the line; the books still balance and
 *   the workshop owes the owner the total;
 *   and the VAT return counts its input VAT;
 * - reimbursing clears it, can't exceed what is owed, and a reversal puts it
 *   back;
 * - a payment mode on "Card settlements receivable" is refused for an
 *   expense, a supplier payment and a reimbursement (it is for customers
 *   paying the garage);
 * - someone with Accounts → View sees what is owed but can't reimburse.
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
import { ROLE_PRESETS } from '@/lib/auth/permission-catalog';
import { ensureChart } from '@/lib/accounting/chart';
import { getTrialBalance } from '@/lib/accounting/reports';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { getVatReturn } from '@/lib/finance/vat';
import { recordExpense, updateExpense, voidExpense } from '@/lib/finance/expenses';
import {
  getOwedToOwners,
  listPersonalPayers,
  reimburseOwner,
  reverseOwnerReimbursement,
} from '@/lib/finance/owner-payments';
import { listAuditLog } from '@/lib/access/audit';
import { localDateString } from '@/lib/format';
import type { RoleAccounts } from '@/lib/accounting/chart';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let partner: AuthenticatedUser;
let roles: RoleAccounts;
let ownerName: string;

const today = () => localDateString();
const isAuthError = (error: unknown) => error instanceof AuthError;

async function owedTo(userId: string) {
  const owed = await getOwedToOwners(a.owner);
  return owed.people.find((person) => person.id === userId);
}

/** The lines of the entry standing for a record, by account id. */
async function bookedLines(sourceType: 'EXPENSE' | 'OWNER_REIMBURSEMENT', sourceId: string) {
  const entry = await prisma.journalEntry.findFirstOrThrow({
    where: { organizationId: a.organizationId, sourceType, sourceId, reversals: { none: {} } },
    orderBy: { createdAt: 'desc' },
    include: { lines: true },
  });
  return entry.lines.map((line) => ({
    accountId: line.chartOfAccountId,
    debit: line.debitAmount.toString(),
    credit: line.creditAmount.toString(),
    memo: line.description,
  }));
}

before(async () => {
  a = await createTestOrg('OwnerPaid');
  await prisma.organization.update({
    where: { id: a.organizationId },
    data: { isVatRegistered: true },
  });
  // The owner really holds the built-in Owner role: that is who can pay personally.
  const role = await prisma.role.create({
    data: { organizationId: a.organizationId, name: `Owner ${RUN}`, isSystem: true },
  });
  await prisma.userRole.create({
    data: { organizationId: a.organizationId, userId: a.owner.id, roleId: role.id },
  });
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  ownerName = a.owner.fullName;
  partner = {
    ...a.owner,
    orgWidePermissions: new Set(ROLE_PRESETS.find((preset) => preset.key === 'partner')!.codes),
  };
});

after(async () => {
  await prisma.$disconnect();
});

describe('who can pay personally', () => {
  test('active holders of the Owner role, and nobody else', async () => {
    const payers = await listPersonalPayers(a.organizationId);
    assert.deepEqual(
      payers.map((payer) => payer.id),
      [a.owner.id],
    );
  });

  test('"Due to owner" is the 2520 account, carrying its role', async () => {
    const account = await prisma.chartOfAccount.findUniqueOrThrow({
      where: { id: roles.OWNER_ADVANCES },
    });
    assert.equal(account.accountCode, '2520');
    assert.equal(account.accountType, 'LIABILITY');
    // Running the chart again changes nothing.
    const again = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
    assert.equal(again.OWNER_ADVANCES, roles.OWNER_ADVANCES);
    assert.equal(
      await prisma.chartOfAccount.count({
        where: { organizationId: a.organizationId, accountCode: '2520' },
      }),
      1,
    );
  });
});

describe('an expense paid personally', () => {
  let expenseId: string;

  test('books Dr expense and Input VAT, Cr Due to owner, and the owner is owed 170.00', async () => {
    const expense = await recordExpense(a.owner, {
      description: `Brake discs ${RUN}`,
      amount: '161.90',
      taxRate: '5',
      expenseDate: today(),
      vendorName: 'Taimoor Auto Spare Parts',
      billNumber: 'TI/26/4512',
      supplierTrn: '104558747200001',
      paidByUserId: a.owner.id,
    });
    expenseId = expense.id;
    assert.equal(expense.paymentMethod, null);
    assert.equal(expense.paidByUserId, a.owner.id);

    const lines = await bookedLines('EXPENSE', expense.id);
    const line = (accountId: string) => lines.find((row) => row.accountId === accountId);
    assert.equal(line(roles.OTHER_EXPENSES)?.debit, '161.9');
    assert.equal(line(roles.VAT_INPUT)?.debit, '8.1');
    assert.equal(line(roles.OWNER_ADVANCES)?.credit, '170');
    assert.equal(line(roles.OWNER_ADVANCES)?.memo, `Paid personally by ${ownerName}`);
    assert.equal(lines.length, 3);

    const trial = await getTrialBalance(a.owner);
    assert.equal(trial.balanced, true);
    assert.equal(trial.totalDebit, trial.totalCredit);

    const owed = await owedTo(a.owner.id);
    assert.equal(owed?.owed, '170.00');
    assert.equal(owed?.lines[0].supplier, 'Taimoor Auto Spare Parts');
    assert.equal(owed?.lines[0].billNumber, 'TI/26/4512');
  });

  test('the VAT return claims its input VAT', async () => {
    const vat = await getVatReturn(a.owner, { period: 'month' });
    assert.equal(vat.registered, true);
    assert.equal(vat.boxes.expenseVat, '8.10');
    assert.equal(vat.boxes.inputVat, '8.10');
  });

  test('the audit log says who paid it', async () => {
    const log = await listAuditLog(a.owner, { module: 'expense' });
    const recorded = log.entries.find((entry) => entry.action === 'expense.recorded');
    assert.match(recorded?.sentence ?? '', new RegExp(`paid personally by ${ownerName}$`));
  });

  test('a method and a person together are refused, and so is someone who isn’t an owner', async () => {
    await expectDomainError(
      recordExpense(a.owner, {
        description: 'Both',
        amount: '10',
        expenseDate: today(),
        paymentMethod: 'CASH',
        paidByUserId: a.owner.id,
      }),
      /not both/,
    );
    await expectDomainError(
      recordExpense(a.owner, {
        description: 'Not an owner',
        amount: '10',
        expenseDate: today(),
        paidByUserId: a.viewer.id,
      }),
      /Choose an owner/,
    );
  });

  test('repaying clears it; more than is owed is refused; a reversal puts it back', async () => {
    await expectDomainError(
      reimburseOwner(a.owner, a.owner.id, {
        amount: '170.01',
        method: 'BANK_TRANSFER',
        paidOn: today(),
      }),
      /more than the 170\.00 owed/,
    );

    const repayment = await reimburseOwner(a.owner, a.owner.id, {
      amount: '170.00',
      method: 'BANK_TRANSFER',
      paidOn: today(),
      reference: 'FT-55120',
      note: 'Brake discs bill',
    });
    assert.equal(repayment.owedAfter, '0.00');
    assert.equal((await owedTo(a.owner.id))?.owed, '0.00');
    const lines = await bookedLines('OWNER_REIMBURSEMENT', repayment.id);
    assert.equal(lines.find((row) => row.accountId === roles.OWNER_ADVANCES)?.debit, '170');
    assert.equal(lines.find((row) => row.accountId === roles.BANK)?.credit, '170');

    await expectDomainError(
      reimburseOwner(a.owner, a.owner.id, { amount: '1', method: 'CASH', paidOn: today() }),
      /Nothing is owed/,
    );

    await reverseOwnerReimbursement(a.owner, repayment.id, { reason: 'Paid from the wrong bank' });
    assert.equal((await owedTo(a.owner.id))?.owed, '170.00', 'owed again after the reversal');
    await expectDomainError(
      reverseOwnerReimbursement(a.owner, repayment.id, { reason: 'Again' }),
      /already been reversed/,
    );
    assert.equal((await getTrialBalance(a.owner)).balanced, true);

    // Repaid for real this time.
    await reimburseOwner(a.owner, a.owner.id, { amount: '170', method: 'CASH', paidOn: today() });
    assert.equal((await owedTo(a.owner.id))?.owed, '0.00');
  });

  test('voiding the expense takes it off what is owed', async () => {
    const expense = await recordExpense(a.owner, {
      description: `Void me ${RUN}`,
      amount: '20',
      expenseDate: today(),
      paidByUserId: a.owner.id,
    });
    assert.equal((await owedTo(a.owner.id))?.owed, '20.00');
    await voidExpense(a.owner, expense.id, { reason: 'Entered twice' });
    assert.equal((await owedTo(a.owner.id))?.owed, '0.00');
  });

  test('changing a paid expense to "paid personally" moves the credit to Due to owner', async () => {
    const expense = await recordExpense(a.owner, {
      description: `Switch ${RUN}`,
      amount: '50',
      expenseDate: today(),
      paymentMethod: 'CASH',
    });
    await updateExpense(a.owner, expense.id, {
      description: `Switch ${RUN}`,
      amount: '50',
      expenseDate: today(),
      paidByUserId: a.owner.id,
    });
    const lines = await bookedLines('EXPENSE', expense.id);
    assert.equal(lines.find((row) => row.accountId === roles.OWNER_ADVANCES)?.credit, '50');
    assert.equal(
      lines.find((row) => row.accountId === roles.CASH),
      undefined,
    );
    assert.equal((await owedTo(a.owner.id))?.owed, '50.00');
    void expenseId;
  });
});

describe('card settlements are for customers only', () => {
  test('hidden from the lists for spending, kept for receipts', async () => {
    const spending = await getPaymentModeOptions(a.organizationId, 'spending');
    const receipts = await getPaymentModeOptions(a.organizationId, 'receipts');
    assert.ok(!spending.some((mode) => mode.accountId === roles.CARD_CLEARING));
    assert.ok(receipts.some((mode) => mode.accountId === roles.CARD_CLEARING));
    // Reimbursing an owner: cash or bank only.
    const reimburse = await getPaymentModeOptions(a.organizationId, 'reimburse');
    assert.ok(reimburse.length > 0);
    assert.ok(
      reimburse.every((mode) => mode.accountId === roles.CASH || mode.accountId === roles.BANK),
    );
  });

  test('a reimbursement from the card-settlement account is refused', async () => {
    await recordExpense(a.owner, {
      description: `Owed for card test ${RUN}`,
      amount: '5',
      expenseDate: today(),
      paidByUserId: a.owner.id,
    });
    await expectDomainError(
      reimburseOwner(a.owner, a.owner.id, { amount: '5', method: 'CARD', paidOn: today() }),
      /Card settlements are for customers/,
    );
    await reimburseOwner(a.owner, a.owner.id, { amount: '5', method: 'CASH', paidOn: today() });
  });

  test('an expense paid to the card-settlement account is refused', async () => {
    for (const input of [
      { paymentMethod: 'CARD' },
      { paymentMethod: 'CARD', paidFromAccountId: roles.CARD_CLEARING },
      { paymentMethod: 'BANK_TRANSFER', paidFromAccountId: roles.CARD_CLEARING },
    ]) {
      await expectDomainError(
        recordExpense(a.owner, {
          description: 'Card',
          amount: '10',
          expenseDate: today(),
          ...input,
        }),
        /Card settlements are for customers/,
      );
    }
    // The workshop's own card, on the bank account, is fine.
    const ok = await recordExpense(a.owner, {
      description: `Company card ${RUN}`,
      amount: '10',
      expenseDate: today(),
      paymentMethod: 'CARD',
      paidFromAccountId: roles.BANK,
    });
    assert.equal(ok.paidFromAccountId, roles.BANK);
  });
});

describe('who can see and repay', () => {
  test('Accounts → View alone sees the page but can’t reimburse', async () => {
    const reader = { ...a.owner, orgWidePermissions: new Set(['accounting.view']) };
    const owed = await getOwedToOwners(reader);
    assert.equal(owed.people[0].id, a.owner.id);
    await assert.rejects(
      reimburseOwner(reader, a.owner.id, { amount: '1', method: 'CASH', paidOn: today() }),
      isAuthError,
    );
  });

  test('a view-only user sees what is owed but can’t repay or reverse', async () => {
    await recordExpense(a.owner, {
      description: `Owed again ${RUN}`,
      amount: '30',
      expenseDate: today(),
      paidByUserId: a.owner.id,
    });
    const owed = await getOwedToOwners(partner);
    assert.ok(owed.people.some((person) => person.id === a.owner.id));
    await assert.rejects(
      reimburseOwner(partner, a.owner.id, { amount: '1', method: 'CASH', paidOn: today() }),
      isAuthError,
    );
    const repayment = await prisma.ownerReimbursement.findFirstOrThrow({
      where: { organizationId: a.organizationId, status: 'COMPLETED', reversalOfId: null },
    });
    await assert.rejects(
      reverseOwnerReimbursement(partner, repayment.id, { reason: 'Not allowed' }),
      isAuthError,
    );
    // Someone who can't see the accounts can't see this either.
    await assert.rejects(
      getOwedToOwners({ ...a.owner, orgWidePermissions: new Set(['expense.view']) }),
      isAuthError,
    );
  });
});
