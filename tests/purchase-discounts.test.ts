/**
 * Integration tests for purchase discounts and paying on receipt (Step 4):
 *
 *  - a discounted purchase (line and bill discounts) received in two
 *    deliveries and paid in two parts as the goods came in: totals, VAT,
 *    stock, stock value, input VAT, trade payables, supplier payments, the
 *    supplier statement, Suppliers owed, the VAT return, the balance sheet
 *    and P&L — and the deliveries add up to the bill exactly, to the fil;
 *  - pay later with a due date: nothing paid, aged from the due date;
 *  - a return on a discounted line comes off at exactly what it was booked;
 *  - the optional cost-price update, off unless ticked;
 *  - paying on receipt needs the supplier-payment right; pay later doesn't;
 *  - a purchase with no discount is valued, posted and reported exactly as
 *    before discounts existed.
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
import { getBalanceSheet, getLedgerProfitAndLoss } from '@/lib/accounting/reports';
import {
  createPurchase,
  getPurchaseDetail,
  receivePurchase,
  updatePurchaseDetails,
} from '@/lib/inventory/purchases';
import { getStockOnHand, postMovement } from '@/lib/inventory/stock';
import { getPayables } from '@/lib/finance/supplier-payments';
import { getSupplierStatement } from '@/lib/finance/statements';
import { getVatReturn } from '@/lib/finance/vat';
import { importCsv } from '@/lib/data-transfer/imports';
import { mergeSuppliers } from '@/lib/inventory/supplier-merge';
import { calculateLine, filsToString, toFils } from '@/lib/money';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;

before(async () => {
  a = await createTestOrg('Purchase discounts', [
    { sku: `PD-A-${RUN}`, name: 'Brake disc', cost: '100.00', price: '150.00', stock: '0' },
    { sku: `PD-B-${RUN}`, name: 'Clip', cost: '33.33', price: '50.00', stock: '0' },
    { sku: `PD-C-${RUN}`, name: 'Filter', cost: '20.00', price: '30.00', stock: '0' },
    { sku: `PD-D-${RUN}`, name: 'Bulb', cost: '33.33', price: '45.00', stock: '0' },
    { sku: `PD-E-${RUN}`, name: 'Wiper', cost: '25.00', price: '40.00', stock: '0' },
  ]);
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
});

after(async () => {
  await prisma.$disconnect();
});

const part = (letter: string) => a.parts[`PD-${letter}-${RUN}`].id;
const daysAgo = (days: number) => localDateString(new Date(Date.now() - days * 86_400_000));

async function supplier(name: string) {
  return prisma.supplier.create({
    data: { organizationId: a.organizationId, name: `${name} ${RUN}` },
  });
}

const itemsOf = (purchaseId: string) =>
  prisma.purchaseItem.findMany({
    where: { purchaseId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

/** Net debit per account, in fils, over the stock movements of a purchase. */
async function bookedForPurchase(purchaseId: string) {
  const movements = await prisma.inventoryTransaction.findMany({
    where: { purchaseItem: { purchaseId } },
    select: { id: true },
  });
  return bookedFor(movements.map((m) => m.id));
}

async function bookedFor(sourceIds: string[]) {
  const lines = await prisma.journalEntryLine.findMany({
    where: { organizationId: a.organizationId, journalEntry: { sourceId: { in: sourceIds } } },
    select: { chartOfAccountId: true, debitAmount: true, creditAmount: true },
  });
  const net = new Map<string, number>();
  for (const line of lines) {
    const value = toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString());
    net.set(line.chartOfAccountId, (net.get(line.chartOfAccountId) ?? 0) + value);
  }
  for (const [key, value] of net) if (value === 0) net.delete(key);
  return net;
}

/** An account's balance (debit positive), in fils, across the whole organization. */
async function balanceOf(accountId: string) {
  const lines = await prisma.journalEntryLine.findMany({
    where: { organizationId: a.organizationId, chartOfAccountId: accountId },
    select: { debitAmount: true, creditAmount: true },
  });
  return lines.reduce(
    (sum, line) => sum + toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString()),
    0,
  );
}

const onHand = (partId: string) =>
  getStockOnHand(prisma, a.organizationId, a.branchId, partId).then((milli) => milli / 1000);

