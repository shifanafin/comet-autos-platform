/**
 * Integration tests for the general ledger (lib/accounting):
 *
 *  - every invoice, payment, reversal, correction, void and expense books
 *    itself, balanced, to the accounts the rules name — or the account
 *    chosen on the line or the payment;
 *  - while the period is open a correction changes the entry where it
 *    stands and a void removes it; nothing else may change or delete an
 *    entry (the database refuses);
 *  - entries are numbered without gaps in date order, whatever is added,
 *    back-dated or deleted;
 *  - the trial balance and balance sheet balance, and the profit and loss
 *    agrees with them;
 *  - closing the books refuses anything dated in the closed period;
 *  - entries made by hand must balance; while open they can be edited and
 *    deleted, any entry's narration can be corrected, and a reversal still
 *    works;
 *  - booking existing records is safe to run twice;
 *  - a VAT return, once filed, moves the period's VAT to what is due to the
 *    FTA, closes the period, and its refund clears it against the bank.
 *
 * Needs the 20260928090000_general_ledger and
 * 20261103090000_journal_corrections_in_place migrations applied.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { recordInvoicePayment } from '@/lib/billing/invoice';
import { reverseInvoicePayment, updateInvoice, voidInvoice } from '@/lib/billing/invoice-changes';
import { recordExpense, toExpenseDraft, updateExpense, voidExpense } from '@/lib/finance/expenses';
import { getVatReturn } from '@/lib/finance/vat';
import { ensureChart } from '@/lib/accounting/chart';
import {
  bookExistingRecords,
  countUnbooked,
  createManualEntry,
  deleteManualEntry,
  reverseManualEntry,
  updateEntryNarration,
  updateManualEntry,
} from '@/lib/accounting/entries';
import { closeBooks, reopenAllBooks } from '@/lib/accounting/periods';
import { getBalanceSheet, getLedgerProfitAndLoss, getTrialBalance } from '@/lib/accounting/reports';
import { fileVatReturn, listVatFilings, settleVatReturn } from '@/lib/accounting/vat-filing';
import { toFils } from '@/lib/money';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
/** Account ids by role, for reading the books. */
let roles: Record<AccountRole, string>;

before(async () => {
  a = await createTestOrg('Ledger', [
    { sku: 'LG-FILTER', name: 'Oil filter', cost: '20', price: '50', stock: '10' },
    { sku: 'LG-BATTERY', name: 'Scrap battery', cost: '5', price: '20', stock: '10' },
  ]);
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
});

after(async () => {
  await prisma.$disconnect();
});

const today = () => localDateString();
const daysAgo = (days: number) => localDateString(new Date(Date.now() - days * 86400000));
const now = () => toLocalDateTimeInput(new Date());

async function customer(suffix: string) {
  return prisma.customer.create({
    data: {
      organizationId: a.organizationId,
      name: `Ledger Customer ${suffix} ${RUN}`,
      phone: `050 ${suffix.padStart(3, '0')} 6644`,
    },
  });
}

/** The lines of the entries booking a record, as { account: net debit } in fils. */
async function bookedFor(sourceId: string) {
  const lines = await prisma.journalEntryLine.findMany({
    where: { organizationId: a.organizationId, journalEntry: { sourceId } },
    select: { chartOfAccountId: true, debitAmount: true, creditAmount: true },
  });
  const net = new Map<string, number>();
  for (const line of lines) {
    const value = toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString());
    net.set(line.chartOfAccountId, (net.get(line.chartOfAccountId) ?? 0) + value);
  }
  return net;
}

/** One entry's lines, as { account: net debit } in fils. */
async function bookedForEntry(journalEntryId: string) {
  const lines = await prisma.journalEntryLine.findMany({
    where: { journalEntryId },
    select: { chartOfAccountId: true, debitAmount: true, creditAmount: true },
  });
  const net = new Map<string, number>();
  for (const line of lines) {
    const value = toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString());
    net.set(line.chartOfAccountId, (net.get(line.chartOfAccountId) ?? 0) + value);
  }
  return net;
}

