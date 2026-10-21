/**
 * Integration tests for payment vouchers (lib/finance/payment-vouchers.ts)
 * and the bank's charges on a card settlement (lib/finance/money.ts):
 *
 *  - card money collected for someone and paid over at once books
 *    Dr Card settlements / Cr Money collected for others, then
 *    Dr Money collected for others / Cr Cash (what was handed over),
 *    Cr Bank charges (the fee), Cr Input VAT (its VAT);
 *  - collected now and paid later: owed to them until paid;
 *  - the bank paying the card money in, less its fee, clears Card
 *    settlements exactly; with the voucher, the fee and its VAT net to
 *    nothing — and the VAT return agrees with the books;
 *  - a void reverses everything it booked;
 *  - outside work is an expense — voided with its voucher, never apart;
 *  - impossible figures, paying out of the card settlements and looking-only
 *    users are refused.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { ensureChart } from '@/lib/accounting/chart';
import { countUnbooked } from '@/lib/accounting/entries';
import { recordMoneyTransfer } from '@/lib/finance/money';
import { getVatReturn } from '@/lib/finance/vat';
import { toExpenseDraft, updateExpense, voidExpense } from '@/lib/finance/expenses';
import {
  getPaymentVoucher,
  listPaymentVouchers,
  payCardCollection,
  recordCardCollection,
  recordWorkPayment,
  voidPaymentVoucher,
} from '@/lib/finance/payment-vouchers';
import { getPaymentVoucherDocument } from '@/lib/documents/payment-voucher';
import { filsToString, toFils } from '@/lib/money';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;

before(async () => {
  a = await createTestOrg('Vouchers');
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
});

after(async () => {
  await prisma.$disconnect();
});

const today = () => localDateString();
const yesterday = () => localDateString(new Date(Date.now() - 86_400_000));

/** An account's balance in fils, debit positive. */
async function balanceOf(accountId: string) {
  const sums = await prisma.journalEntryLine.aggregate({
    where: { organizationId: a.organizationId, chartOfAccountId: accountId },
    _sum: { debitAmount: true, creditAmount: true },
  });
  return (
    toFils(sums._sum.debitAmount?.toString() ?? '0') -
    toFils(sums._sum.creditAmount?.toString() ?? '0')
  );
}

/** The balances these tests move, in fils. */
async function balances() {
  const [card, held, cash, bank, charges, vatIn] = await Promise.all([
    balanceOf(roles.CARD_CLEARING),
    balanceOf(roles.MONEY_HELD_FOR_OTHERS),
    balanceOf(roles.CASH),
    balanceOf(roles.BANK),
    balanceOf(roles.BANK_CHARGES),
    balanceOf(roles.VAT_INPUT),
  ]);
  return { card, held, cash, bank, charges, vatIn };
}

const collection = (extra: Record<string, string> = {}) => ({
  payeeName: 'Al Noor Upholstery',
  payeePhone: '050 000 0000',
  description: 'Seat covers — their customer paid on our machine',
  collectedOn: today(),
  collectedAmount: '1000.00',
  cardReference: 'APP-123',
  ...extra,
});

const payOver = (extra: Record<string, string> = {}) => ({
  paidOn: today(),
  feeRate: '2',
  paymentMethod: 'CASH',
  ...extra,
});