describe('a discounted purchase, received and paid in two parts', () => {
  let purchaseId: string;
  let supplierId: string;

  before(async () => {
    supplierId = (await supplier('Discount Parts')).id;
    // A: 10 × 100.00 less 5% = 950.00. B: 3 × 33.33 = 99.99. Less 10.00 on the bill.
    const purchase = await createPurchase(a.owner, {
      supplierId,
      supplierInvoiceNumber: `DISC-${RUN}`,
      items: [
        {
          partId: part('A'),
          quantity: '10',
          unitCost: '100',
          taxRate: '5',
          discountType: 'PERCENT',
          discountValue: '5',
        },
        { partId: part('B'), quantity: '3', unitCost: '33.33', taxRate: '5' },
      ],
      billDiscountType: 'AMOUNT',
      billDiscountValue: '10',
    });
    purchaseId = purchase.id;
  });

  test('priced on the server: line discount, bill discount shared to the fil, VAT after both', async () => {
    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
    assert.equal(filsToString(toFils(purchase.subtotal!.toString())), '1039.99');
    assert.equal(filsToString(toFils(purchase.taxAmount!.toString())), '52.00');
    assert.equal(filsToString(toFils(purchase.totalAmount!.toString())), '1091.99');
    assert.equal(purchase.billDiscountType, 'AMOUNT');
    assert.equal(filsToString(toFils(purchase.billDiscountAmount.toString())), '10.00');
    const [lineA, lineB] = await itemsOf(purchaseId);
    assert.equal(filsToString(toFils(lineA.discountAmount.toString())), '50.00');
    // The 10.00 split 9.05 / 0.95 in proportion to 950.00 / 99.99.
    assert.equal(filsToString(toFils(lineA.netAmount!.toString())), '940.95');
    assert.equal(filsToString(toFils(lineB.netAmount!.toString())), '99.04');
    assert.equal(filsToString(toFils(lineA.taxAmount!.toString())), '47.05');
    assert.equal(filsToString(toFils(lineB.taxAmount!.toString())), '4.95');
  });

  test('first delivery (4 of A, all of B), 300 paid now, cost prices updated when ticked', async () => {
    const [lineA, lineB] = await itemsOf(purchaseId);
    const result = await receivePurchase(
      a.owner,
      purchaseId,
      { [lineA.id]: '4', [lineB.id]: '3' },
      { payment: 'now', payAmount: '300', method: 'CASH', updateCostPrice: 'on' },
    );
    assert.equal(result.payment?.amount, '300.00');
    // 4 of 940.95 = 376.38, VAT 18.82; B whole: 99.04, VAT 4.95.
    const booked = await bookedForPurchase(purchaseId);
    assert.equal(booked.get(roles.INVENTORY), toFils('475.42'));
    assert.equal(booked.get(roles.VAT_INPUT), toFils('23.77'));
    assert.equal(booked.get(roles.ACCOUNTS_PAYABLE), -toFils('499.19'));
    assert.equal(await onHand(part('A')), 4);
    assert.equal(await onHand(part('B')), 3);
    const parts = await prisma.part.findMany({ where: { id: { in: [part('A'), part('B')] } } });
    const cost = new Map(parts.map((p) => [p.id, p.defaultCostPrice?.toString()]));
    assert.equal(cost.get(part('A')), '94.1', '940.95 / 10, half-up to the fil');
    assert.equal(cost.get(part('B')), '33.01', '99.04 / 3');
    const owed = (await getPayables(a.owner, { supplierId })).rows.find((r) => r.id === purchaseId);
    assert.equal(owed?.received, '499.19');
    assert.equal(owed?.paid, '300.00');
    assert.equal(owed?.balance, '199.19');
  });

  test('second delivery (6 of A), the rest paid now: deliveries add up to the bill exactly', async () => {
    const [lineA] = await itemsOf(purchaseId);
    const result = await receivePurchase(
      a.owner,
      purchaseId,
      { [lineA.id]: '6' },
      { payment: 'now', method: 'CASH' },
    );
    // Blank amount: everything owed — 199.19 + 564.57 + 28.23.
    assert.equal(result.payment?.amount, '791.99');
    assert.equal(result.status, 'RECEIVED');
    const booked = await bookedForPurchase(purchaseId);
    assert.equal(booked.get(roles.INVENTORY), toFils('1039.99'), 'stock at cost after discount');
    assert.equal(booked.get(roles.VAT_INPUT), toFils('52.00'), 'VAT after discount');
    assert.equal(booked.get(roles.ACCOUNTS_PAYABLE), -toFils('1091.99'));
    assert.equal(await onHand(part('A')), 10);
    // A part's cost price is changed only when asked.
    const partA = await prisma.part.findUniqueOrThrow({ where: { id: part('A') } });
    assert.equal(partA.defaultCostPrice?.toString(), '94.1');
  });

  test('the supplier payments: Dr payables, Cr cash; nothing left owed', async () => {
    const payments = await prisma.supplierPayment.findMany({ where: { purchaseId } });
    assert.equal(payments.length, 2);
    const booked = await bookedFor(payments.map((p) => p.id));
    assert.equal(booked.get(roles.ACCOUNTS_PAYABLE), toFils('1091.99'));
    assert.equal(booked.get(roles.CASH), -toFils('1091.99'));
    const payables = await getPayables(a.owner, { supplierId });
    assert.equal(
      payables.rows.find((r) => r.id === purchaseId),
      undefined,
      'settled: off Suppliers owed',
    );
  });

  test('the supplier statement: the bill at its discounted total, both payments, nothing owed', async () => {
    const statement = await getSupplierStatement(a.owner, supplierId);
    const received = statement.lines.filter((line) => line.kind === 'Parts received');
    const billed = received.reduce((sum, line) => sum + toFils(line.credit || '0'), 0);
    assert.equal(billed, toFils('1091.99'));
    const paid = statement.lines
      .filter((line) => line.kind === 'Payment')
      .reduce((sum, line) => sum + toFils(line.debit || '0'), 0);
    assert.equal(paid, toFils('1091.99'));
    assert.equal(statement.closing, '0.00');
  });

  test('the VAT return counts the purchase after discounts, as the books do', async () => {
    const vat = await getVatReturn(a.owner);
    const row = vat.purchases.find((r) => r.id === purchaseId);
    assert.equal(row?.net, '1039.99');
    assert.equal(row?.vat, '52.00');
  });
});