/** JV-000001, 2, 3… in date order, then in the order booked — no gaps. */
async function assertNumberedInDateOrder() {
  const entries = await prisma.journalEntry.findMany({
    where: { organizationId: a.organizationId },
    orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { entryNumber: true },
  });
  entries.forEach((entry, index) =>
    assert.equal(entry.entryNumber, `JV-${String(index + 1).padStart(6, '0')}`),
  );
}

/** Every entry balances: the database guarantees it; this checks it too. */
async function assertAllBalanced() {
  const entries = await prisma.journalEntry.findMany({
    where: { organizationId: a.organizationId },
    include: { lines: true },
  });
  for (const entry of entries) {
    const debit = entry.lines.reduce((s, l) => s + toFils(l.debitAmount.toString()), 0);
    const credit = entry.lines.reduce((s, l) => s + toFils(l.creditAmount.toString()), 0);
    assert.equal(debit, credit, `${entry.entryNumber} balances`);
  }
}

describe('invoices and payments book themselves', () => {
  test('a sales receipt: sales, discount and VAT, then the cash against receivables', async () => {
    const { id: customerId } = await customer('10');
    // Service 400 less 10% = 360; oil filter 2 × 50 = 100; bill discount AED 10.
    // Lines 460, discount 10, taxable 450, VAT 22.50, total 472.50.
    const { invoiceId, paymentId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [
        {
          itemType: 'LABOUR',
          description: 'Service',
          quantity: '1',
          unitPrice: '400',
          discountType: 'PERCENT',
          discount: '10',
        },
        {
          itemType: 'PART',
          description: 'Oil filter',
          quantity: '2',
          unitPrice: '50',
          partId: a.parts['LG-FILTER'].id,
          unitCost: '20',
        },
      ],
      discountType: 'AMOUNT',
      discount: '10',
      payNow: '1',
      paymentMethod: 'CASH',
    });

    const invoiceBooked = await bookedFor(invoiceId);
    assert.equal(invoiceBooked.get(roles.ACCOUNTS_RECEIVABLE), toFils('472.50'));
    assert.equal(invoiceBooked.get(roles.SALES_LABOUR), -toFils('360.00'));
    assert.equal(invoiceBooked.get(roles.SALES_PARTS), -toFils('100.00'));
    assert.equal(invoiceBooked.get(roles.SALES_DISCOUNTS), toFils('10.00'));
    assert.equal(invoiceBooked.get(roles.VAT_OUTPUT), -toFils('22.50'));
    // The filters leave stock at their cost: 2 × 20.00.
    assert.equal(invoiceBooked.get(roles.COST_OF_PARTS), toFils('40.00'));
    assert.equal(invoiceBooked.get(roles.INVENTORY), -toFils('40.00'));

    const paymentBooked = await bookedFor(paymentId!);
    assert.equal(paymentBooked.get(roles.CASH), toFils('472.50'));
    assert.equal(paymentBooked.get(roles.ACCOUNTS_RECEIVABLE), -toFils('472.50'));

    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    assert.ok(invoice.journalEntryId, 'the invoice points at its entry');
  });

  test('a line booked to the account chosen for it', async () => {
    const { id: customerId } = await customer('11');
    const otherIncome = await prisma.chartOfAccount.findFirstOrThrow({
      where: { organizationId: a.organizationId, accountCode: '4100' },
    });
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [
        {
          itemType: 'PART',
          description: 'Scrap battery',
          quantity: '1',
          unitPrice: '20',
          accountId: otherIncome.id,
          partId: a.parts['LG-BATTERY'].id,
        },
      ],
    });
    const booked = await bookedFor(invoiceId);
    assert.equal(booked.get(otherIncome.id), -toFils('20.00'));
    assert.equal(booked.get(roles.SALES_PARTS), undefined);

    // An expense account can't take a sale.
    const rent = await prisma.chartOfAccount.findFirstOrThrow({
      where: { organizationId: a.organizationId, accountCode: '5100' },
    });
    await expectDomainError(
      createDirectInvoice(a.owner, {
        customerId,
        items: [
          {
            itemType: 'PART',
            description: 'x',
            quantity: '1',
            unitPrice: '1',
            accountId: rent.id,
            partId: a.parts['LG-BATTERY'].id,
          },
        ],
      }),
      /income account/,
    );
  });

  test('a payment into a chosen account, reversed, leaves nothing behind', async () => {
    const { id: customerId } = await customer('12');
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'LABOUR', description: 'Diagnosis', quantity: '1', unitPrice: '100' }],
    });
    const payment = await recordInvoicePayment(a.owner, invoiceId, {
      amount: '105',
      method: 'CARD',
      receivedAt: now(),
      accountId: roles.BANK,
    });
    const booked = await bookedFor(payment.id);
    assert.equal(
      booked.get(roles.BANK),
      toFils('105.00'),
      'into the account chosen, not card clearing',
    );

    await reverseInvoicePayment(a.owner, payment.id, { reason: 'Wrong invoice' });
    const reversal = await prisma.payment.findFirstOrThrow({
      where: { reversalOfPaymentId: payment.id },
    });
    const back = await bookedFor(reversal.id);
    assert.equal(back.get(roles.BANK), -toFils('105.00'));
    assert.equal(back.get(roles.ACCOUNTS_RECEIVABLE), toFils('105.00'));
  });

  test('a correction changes the entry where it stands; a void removes it', async () => {
    const { id: customerId } = await customer('13');
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'LABOUR', description: 'Wash', quantity: '1', unitPrice: '50' }],
    });
    await updateInvoice(a.owner, invoiceId, {
      items: [
        { itemType: 'LABOUR', description: 'Wash and polish', quantity: '1', unitPrice: '80' },
      ],
    });
    const entries = await prisma.journalEntry.findMany({
      where: { organizationId: a.organizationId, sourceId: invoiceId },
      orderBy: { createdAt: 'asc' },
    });
    assert.equal(entries.length, 1, 'one entry, corrected in place — no reversal');
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    assert.equal(invoice.journalEntryId, entries[0].id);
    const corrected = await prisma.auditLog.findFirst({
      where: {
        organizationId: a.organizationId,
        action: 'journal.corrected',
        entityId: entries[0].id,
      },
    });
    assert.ok(corrected, 'the audit log keeps what the entry said before');
    const net = await bookedFor(invoiceId);
    assert.equal(
      net.get(roles.ACCOUNTS_RECEIVABLE),
      toFils('84.00'),
      'only the corrected figure stands',
    );

    // Outside the app's correction path, entries are still permanent.
    await assert.rejects(
      prisma.journalEntryLine.updateMany({
        where: { journalEntryId: entries[0].id },
        data: { debitAmount: '1.00' },
      }),
      /permanent/,
    );
    await assert.rejects(prisma.journalEntry.delete({ where: { id: entries[0].id } }), /permanent/);

    await voidInvoice(a.owner, invoiceId, { reason: 'Customer cancelled' });
    const afterVoid = await bookedFor(invoiceId);
    assert.ok(
      [...afterVoid.values()].every((value) => value === 0),
      'a void invoice leaves nothing',
    );
    assert.equal(
      await prisma.journalEntry.count({
        where: { organizationId: a.organizationId, sourceId: invoiceId },
      }),
      0,
      'its entry is removed, not reversed',
    );
    await assertNumberedInDateOrder();
  });
});