describe('card money collected for someone', () => {
  test('paid over at once: the fee and its VAT come off what is handed over', async () => {
    const before = await balances();
    const voucher = await recordCardCollection(a.owner, {
      ...collection(),
      payNow: 'now',
      ...payOver(),
    });
    assert.match(voucher.voucherNumber, /^PV-/);
    const stored = await getPaymentVoucher(a.owner, voucher.id);
    assert.equal(stored.status, 'PAID');
    assert.equal(stored.amount?.toString(), '979');
    assert.equal(stored.feeAmount.toString(), '20');
    assert.equal(stored.feeVatAmount.toString(), '1');

    const after = await balances();
    assert.equal(after.card - before.card, 100_000, 'the card money is in the card account');
    assert.equal(after.held - before.held, 0, 'collected and paid over: nothing still owed');
    assert.equal(after.cash - before.cash, -97_900, '979.00 handed over in cash');
    assert.equal(after.charges - before.charges, -2_000, 'the fee recovered from them');
    assert.equal(after.vatIn - before.vatIn, -100, 'its VAT is not the workshop’s to reclaim');

    const document = await getPaymentVoucherDocument(a.owner, voucher.id);
    assert.equal(document.kind, 'PAYMENT_VOUCHER');
    assert.equal(document.highlight?.amount, '979');
    assert.ok(
      document.details.some((field) => field.value === 'UAE Dirhams Nine Hundred Seventy-Nine Only'),
    );
  });

  test('collected now and paid later: owed to them until it is', async () => {
    const voucher = await recordCardCollection(a.owner, {
      ...collection({ collectedAmount: '500.00', payeeName: 'Rashid Upholstery' }),
    });
    const owedBefore = await balanceOf(roles.MONEY_HELD_FOR_OTHERS);
    assert.equal((await getPaymentVoucher(a.owner, voucher.id)).status, 'OWED');
    const list = await listPaymentVouchers(a.owner);
    assert.ok(list.owed.some((row) => row.id === voucher.id));

    await payCardCollection(a.owner, voucher.id, payOver({ feeRate: '', feeAmount: '10.00' }));
    const paid = await getPaymentVoucher(a.owner, voucher.id);
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.feeVatAmount.toString(), '0.5', 'VAT worked out on the typed fee');
    assert.equal(paid.amount?.toString(), '489.5');
    assert.equal(
      (await balanceOf(roles.MONEY_HELD_FOR_OTHERS)) - owedBefore,
      50_000,
      'no longer owed once paid over',
    );
    await expectDomainError(
      payCardCollection(a.owner, voucher.id, payOver()),
      /already been paid/,
    );
  });

  test('the bank paying it in, less its fee: card settlements clear, the fee nets to nothing', async () => {
    const before = await balances();
    await recordCardCollection(a.owner, { ...collection(), payNow: 'now', ...payOver() });
    await recordMoneyTransfer(a.owner, {
      fromAccountId: roles.CARD_CLEARING,
      toAccountId: roles.BANK,
      amount: '979.00',
      chargesAmount: '20.00',
      chargesVatAmount: '1.00',
      transferredOn: today(),
    });
    const after = await balances();
    assert.equal(after.card - before.card, 0, 'card settlements cleared to the fil');
    assert.equal(after.bank - before.bank, 97_900, 'what arrived in the bank');
    assert.equal(after.charges - before.charges, 0, 'their fee cost the workshop nothing');
    assert.equal(after.vatIn - before.vatIn, 0, 'and its VAT nets to nothing');

    const vat = await getVatReturn(a.owner, { period: 'month' });
    const ledgerVat = await balanceOf(roles.VAT_INPUT);
    // Signed: VAT recovered on bank fees can leave input VAT below zero.
    assert.equal(vat.boxes.inputVat, filsToString(ledgerVat), 'the VAT return agrees with the books');
    assert.ok(vat.bankCharges.some((row) => row.vat === '1.00'));
    assert.ok(vat.bankCharges.some((row) => row.vat === '-1.00'));
  });

  test('a void reverses the collection and the payment', async () => {
    const before = await balances();
    const voucher = await recordCardCollection(a.owner, {
      ...collection({ collectedAmount: '300.00' }),
      payNow: 'now',
      ...payOver(),
    });
    await voidPaymentVoucher(a.owner, voucher.id, { reason: 'Entered twice.' });
    assert.deepEqual(await balances(), before, 'every balance back where it was');
    assert.equal((await getPaymentVoucher(a.owner, voucher.id)).status, 'VOID');
    await expectDomainError(
      voidPaymentVoucher(a.owner, voucher.id, { reason: 'Again.' }),
      /already void/,
    );
  });

  test('impossible figures and paying out of the card settlements are refused', async () => {
    await expectDomainError(
      recordCardCollection(a.owner, {
        ...collection({ collectedAmount: '10.00' }),
        payNow: 'now',
        ...payOver({ feeRate: '', feeAmount: '10.00' }),
      }),
      /whole amount/,
    );
    await expectDomainError(
      recordCardCollection(a.owner, {
        ...collection(),
        payNow: 'now',
        ...payOver({ paidOn: yesterday() }),
      }),
      /before the card payment/,
    );
    await expectDomainError(
      recordCardCollection(a.owner, {
        ...collection(),
        payNow: 'now',
        ...payOver({ paymentMethod: 'CARD' }),
      }),
      /Card settlements/,
    );
  });
});