describe('pay later with a due date', () => {
  test('nothing paid, the bill owed, aged from its due date', async () => {
    const { id: supplierId } = await supplier('Pay Later Parts');
    const purchase = await createPurchase(
      a.owner,
      {
        supplierId,
        supplierInvoiceDate: daysAgo(40),
        dueDate: daysAgo(10),
        items: [{ partId: part('E'), quantity: '4', unitCost: '25', taxRate: '5' }],
        payment: 'later',
      },
      { receive: true },
    );
    assert.equal(await prisma.supplierPayment.count({ where: { purchaseId: purchase.id } }), 0);
    const row = (await getPayables(a.owner, { supplierId })).rows.find((r) => r.id === purchase.id);
    assert.equal(row?.balance, '105.00');
    // Ten days past its due date (nine in the small hours, Dubai time, as the calendar
    // date is compared with the moment now — the same rule as every other age).
    assert.ok(row?.daysOverdue === 10 || row?.daysOverdue === 9, String(row?.daysOverdue));
    assert.equal(
      row?.ageDays,
      (row?.daysOverdue ?? 0) + 30,
      'aged from the due date, same buckets',
    );
    const statement = await getSupplierStatement(a.owner, supplierId);
    assert.ok(statement.lines.some((line) => line.description.includes('· due')));
    // A due date can't be before the bill.
    await expectDomainError(
      createPurchase(a.owner, {
        supplierId,
        supplierInvoiceDate: daysAgo(5),
        dueDate: daysAgo(6),
        items: [{ partId: part('E'), quantity: '1', unitCost: '25', taxRate: '5' }],
      }),
      /due date can’t be before/,
    );
  });

  test('paying on receipt needs the right to pay suppliers; pay later does not', async () => {
    const { id: supplierId } = await supplier('Rights Parts');
    const clerk = {
      ...a.owner,
      orgWidePermissions: new Set(
        [...a.owner.orgWidePermissions].filter((code) => code !== 'supplier_payment.create'),
      ),
    };
    const input = {
      supplierId,
      items: [{ partId: part('E'), quantity: '1', unitCost: '25', taxRate: '5' }],
    };
    await assert.rejects(
      createPurchase(clerk, { ...input, payment: 'now', method: 'CASH' }, { receive: true }),
      AuthError,
    );
    const later = await createPurchase(clerk, { ...input, payment: 'later' }, { receive: true });
    assert.equal(
      (await prisma.purchase.findUniqueOrThrow({ where: { id: later.id } })).status,
      'RECEIVED',
    );
    // Paying needs the goods: a draft can't be paid.
    await expectDomainError(
      createPurchase(a.owner, { ...input, payment: 'now', method: 'CASH' }),
      /paid once the goods are received/,
    );
  });
});