describe('expenses', () => {
  test('recorded and paid: category, recoverable VAT, the account paid from; voided: reversed', async () => {
    const expense = await recordExpense(a.owner, {
      description: `Workshop rent ${RUN}`,
      amount: '1000',
      taxRate: '5',
      supplierTrn: '100123456700003',
      expenseDate: today(),
      paymentMethod: 'BANK_TRANSFER',
    });
    const booked = await bookedFor(expense.id);
    assert.equal(booked.get(roles.OTHER_EXPENSES), toFils('1000.00'));
    assert.equal(booked.get(roles.VAT_INPUT), toFils('50.00'));
    assert.equal(booked.get(roles.BANK), -toFils('1050.00'));

    await voidExpense(a.owner, expense.id, { reason: 'Duplicate' });
    const afterVoid = await bookedFor(expense.id);
    assert.ok([...afterVoid.values()].every((value) => value === 0));
  });

  test('VAT without the supplier’s TRN waits, unclaimed, until the TRN is entered', async () => {
    const expense = await recordExpense(a.owner, {
      description: `Fuel ${RUN}`,
      amount: '100',
      taxRate: '5',
      expenseDate: today(),
      vendorName: 'ENOC',
      paymentMethod: 'CASH',
    });
    const waiting = await bookedFor(expense.id);
    assert.equal(waiting.get(roles.VAT_INPUT_PENDING), toFils('5.00'), 'awaiting tax invoice');
    assert.equal(waiting.get(roles.VAT_INPUT) ?? 0, 0, 'not claimed');
    const before = await getVatReturn(a.owner, { period: 'month' });
    assert.ok(before.awaitingTaxInvoice.expenses.some((row) => row.id === expense.id));
    assert.ok(!before.expenses.some((row) => row.id === expense.id), 'not in the return');

    const { id: _id, ...draft } = toExpenseDraft(expense);
    void _id;
    await updateExpense(a.owner, expense.id, { ...draft, supplierTrn: '100058294300003' });
    const claimed = await bookedFor(expense.id);
    assert.equal(claimed.get(roles.VAT_INPUT), toFils('5.00'), 'claimed once the TRN is in');
    assert.equal(claimed.get(roles.VAT_INPUT_PENDING) ?? 0, 0);
    const after = await getVatReturn(a.owner, { period: 'month' });
    assert.ok(after.expenses.some((row) => row.id === expense.id));
    assert.equal(
      toFils(after.boxes.expenseVat) - toFils(before.boxes.expenseVat),
      toFils('5.00'),
    );

    await voidExpense(a.owner, expense.id, { reason: 'Test' });
  });
});