describe('outside work', () => {
  test('is an expense, booked to sublet repairs and voided with its voucher', async () => {
    const sublet = await prisma.chartOfAccount.findFirstOrThrow({
      where: { organizationId: a.organizationId, accountCode: '5020' },
    });
    const cashBefore = await balanceOf(roles.CASH);
    const voucher = await recordWorkPayment(a.owner, {
      payeeName: 'Saleem (outside mechanic)',
      description: 'Gearbox overhaul',
      amount: '350.00',
      paidOn: today(),
      categoryId: sublet.id,
      paymentMethod: 'CASH',
    });
    const stored = await getPaymentVoucher(a.owner, voucher.id);
    assert.equal(stored.kind, 'WORK');
    assert.ok(stored.expense, 'its expense');
    assert.equal(await balanceOf(sublet.id), 35_000, 'a cost of sales');
    assert.equal((await balanceOf(roles.CASH)) - cashBefore, -35_000);

    const expenseId = stored.expense!.id;
    await expectDomainError(voidExpense(a.owner, expenseId, { reason: 'Mistake.' }), /payment voucher/);
    await expectDomainError(
      updateExpense(a.owner, expenseId, {
        description: 'Changed',
        amount: '300.00',
        expenseDate: today(),
        paymentMethod: 'CASH',
      }),
      /payment voucher/,
    );
    // The supplier's tax invoice, arriving later: its details may be filled in.
    const { id: _id, ...draft } = toExpenseDraft(
      await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } }),
    );
    void _id;
    await updateExpense(a.owner, expenseId, {
      ...draft,
      supplierTrn: '100367364500003',
      billNumber: 'TI-34499',
      notes: 'Tax invoice received.',
    });
    const filled = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    assert.equal(filled.supplierTrn, '100367364500003');
    assert.equal(filled.billNumber, 'TI-34499');
    assert.equal(await balanceOf(sublet.id), 35_000, 'the money as it was');

    await voidPaymentVoucher(a.owner, voucher.id, { reason: 'Wrong mechanic.' });
    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    assert.equal(expense.status, 'VOID', 'voided with the voucher');
    assert.equal(await balanceOf(sublet.id), 0);
    assert.equal(await balanceOf(roles.CASH), cashBefore);
  });
});

describe('the rules around vouchers', () => {
  test('everything recorded is in the books', async () => {
    assert.equal(await countUnbooked(a.owner), 0);
  });

  test('someone who may only look cannot pay anyone', async () => {
    await assert.rejects(
      recordCardCollection(a.viewer, { ...collection(), payNow: 'now', ...payOver() }),
      AuthError,
    );
    const looker = { ...a.owner, orgWidePermissions: new Set(['payment_voucher.view']) };
    await assert.rejects(
      recordWorkPayment(looker, {
        payeeName: 'Someone',
        description: 'Work',
        amount: '10.00',
        paidOn: today(),
        paymentMethod: 'CASH',
      }),
      AuthError,
    );
    await listPaymentVouchers(looker);
  });
});