describe('a return on a discounted line', () => {
  test('comes off at exactly what those units were booked at', async () => {
    const { id: supplierId } = await supplier('Return Parts');
    // 5 × 20.00 less 10% on the bill: 90.00 + VAT 4.50 = 94.50.
    const purchase = await createPurchase(
      a.owner,
      {
        supplierId,
        // The tax invoice in hand: its VAT is claimable.
        supplierInvoiceNumber: `RET-${RUN}`,
        items: [{ partId: part('C'), quantity: '5', unitCost: '20', taxRate: '5' }],
        billDiscountType: 'PERCENT',
        billDiscountValue: '10',
      },
      { receive: true },
    );
    const [line] = await itemsOf(purchase.id);
    assert.equal(filsToString(toFils(line.netAmount!.toString())), '90.00');
    // Two go back to the supplier (as a return to supplier would record it).
    await prisma.$transaction(async (tx) => {
      await postMovement(tx, {
        organizationId: a.organizationId,
        branchId: a.branchId,
        partId: part('C'),
        type: 'RETURN_TO_SUPPLIER',
        quantityMilli: -2000,
        unitCost: line.unitCost.toString(),
        purchaseItemId: line.id,
        performedByUserId: a.owner.id,
        note: 'Returned two (test)',
      });
      await tx.purchaseItem.update({ where: { id: line.id }, data: { quantityReceived: '3' } });
    });
    const booked = await bookedForPurchase(purchase.id);
    // 3 of 5 kept: 54.00 + VAT 2.70.
    assert.equal(booked.get(roles.INVENTORY), toFils('54.00'));
    assert.equal(booked.get(roles.VAT_INPUT), toFils('2.70'));
    assert.equal(booked.get(roles.ACCOUNTS_PAYABLE), -toFils('56.70'));
    const row = (await getPayables(a.owner, { supplierId })).rows.find((r) => r.id === purchase.id);
    assert.equal(row?.balance, '56.70', 'the supplier balance agrees with the books');
    const vat = await getVatReturn(a.owner);
    assert.equal(vat.purchases.find((r) => r.id === purchase.id)?.vat, '2.70');
  });
});