describe('the statements', () => {
  test('the trial balance and balance sheet balance, and agree with the profit and loss', async () => {
    await assertAllBalanced();
    const trial = await getTrialBalance(a.owner);
    assert.equal(trial.balanced, true);
    assert.equal(trial.totalDebit, trial.totalCredit);

    const sheet = await getBalanceSheet(a.owner);
    assert.equal(sheet.balanced, true);

    const profit = await getLedgerProfitAndLoss(a.owner, { period: 'year' });
    // Everything so far is dated this year, so this year's profit is all the profit to date.
    assert.equal(profit.netProfit, sheet.equity.earnings);
  });
});

describe('entries made by hand', () => {
  test('must balance, and are corrected by reversal', async () => {
    await expectDomainError(
      createManualEntry(a.owner, {
        date: today(),
        description: "Owner's capital",
        lines: [
          { accountId: roles.BANK, debit: '5000' },
          { accountId: roles.OPENING_BALANCE, credit: '4999' },
        ],
      }),
      /does not balance/,
    );
    const entry = await createManualEntry(a.owner, {
      date: today(),
      description: "Owner's capital paid into the bank",
      lines: [
        { accountId: roles.BANK, debit: '5000' },
        { accountId: roles.OPENING_BALANCE, credit: '5000', memo: 'Opening' },
      ],
    });
    assert.match(entry.entryNumber ?? '', /^JV-/);
    const reversal = await reverseManualEntry(a.owner, entry.id, {
      date: today(),
      reason: 'Wrong account',
    });
    assert.equal(reversal.reversalOfJournalEntryId, entry.id);
    await expectDomainError(
      reverseManualEntry(a.owner, entry.id, { date: today(), reason: 'Again' }),
      /Already reversed/,
    );
    // A reversed entry can't be edited; deleting it takes its reversal too.
    await expectDomainError(
      updateManualEntry(a.owner, entry.id, {
        date: today(),
        description: "Owner's capital",
        lines: [
          { accountId: roles.BANK, debit: '50' },
          { accountId: roles.OPENING_BALANCE, credit: '50' },
        ],
      }),
      /reversed by/,
    );
    const removed = await deleteManualEntry(a.owner, entry.id, { reason: 'Never happened' });
    assert.equal(removed.deleted, 2);
    assert.equal(
      await prisma.journalEntry.count({ where: { id: { in: [entry.id, reversal.id] } } }),
      0,
    );
    await assertNumberedInDateOrder();
  });

  test('are edited where they stand, deleted without a gap, and back-dated in order', async () => {
    const entry = await createManualEntry(a.owner, {
      date: today(),
      description: `Bank charges ${RUN}`,
      lines: [
        { accountId: roles.BANK_CHARGES, debit: '25' },
        { accountId: roles.BANK, credit: '25' },
      ],
    });
    const edited = await updateManualEntry(a.owner, entry.id, {
      date: today(),
      description: `Bank charges for the month ${RUN}`,
      reason: 'Charged 30, not 25',
      lines: [
        { accountId: roles.BANK_CHARGES, debit: '30' },
        { accountId: roles.BANK, credit: '30' },
      ],
    });
    assert.equal(edited.id, entry.id, 'the same entry');
    assert.equal(edited.entryNumber, entry.entryNumber, 'the same number');
    assert.equal((await bookedForEntry(entry.id)).get(roles.BANK_CHARGES), toFils('30.00'));

    // Narration on an entry booked from a record: the words change, no figure does.
    const { id: customerId } = await customer('31');
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'LABOUR', description: 'Check-up', quantity: '1', unitPrice: '100' }],
    });
    const invoiceEntry = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: a.organizationId, sourceId: invoiceId },
      include: { lines: true },
    });
    await expectDomainError(
      updateManualEntry(a.owner, invoiceEntry.id, {
        date: today(),
        description: 'Changed',
        lines: [
          { accountId: roles.BANK, debit: '1' },
          { accountId: roles.OPENING_BALANCE, credit: '1' },
        ],
      }),
      /booked from a record/,
    );
    const firstLine = invoiceEntry.lines[0].id;
    await updateEntryNarration(a.owner, invoiceEntry.id, {
      description: `Check-up invoice ${RUN}`,
      notes: [{ lineId: firstLine, memo: 'Annual check-up' }],
    });
    const renamed = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: invoiceEntry.id },
      include: { lines: true },
    });
    assert.equal(renamed.description, `Check-up invoice ${RUN}`);
    assert.equal(
      renamed.lines.find((line) => line.id === firstLine)?.description,
      'Annual check-up',
    );

    // Back-dated: it takes its place in date order; every later entry moves down one.
    const earlier = await createManualEntry(a.owner, {
      date: daysAgo(400),
      description: `Owner's capital, last year ${RUN}`,
      lines: [
        { accountId: roles.BANK, debit: '100' },
        { accountId: roles.OPENING_BALANCE, credit: '100' },
      ],
    });
    assert.equal(earlier.entryNumber, 'JV-000001', 'the oldest entry is the first');
    await assertNumberedInDateOrder();

    // Deleted: the entries after it move up, and the counter follows.
    await deleteManualEntry(a.owner, earlier.id, { reason: 'Entered in the wrong workshop' });
    await assertNumberedInDateOrder();
    const count = await prisma.journalEntry.count({ where: { organizationId: a.organizationId } });
    const counter = await prisma.documentNumberSequence.findFirstOrThrow({
      where: { organizationId: a.organizationId, documentType: 'JOURNAL_ENTRY', branchId: null },
    });
    assert.equal(counter.nextNumber, count + 1, 'the next number follows the last: no gap');
    const deleted = await prisma.auditLog.findFirst({
      where: { organizationId: a.organizationId, action: 'journal.deleted', entityId: earlier.id },
    });
    assert.ok(deleted, 'the audit log keeps what was deleted');
  });

  test('in a closed period: only the narration changes, never the figures', async () => {
    const entry = await createManualEntry(a.owner, {
      date: daysAgo(3),
      description: `Cash float ${RUN}`,
      lines: [
        { accountId: roles.CASH, debit: '200' },
        { accountId: roles.BANK, credit: '200' },
      ],
    });
    await closeBooks(a.owner, { through: daysAgo(2) });
    try {
      await expectDomainError(
        updateManualEntry(a.owner, entry.id, {
          date: daysAgo(3),
          description: 'Changed',
          lines: [
            { accountId: roles.CASH, debit: '150' },
            { accountId: roles.BANK, credit: '150' },
          ],
        }),
        /period is closed/,
      );
      await expectDomainError(
        deleteManualEntry(a.owner, entry.id, { reason: 'Try' }),
        /period is closed/,
      );
      await updateEntryNarration(a.owner, entry.id, {
        description: `Cash float drawn from the bank ${RUN}`,
      });
    } finally {
      await reopenAllBooks(a.owner, { reason: 'Test finished' });
    }
  });
});

