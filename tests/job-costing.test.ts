/**
 * Integration tests for job costing, parts returned on credit notes, stock
 * counts and correcting a purchase to its tax invoice:
 *
 *  - a job's cost and profit: sales before VAT, parts at the line's cost,
 *    an expense filed against the job (its reclaimable VAT left out);
 *  - a cost filed against an invoice that bills a job card goes to the card;
 *  - a credit note bringing a part back: stock up, cost of sales down, the
 *    job's parts cost down; voiding it takes the part out again;
 *  - a stock count: stock corrected to what was counted, at cost, as one
 *    count; parts not counted untouched;
 *  - a tax invoice for more than recorded: refused, then corrected to the
 *    bill — the supplier owed the bill, its VAT claimed, the difference on
 *    cost of sales.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npx tsx --test tests/job-costing.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { ensureChart } from '@/lib/accounting/chart';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { createCreditNote, voidCreditNote } from '@/lib/billing/credit-notes';
import { recordExpense } from '@/lib/finance/expenses';
import { getJobCost } from '@/lib/finance/job-costing';
import { buyPartForJob } from '@/lib/inventory/quick-purchase';
import { matchBill } from '@/lib/inventory/bills';
import { postStockCount } from '@/lib/inventory/stock-count';
import { getStockOnHand } from '@/lib/inventory/stock';
import { purchaseBalance, PURCHASE_BALANCE_SELECT } from '@/lib/finance/supplier-balance';
import { toFils } from '@/lib/money';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;
let customerId: string;
let shopId: string;

before(async () => {
  a = await createTestOrg('Job costing', [
    { sku: `JC-PAD-${RUN}`, name: 'Brake pad set', cost: '60.00', price: '120.00', stock: '5' },
    { sku: `JC-OIL-${RUN}`, name: 'Engine oil 4L', cost: '50.00', price: '90.00', stock: '8' },
    { sku: `JC-BULB-${RUN}`, name: 'Headlight bulb', cost: '10.00', price: '25.00', stock: '20' },
  ]);
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  customerId = (
    await prisma.customer.create({
      data: { organizationId: a.organizationId, name: `Costing customer ${RUN}`, phone: '0500000001' },
    })
  ).id;
  shopId = (
    await prisma.supplier.create({ data: { organizationId: a.organizationId, name: `Parts shop ${RUN}` } })
  ).id;
});

after(async () => {
  await prisma.$disconnect();
});

const part = (key: string) => a.parts[`JC-${key}-${RUN}`].id;
const onHand = (partId: string) =>
  getStockOnHand(prisma, a.organizationId, a.branchId, partId).then((milli) => milli / 1000);

async function balanceOf(role: AccountRole) {
  const lines = await prisma.journalEntryLine.findMany({
    where: { organizationId: a.organizationId, chartOfAccountId: roles[role] },
    select: { debitAmount: true, creditAmount: true },
  });
  return lines.reduce(
    (sum, line) => sum + toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString()),
    0,
  );
}

describe('what a job cost and made', () => {
  let invoiceId: string;

  test('sales, parts at the line cost, and a cost filed against the job', async () => {
    ({ invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [
        {
          itemType: 'PART',
          description: 'Brake pads',
          quantity: '1',
          unitPrice: '120.00',
          vatTreatment: 'STANDARD',
          partId: part('PAD'),
          unitCost: '60.00',
        },
        {
          itemType: 'LABOUR',
          description: 'Fit pads',
          quantity: '1',
          unitPrice: '80.00',
          vatTreatment: 'STANDARD',
        },
      ],
    }));
    await recordExpense(a.owner, {
      description: 'Discs skimmed at machine shop',
      amount: '30.00',
      taxRate: '5',
      supplierTrn: '100123456700003',
      expenseDate: localDateString(),
      paymentMethod: 'CASH',
      forJob: `invoice:${invoiceId}`,
    });

    const cost = await getJobCost(a.owner, invoiceId);
    assert.ok(cost);
    assert.equal(cost.salesFils, 20000);
    assert.equal(cost.partsFils, 6000);
    // VAT-registered: the 1.50 VAT is reclaimed, not a cost.
    assert.equal(cost.otherFils, 3000);
    assert.equal(cost.profitFils, 11000);
    assert.equal(cost.margin, 55);
    assert.equal(cost.expenses.length, 1);
  });

  test('a part brought back on a credit note: back in stock, off the job’s cost', async () => {
    const cogsBefore = await balanceOf('COST_OF_PARTS');
    const stockBefore = await onHand(part('PAD'));
    const line = await prisma.invoiceItem.findFirstOrThrow({
      where: { invoiceId, partId: part('PAD') },
    });
    const note = await createCreditNote(a.owner, invoiceId, {
      reason: 'Wrong pads — returned',
      lines: [{ invoiceItemId: line.id, amount: '120.00', quantity: '1', restock: '1' }],
    });
    assert.equal(await onHand(part('PAD')), stockBefore + 1);
    assert.equal(cogsBefore - (await balanceOf('COST_OF_PARTS')), 6000);
    const cost = await getJobCost(a.owner, invoiceId);
    assert.equal(cost!.partsFils, 0);
    assert.equal(cost!.salesFils, 8000);

    await voidCreditNote(a.owner, note.creditNoteId, { reason: 'Issued by mistake' });
    assert.equal(await onHand(part('PAD')), stockBefore);
    assert.equal(await balanceOf('COST_OF_PARTS'), cogsBefore);
  });

  test('a line that did not sell from stock cannot go back into it', async () => {
    const labour = await prisma.invoiceItem.findFirstOrThrow({
      where: { invoiceId, itemType: 'LABOUR' },
    });
    await expectDomainError(
      createCreditNote(a.owner, invoiceId, {
        reason: 'Labour refund',
        lines: [{ invoiceItemId: labour.id, amount: '10.00', restock: '1' }],
      }),
      /was not sold from stock/,
    );
  });
});

describe('a stock count', () => {
  test('stock corrected to the count, at cost; parts not counted left alone', async () => {
    const adjustmentsBefore = await balanceOf('STOCK_ADJUSTMENTS');
    const bulbs = await onHand(part('BULB'));
    const result = await postStockCount(a.owner, {
      countedOn: localDateString(),
      counts: { [part('OIL')]: '6', [part('BULB')]: String(bulbs) },
    });
    assert.equal(result.counted, 2);
    assert.equal(result.corrected, 1);
    assert.equal(await onHand(part('OIL')), 6);
    assert.equal(await onHand(part('BULB')), bulbs);
    // Two oils short at 50.00 each: a loss on Inventory adjustments.
    assert.equal((await balanceOf('STOCK_ADJUSTMENTS')) - adjustmentsBefore, 10000);
    const movements = await prisma.inventoryTransaction.count({
      where: { stockCountId: result.stockCountId },
    });
    assert.equal(movements, 1);
  });
});

describe('a tax invoice for more than was recorded', () => {
  test('refused, then corrected to the bill', async () => {
    const bought = await buyPartForJob(a.owner, {
      partId: part('BULB'),
      supplierId: shopId,
      quantity: '2',
      unitCost: '10.00',
      taxRate: '5',
      paid: 'later',
    });
    const bill = {
      outcome: 'RECEIVED' as const,
      supplierInvoiceNumber: `DIFF-${RUN}`,
      billDate: localDateString(),
      receivedOn: localDateString(),
      subtotal: '24.00',
      taxAmount: '1.20',
      totalAmount: '25.20',
    };
    await expectDomainError(matchBill(a.owner, bought.purchaseId, bill), /doesn't agree/);
    await expectDomainError(
      matchBill(a.owner, bought.purchaseId, { ...bill, acceptDifference: '1' }),
      /Say why/,
    );
    const vatBefore = await balanceOf('VAT_INPUT');
    const cogsBefore = await balanceOf('COST_OF_PARTS');
    await matchBill(a.owner, bought.purchaseId, {
      ...bill,
      acceptDifference: '1',
      note: 'Price was 12.00 each, not 10.00',
    });

    const purchase = await prisma.purchase.findUniqueOrThrow({
      where: { id: bought.purchaseId },
      select: PURCHASE_BALANCE_SELECT,
    });
    assert.equal(purchaseBalance(purchase, '5.00').balance, '25.20');
    assert.equal((await balanceOf('VAT_INPUT')) - vatBefore, 120);
    assert.equal(await balanceOf('VAT_INPUT_PENDING'), 0);
    assert.equal((await balanceOf('COST_OF_PARTS')) - cogsBefore, 400);
  });
});