describe('a purchase with no discount is exactly as before', () => {
  test('valued, posted, owed, stated and reported by the old formula', async () => {
    const { id: supplierId } = await supplier('Plain Parts');
    const purchase = await createPurchase(a.owner, {
      supplierId,
      // The tax invoice in hand: its VAT is claimable.
      supplierInvoiceNumber: `PLAIN-${RUN}`,
      items: [{ partId: part('D'), quantity: '3', unitCost: '33.33', taxRate: '5' }],
    });
    const [line] = await itemsOf(purchase.id);
    assert.equal(line.netAmount, null, 'no discount: nothing new stored');
    assert.equal(toFils(line.discountAmount.toString()), 0);
    const header = await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    assert.equal(header.billDiscountType, null);
    // The old totals: 99.99 + VAT 5.00 (4.9995 rounded) = 104.99.
    assert.equal(filsToString(toFils(header.totalAmount!.toString())), '104.99');

    await receivePurchase(a.owner, purchase.id, { [line.id]: '1' });
    await receivePurchase(a.owner, purchase.id, { [line.id]: '2' });
    // The old valuation: each delivery priced on its own quantity.
    const old = (quantity: string) => calculateLine({ quantity, unitPrice: '33.33', taxRate: '5' });
    const one = old('1');
    const two = old('2');
    const booked = await bookedForPurchase(purchase.id);
    assert.equal(booked.get(roles.INVENTORY), one.lineTotalFils + two.lineTotalFils);
    assert.equal(booked.get(roles.VAT_INPUT), one.taxFils + two.taxFils);
    const row = (await getPayables(a.owner, { supplierId })).rows.find((r) => r.id === purchase.id);
    // The old balance: everything received, priced together.
    const whole = old('3');
    assert.equal(row?.received, filsToString(whole.lineTotalFils + whole.taxFils));
    assert.equal(row?.dueDate, null);
    const statement = await getSupplierStatement(a.owner, supplierId);
    const billed = statement.lines
      .filter((l) => l.kind === 'Parts received')
      .reduce((sum, l) => sum + toFils(l.credit || '0'), 0);
    assert.equal(billed, one.lineTotalFils + one.taxFils + two.lineTotalFils + two.taxFils);
    assert.ok(!statement.lines.some((l) => l.description.includes('· due')));
    const vat = await getVatReturn(a.owner);
    const vatRow = vat.purchases.find((r) => r.id === purchase.id);
    assert.equal(vatRow?.vat, filsToString(one.taxFils + two.taxFils));
  });
});

describe('the supplier’s round-off (“adjusted amount” on the bill)', () => {
  // Al Amani's GHCR26-20748: 85.00 + 20.00 + 2 × 5.00 + 2 × 5.00 less 1.00 =
  // 124.00, VAT 6.20 = 130.20, adjusted −0.20, paid 130.00.
  const bill = (supplierId: string, invoice: string) => ({
    supplierId,
    supplierInvoiceNumber: invoice,
    items: [
      { partId: part('C'), quantity: '1', unitCost: '85', taxRate: '5' },
      { partId: part('D'), quantity: '1', unitCost: '20', taxRate: '5' },
      { partId: part('E'), quantity: '2', unitCost: '5', taxRate: '5' },
      {
        partId: part('A'),
        quantity: '2',
        unitCost: '5',
        taxRate: '5',
        discountType: 'AMOUNT',
        discountValue: '1',
      },
    ],
    roundingAdjustment: '-0.20',
  });

  test('more than 5.00 either way is refused', async () => {
    const { id } = await supplier('Round-off limits');
    await expectDomainError(
      createPurchase(a.owner, { ...bill(id, `RND-X-${RUN}`), roundingAdjustment: '-5.01' }),
      /at most 5\.00/,
    );
  });

  test('received and paid at once: 130.00, nothing owed, the round-off booked', async () => {
    const { id: supplierId } = await supplier('Al Amani');
    const purchase = await createPurchase(
      a.owner,
      {
        ...bill(supplierId, `GHCR-${RUN}`),
        payment: 'now',
        payAmount: '130',
        method: 'BANK_TRANSFER',
      },
      { receive: true },
    );
    const saved = await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    assert.equal(saved.subtotal?.toString(), '124');
    assert.equal(saved.taxAmount?.toString(), '6.2', 'VAT as on the bill');
    assert.equal(saved.roundingAdjustment.toString(), '-0.2');
    assert.equal(saved.totalAmount?.toString(), '130');
    // The parts, at cost after the line discount, VAT claimable in full.
    const stock = await bookedForPurchase(purchase.id);
    assert.equal(stock.get(roles.INVENTORY), toFils('124.00'));
    assert.equal(stock.get(roles.VAT_INPUT), toFils('6.20'));
    assert.equal(stock.get(roles.ACCOUNTS_PAYABLE), -toFils('130.20'));
    // The round-off its own entry: owed 0.20 less, a gain.
    const rounding = await bookedFor([purchase.id]);
    assert.equal(rounding.get(roles.ACCOUNTS_PAYABLE), toFils('0.20'));
    assert.equal(rounding.get(roles.ROUNDING), -toFils('0.20'));
    assert.equal(rounding.size, 2);
    // Paid in full: off the payables list, nothing owed on the purchase itself.
    const detail = await getPurchaseDetail(a.owner, purchase.id);
    assert.equal(detail.receivedValue, '130.00');
    assert.equal(detail.roundingOwed, '-0.20');
    assert.equal(detail.paid, '130.00');
    assert.equal(detail.owed, '0.00');
    assert.ok(
      !(await getPayables(a.owner, { supplierId })).rows.some((row) => row.id === purchase.id),
    );
    const statement = await getSupplierStatement(a.owner, supplierId);
    assert.ok(statement.lines.some((line) => line.kind === 'Round-off'));
    assert.equal(toFils(statement.closing.replace('-', '')), 0);
  });

  test('received in part: the round-off waits for the rest', async () => {
    const { id: supplierId } = await supplier('Round-off later');
    const purchase = await createPurchase(a.owner, bill(supplierId, `RND-P-${RUN}`));
    const [first, ...rest] = await itemsOf(purchase.id);
    await receivePurchase(a.owner, purchase.id, {
      [first.id]: '1',
      ...Object.fromEntries(rest.map((item) => [item.id, ''])),
    });
    const owedNow = async () =>
      (await getPayables(a.owner, { supplierId })).rows.find((row) => row.id === purchase.id);
    assert.equal((await owedNow())?.received, '89.25', '85.00 + VAT 4.25, no round-off yet');
    assert.equal((await bookedFor([purchase.id])).size, 0, 'nothing booked for it yet');
    await receivePurchase(a.owner, purchase.id, null);
    assert.equal((await owedNow())?.received, '130.00');
    assert.equal((await bookedFor([purchase.id])).get(roles.ROUNDING), -toFils('0.20'));
    assert.equal(await countUnbooked(a.owner), 0);
  });
});