describe('closing the books', () => {
  test('refuses anything dated in the closed period, until reopened', async () => {
    await closeBooks(a.owner, { through: daysAgo(1) });
    await expectDomainError(
      recordExpense(a.owner, {
        description: `Late receipt ${RUN}`,
        amount: '10',
        expenseDate: daysAgo(2),
        paymentMethod: 'CASH',
      }),
      /books are closed/,
    );
    // Today is still open.
    await recordExpense(a.owner, {
      description: `Today's receipt ${RUN}`,
      amount: '10',
      expenseDate: today(),
      paymentMethod: 'CASH',
    });
    await reopenAllBooks(a.owner, { reason: 'Test finished' });
  });
});

describe('booking existing records', () => {
  test('books nothing twice', async () => {
    const first = await bookExistingRecords(a.owner);
    assert.deepEqual(first.failed, []);
    assert.equal(await countUnbooked(a.owner), 0);
    const second = await bookExistingRecords(a.owner);
    assert.equal(second.booked, 0);
  });
});

describe('VAT returns', () => {
  test('filed: VAT moved to what is due to the FTA, the period closed; refunded: cleared', async () => {
    // A past period with only a purchase's VAT in it: a refund is due.
    const from = daysAgo(40);
    const to = daysAgo(31);
    await recordExpense(a.owner, {
      description: `Diagnostic tool ${RUN}`,
      amount: '2000',
      taxRate: '5',
      supplierTrn: '100123456700003',
      expenseDate: daysAgo(35),
      paymentMethod: 'BANK_TRANSFER',
    });
    const filing = await fileVatReturn(a.owner, {
      from,
      to,
      filedOn: daysAgo(10),
      ftaReference: `VAT-${RUN}`,
    });
    assert.equal(filing.inputVat.toString(), '100');
    assert.equal(filing.netVat.toString(), '-100');
    const booked = await bookedFor(filing.id);
    assert.equal(booked.get(roles.VAT_INPUT), -toFils('100.00'));
    assert.equal(booked.get(roles.VAT_SETTLEMENT), toFils('100.00'), 'the FTA owes the refund');

    const organization = await prisma.organization.findUniqueOrThrow({
      where: { id: a.organizationId },
    });
    assert.equal(organization.booksClosedThrough?.toISOString().slice(0, 10), to);
    await expectDomainError(
      fileVatReturn(a.owner, { from, to, filedOn: daysAgo(9) }),
      /already filed/,
    );

    await settleVatReturn(a.owner, filing.id, { settledOn: daysAgo(5) });
    const settled = await bookedFor(filing.id);
    assert.equal(settled.get(roles.VAT_SETTLEMENT), 0);
    assert.equal(settled.get(roles.BANK), toFils('100.00'));
    const [listed] = await listVatFilings(a.owner);
    assert.equal(listed.state, 'REFUNDED');

    await reopenAllBooks(a.owner, { reason: 'Test finished' });
    await assertAllBalanced();
    await assertNumberedInDateOrder();
  });
});
