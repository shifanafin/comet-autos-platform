/**
 * Integration tests for reconciling from an uploaded bank statement:
 *
 *  - the statement's lines are kept, and the ones in the books are matched
 *    and ticked at once; a bank charge not in the books is left open;
 *  - once the charge is recorded, matching again finds it, the difference
 *    is nil and the reconciliation completes;
 *  - a statement line can be unmatched and matched again by hand, but only
 *    to lines that come to its amount;
 *  - the account remembers how its file was read;
 *  - discarding removes the statement with the reconciliation.
 *
 * Every record is made in a throwaway test organization. Needs the
 * 20261102120000_bank_statement_lines migration applied.
 *
 *   npx tsx --test tests/statement-upload.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { recordInvoicePayment } from '@/lib/billing/invoice';
import { recordExpense } from '@/lib/finance/expenses';
import { ensureChart } from '@/lib/accounting/chart';
import { bookExistingRecords } from '@/lib/accounting/entries';
import {
  completeReconciliation,
  discardReconciliation,
  getReconciliation,
} from '@/lib/accounting/reconciliation';
import {
  getStatementView,
  matchStatementLine,
  rematchStatement,
  unmatchStatementLine,
  uploadStatement,
} from '@/lib/accounting/statement-import';
import { guessColumns, savedColumns } from '@/lib/accounting/statement-file';
import { parseCsvRows } from '@/lib/data-transfer/csv';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;

before(async () => {
  a = await createTestOrg('Statements');
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  await bookExistingRecords(a.owner);
});

after(async () => {
  await prisma.$disconnect();
});

const today = () => localDateString();
/** Today as the bank writes it: 14/10/2026. */
const bankDate = () => today().split('-').reverse().join('/');

async function paidByTransfer(suffix: string, price: string) {
  const customer = await prisma.customer.create({
    data: {
      organizationId: a.organizationId,
      name: `Statement Customer ${suffix} ${RUN}`,
      phone: `050 ${suffix.padStart(3, '0')} 8866`,
    },
  });
  const { invoiceId } = await createDirectInvoice(a.owner, {
    customerId: customer.id,
    items: [{ itemType: 'LABOUR', description: 'Service', quantity: '1', unitPrice: price }],
  });
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
  await recordInvoicePayment(a.owner, invoiceId, {
    amount: invoice.totalAmount.toString(),
    method: 'BANK_TRANSFER',
    receivedAt: toLocalDateTimeInput(new Date()),
    accountId: roles.BANK,
  });
  return invoice.totalAmount.toString();
}

describe('reconciling from an uploaded statement', () => {
  test('matches what is in the books, finds a charge once recorded, and completes', async () => {
    // 200 + VAT = 210.00, and 100 + VAT = 105.00, both into the bank.
    const first = await paidByTransfer('61', '200');
    const second = await paidByTransfer('62', '100');
    assert.equal(first, '210');
    assert.equal(second, '105');

    // The bank's statement: the two transfers, and a charge the books don't have.
    const csv = [
      'Account Statement',
      'Account,XXXX0001',
      '',
      'Transaction Date,Description,Debit,Credit,Balance',
      `${bankDate()},TRANSFER IN,,210.00,210.00`,
      `${bankDate()},TRANSFER IN,,105.00,315.00`,
      `${bankDate()},BANK CHARGES,10.50,,304.50`,
    ].join('\n');
    const grid = parseCsvRows(csv);
    const columns = guessColumns(grid)!;

    const uploaded = await uploadStatement(a.owner, {
      accountId: roles.BANK,
      fileName: 'october.csv',
      grid,
      columns,
    });
    assert.equal(uploaded.lines, 3);
    assert.equal(uploaded.matched, 2, 'both transfers are matched at once');
    const { reconciliationId } = uploaded;

    let view = (await getStatementView(a.owner, reconciliationId))!;
    assert.equal(view.rows.length, 3, 'opening 0: no brought-forward line');
    assert.equal(view.matched, 2);
    assert.deepEqual(view.checks, [], 'the lines add up to the closing balance');
    const charge = view.rows.find((row) => row.description === 'BANK CHARGES')!;
    assert.equal(charge.status, 'open');
    let detail = await getReconciliation(a.owner, reconciliationId);
    assert.equal(detail.statementBalance, '304.50');
    assert.equal(detail.difference, '-10.50', 'the charge is the difference');
    await expectDomainError(completeReconciliation(a.owner, reconciliationId), /difference/);

    // Remembered on the account for next month.
    const account = await prisma.chartOfAccount.findUniqueOrThrow({ where: { id: roles.BANK } });
    assert.deepEqual(savedColumns(account.statementColumns), columns);

    // A transfer can be unmatched, and not matched to the wrong amount.
    const transfer = view.rows.find((row) => row.amount === '105.00')!;
    await unmatchStatementLine(a.owner, reconciliationId, transfer.id);
    detail = await getReconciliation(a.owner, reconciliationId);
    const transferLine = detail.rows.find((row) => row.moneyIn === '105.00')!;
    const otherLine = detail.rows.find((row) => row.moneyIn === '210.00')!;
    assert.equal(transferLine.ticked, false, 'unmatching unticks it');
    await expectDomainError(
      matchStatementLine(a.owner, reconciliationId, {
        statementLineId: transfer.id,
        bookLineIds: [otherLine.id],
      }),
      /already matched|come to/,
    );
    await matchStatementLine(a.owner, reconciliationId, {
      statementLineId: transfer.id,
      bookLineIds: [transferLine.id],
    });

    // The charge, recorded as paid from the bank, is found on matching again.
    await recordExpense(a.owner, {
      description: `Bank charges ${RUN}`,
      amount: '10.50',
      taxRate: '0',
      expenseDate: today(),
      paymentMethod: 'BANK_TRANSFER',
      paidFromAccountId: roles.BANK,
    });
    const { matched } = await rematchStatement(a.owner, reconciliationId);
    assert.equal(matched, 1);
    view = (await getStatementView(a.owner, reconciliationId))!;
    assert.equal(view.open, 0);
    detail = await getReconciliation(a.owner, reconciliationId);
    assert.equal(detail.differenceFils, 0);
    await completeReconciliation(a.owner, reconciliationId);
  });

  test('a second upload of the same days is refused, and a discard takes its lines', async () => {
    const csv = `Date,Description,Debit,Credit,Balance\n${bankDate()},TRANSFER IN,,1.00,1.00\n`;
    const grid = parseCsvRows(csv);
    await expectDomainError(
      uploadStatement(a.owner, {
        accountId: roles.BANK,
        fileName: 'again.csv',
        grid,
        columns: guessColumns(grid)!,
      }),
      /already reconciled/,
    );

    // A card account, never reconciled: uploaded, then discarded.
    const card = await prisma.chartOfAccount.findFirstOrThrow({
      where: { organizationId: a.organizationId, isPaymentAccount: true, id: { not: roles.BANK } },
    });
    const { reconciliationId } = await uploadStatement(a.owner, {
      accountId: card.id,
      fileName: 'card.csv',
      grid,
      columns: guessColumns(grid)!,
    });
    assert.ok(await getStatementView(a.owner, reconciliationId));
    await discardReconciliation(a.owner, reconciliationId);
    const left = await prisma.bankStatementLine.count({ where: { reconciliationId } });
    assert.equal(left, 0);
  });
});