describe('a received purchase’s details', () => {
  test('the date, invoice number, due date and notes change — nothing else', async () => {
    const { id: supplierId } = await supplier('Details later');
    const purchase = await createPurchase(
      a.owner,
      {
        supplierId,
        supplierInvoiceNumber: `DET-${RUN}`,
        items: [{ partId: part('C'), quantity: '1', unitCost: '40', taxRate: '5' }],
        payment: 'now',
        method: 'CASH',
      },
      { receive: true },
    );
    const before = await bookedForPurchase(purchase.id);
    await updatePurchaseDetails(a.owner, purchase.id, {
      supplierInvoiceNumber: `DET-${RUN}-A`,
      supplierInvoiceDate: daysAgo(2),
      dueDate: daysAgo(1),
      notes: 'Paid in cash',
    });
    const saved = await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    assert.equal(saved.supplierInvoiceNumber, `DET-${RUN}-A`);
    assert.equal(saved.supplierInvoiceDate?.toISOString().slice(0, 10), daysAgo(2));
    assert.equal(saved.notes, 'Paid in cash');
    assert.equal(saved.totalAmount?.toString(), '42', 'the amounts as received');
    assert.equal(saved.status, 'RECEIVED');
    assert.deepEqual(await bookedForPurchase(purchase.id), before, 'the books untouched');
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: purchase.id, action: 'purchase.details_updated' },
      }),
    );
    await expectDomainError(
      updatePurchaseDetails(a.owner, purchase.id, { supplierInvoiceDate: daysAgo(-1) }),
      /can't be in the future/,
    );
    await expectDomainError(
      updatePurchaseDetails(a.owner, purchase.id, {
        supplierInvoiceDate: daysAgo(2),
        dueDate: daysAgo(3),
      }),
      /before the purchase date/,
    );
  });
});

describe('importing purchases from a spreadsheet', () => {
  const supplierName = `Taimoor Auto Spare Parts ${RUN}`;
  const heading =
    'Supplier,Supplier TRN,Supplier invoice no.,Date,Part code,Part name,Quantity,Unit cost,VAT %,Line discount,Round-off,Amount paid,Payment method,Paid from';
  // Taimoor's 38039 as a converted photo would give it: no item codes, paid in cash.
  const taimoor = [
    heading,
    `${supplierName},104558747200001,TM-${RUN},${daysAgo(7).split('-').reverse().join('/')},,OIL 5W40-4LTR ${RUN},1,60.00,5,,,99.75,Cash,1000`,
    `${supplierName},,TM-${RUN},,,ENG OIL 5W40-1LTR ${RUN},1,20.00,5,,,,,`,
    `${supplierName},,TM-${RUN},,,OIL FILTER ${RUN},1,15.00,5,,,,,`,
  ].join('\n');

  test('one bill from three rows: supplier and parts added, received, paid in cash', async () => {
    const outcome = await importCsv(a.owner, 'purchases', taimoor);
    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.created, 1, 'one purchase');
    const supplierRow = await prisma.supplier.findFirstOrThrow({
      where: { organizationId: a.organizationId, name: supplierName },
    });
    const purchase = await prisma.purchase.findFirstOrThrow({
      where: { supplierId: supplierRow.id, supplierInvoiceNumber: `TM-${RUN}` },
      include: { items: true },
    });
    assert.equal(purchase.status, 'RECEIVED');
    assert.equal(purchase.items.length, 3);
    assert.equal(purchase.subtotal?.toString(), '95');
    assert.equal(purchase.taxAmount?.toString(), '4.75');
    assert.equal(purchase.totalAmount?.toString(), '99.75');
    assert.equal(purchase.supplierInvoiceDate?.toISOString().slice(0, 10), daysAgo(7));
    const detail = await getPurchaseDetail(a.owner, purchase.id);
    assert.equal(detail.paid, '99.75');
    assert.equal(detail.owed, '0.00');
    const stock = await bookedForPurchase(purchase.id);
    assert.equal(stock.get(roles.INVENTORY), toFils('95.00'));
    assert.equal(stock.get(roles.VAT_INPUT), toFils('4.75'));
  });

  test('the same file again: the bill is skipped, not entered twice', async () => {
    const outcome = await importCsv(a.owner, 'purchases', taimoor);
    assert.equal(outcome.created, 0);
    assert.equal(outcome.skipped.length, 1);
    assert.match(outcome.skipped[0].reason, /already entered as PO-/);
  });

  test('the same supplier spelled another way is found by its TRN — the bill is skipped', async () => {
    const csv = [
      heading,
      `TAIMOOR AUTO SPARES L.L.C ${RUN},104558747200001,TM-${RUN},${daysAgo(7)},,OIL 5W40-4LTR ${RUN},1,60.00,5,,,,,`,
    ].join('\n');
    const before = await prisma.supplier.count({ where: { organizationId: a.organizationId } });
    const outcome = await importCsv(a.owner, 'purchases', csv);
    assert.equal(outcome.created, 0);
    assert.match(outcome.skipped[0]?.reason ?? '', /already entered as PO-/);
    assert.equal(
      await prisma.supplier.count({ where: { organizationId: a.organizationId } }),
      before,
      'no second supplier for the same TRN',
    );
  });

  test('a round-off and a line discount, paying later', async () => {
    const csv = [
      heading,
      `Round-off Parts ${RUN},,RO-${RUN},${daysAgo(1)},,Part X ${RUN},2,5.00,5,1.00,-0.20,,,`,
      `Round-off Parts ${RUN},,RO-${RUN},,,Part Y ${RUN},1,85.00,5,,,,,`,
    ].join('\n');
    const outcome = await importCsv(a.owner, 'purchases', csv);
    assert.deepEqual(outcome.errors, []);
    const purchase = await prisma.purchase.findFirstOrThrow({
      where: { organizationId: a.organizationId, supplierInvoiceNumber: `RO-${RUN}` },
    });
    // 9.00 + 85.00 = 94.00, VAT 4.70 = 98.70, adjusted −0.20.
    assert.equal(purchase.totalAmount?.toString(), '98.5');
    assert.equal(purchase.roundingAdjustment.toString(), '-0.2');
    const detail = await getPurchaseDetail(a.owner, purchase.id);
    assert.equal(detail.paid, '0.00');
    assert.equal(detail.owed, '98.50');
  });

  test('one bad row and nothing at all is written', async () => {
    const before = await prisma.purchase.count({ where: { organizationId: a.organizationId } });
    const csv = [
      heading,
      `Good Parts ${RUN},,GD-${RUN},${daysAgo(1)},,Good part ${RUN},1,10.00,5,,,,,`,
      `Bad Parts ${RUN},,BD-${RUN},${daysAgo(1)},,Bad part ${RUN},1,ten,5,,,,,`,
    ].join('\n');
    const outcome = await importCsv(a.owner, 'purchases', csv);
    assert.equal(outcome.created, 0);
    assert.equal(outcome.errors.length, 1);
    assert.equal(
      await prisma.purchase.count({ where: { organizationId: a.organizationId } }),
      before,
    );
  });
});

describe('merging a supplier entered twice', () => {
  test('purchases and what is owed move to the kept supplier; the duplicate is archived', async () => {
    const kept = await supplier('Al Amani Trading');
    const twin = await prisma.supplier.create({
      data: {
        organizationId: a.organizationId,
        name: `Al Amani ${RUN}`,
        taxNumber: '100326808100003',
        phone: '04 229 3400',
      },
    });
    const bill = (supplierId: string, invoice: string) =>
      createPurchase(
        a.owner,
        {
          supplierId,
          supplierInvoiceNumber: invoice,
          items: [{ partId: part('C'), quantity: '1', unitCost: '20', taxRate: '5' }],
          payment: 'later',
        },
        { receive: true },
      );
    await bill(kept.id, `AA-1-${RUN}`);
    const theirs = await bill(twin.id, `AA-2-${RUN}`);

    const merged = await mergeSuppliers(a.owner, twin.id, {
      targetId: kept.id,
      reason: 'Same supplier, short name',
    });
    assert.equal(merged.moved.purchases, 1);
    const moved = await prisma.purchase.findUniqueOrThrow({ where: { id: theirs.id } });
    assert.equal(moved.supplierId, kept.id);
    // What is owed is all on the kept supplier now: 21.00 + 21.00.
    const owed = await getPayables(a.owner, { supplierId: kept.id });
    assert.equal(owed.rows.length, 2);
    const keptRow = await prisma.supplier.findUniqueOrThrow({ where: { id: kept.id } });
    assert.equal(keptRow.taxNumber, '100326808100003', 'a missing TRN taken from the duplicate');
    assert.equal(keptRow.phone, '04 229 3400');
    const twinRow = await prisma.supplier.findUniqueOrThrow({ where: { id: twin.id } });
    assert.equal(twinRow.isActive, false);
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: kept.id, action: 'supplier.merged_in' },
      }),
    );
  });

  test('refused while both have the same bill, and into itself', async () => {
    const one = await supplier('Twin bill A');
    const two = await supplier('Twin bill B');
    for (const id of [one.id, two.id]) {
      await createPurchase(
        a.owner,
        {
          supplierId: id,
          supplierInvoiceNumber: `SAME-${RUN}`,
          items: [{ partId: part('C'), quantity: '1', unitCost: '10', taxRate: '5' }],
          payment: 'later',
        },
        { receive: true },
      );
    }
    await expectDomainError(
      mergeSuppliers(a.owner, two.id, { targetId: one.id }),
      /the same bill entered twice/,
    );
    await expectDomainError(
      mergeSuppliers(a.owner, one.id, { targetId: one.id }),
      /different supplier/,
    );
  });
});

describe('everything agrees', () => {
  test('no income from discounts; the balance sheet balances; nothing unbooked', async () => {
    const pnl = await getLedgerProfitAndLoss(a.owner);
    // A discount lowers the stock's cost and is never income; a supplier's
    // round-off down is a small gain on Rounding adjustments (postings.ts).
    const roundOffs = filsToString(-(await balanceOf(roles.ROUNDING)));
    assert.equal(pnl.income.total, roundOffs, 'a purchase discount is never income');
    assert.equal(pnl.netProfit, roundOffs, 'buying stock is not an expense');
    // Trade payables equals what Suppliers owed shows, across every supplier.
    const owedFils = (await getPayables(a.owner)).totals.balanceFils;
    assert.equal(-(await balanceOf(roles.ACCOUNTS_PAYABLE)), owedFils);
    assert.equal((await getBalanceSheet(a.owner)).balanced, true);
    assert.equal(await countUnbooked(a.owner), 0);
  });
});
