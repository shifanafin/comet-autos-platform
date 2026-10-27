/**
 * Integration tests for controlled parts, stock and cost of sales:
 *
 *  - an invoice's Parts line may be typed (nothing leaves stock), and one
 *    picked from the list must be in stock;
 *  - a part bought for the job from an invoice line: the part (new, after a
 *    duplicate check), its purchase received into stock and paid in cash,
 *    its input VAT held as "awaiting tax invoice";
 *  - the invoice sells it: stock out, cost of sales at the line's cost;
 *  - correcting the invoice moves only the difference; voiding returns it;
 *  - the shop's tax invoice: a bill that doesn't agree is refused; one that
 *    does moves the VAT to Input VAT on the day it was received; a purchase
 *    with no tax invoice puts its VAT into the cost;
 *  - a purchase entered with its bill number never waits for a bill.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npx tsx --test tests/parts-control.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { ensureChart } from '@/lib/accounting/chart';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { updateInvoice, voidInvoice } from '@/lib/billing/invoice-changes';
import { buyPartForJob } from '@/lib/inventory/quick-purchase';
import { listBillsAwaiting, matchBill } from '@/lib/inventory/bills';
import { createPurchase } from '@/lib/inventory/purchases';
import { getStockOnHand } from '@/lib/inventory/stock';
import { toFils } from '@/lib/money';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;
let customerId: string;
let shopId: string;

before(async () => {
  a = await createTestOrg('Parts control', [
    { sku: `PC-PAD-${RUN}`, name: 'Brake pad', cost: '40.00', price: '90.00', stock: '0' },
    { sku: `PC-OIL-${RUN}`, name: 'Engine oil 5W30', cost: '20.00', price: '35.00', stock: '10' },
  ]);
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  customerId = (
    await prisma.customer.create({
      data: {
        organizationId: a.organizationId,
        name: `Parts customer ${RUN}`,
        phone: '0500000000',
      },
    })
  ).id;
  shopId = (
    await prisma.supplier.create({
      data: { organizationId: a.organizationId, name: `Nearby shop ${RUN}` },
    })
  ).id;
});

after(async () => {
  await prisma.$disconnect();
});

const pad = () => a.parts[`PC-PAD-${RUN}`].id;
const oil = () => a.parts[`PC-OIL-${RUN}`].id;
const onHand = (partId: string) =>
  getStockOnHand(prisma, a.organizationId, a.branchId, partId).then((milli) => milli / 1000);

/** An account's balance (debit positive), in fils. */
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

const partLine = (partId: string, quantity: string, unitCost?: string) => ({
  itemType: 'PART' as const,
  description: 'Part',
  quantity,
  unitPrice: '90.00',
  vatTreatment: 'STANDARD' as const,
  partId,
  ...(unitCost ? { unitCost } : {}),
});

describe('an invoice sells parts typed, or from the list and in stock', () => {
  test('a Parts line typed without a part is accepted, and nothing leaves stock', async () => {
    const result = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'PART', description: 'Some part', quantity: '1', unitPrice: '50' }],
    });
    assert.equal(
      await prisma.inventoryTransaction.count({
        where: { organizationId: a.organizationId, invoiceId: result.invoiceId },
      }),
      0,
    );
  });

  test('a part out of stock is refused until its purchase is recorded', async () => {
    await expectDomainError(
      createDirectInvoice(a.owner, { customerId, items: [partLine(pad(), '2')] }),
      /Not enough “Brake pad” in stock/,
    );
  });
});

describe('a part bought for the job, then sold on the invoice', () => {
  let purchaseId: string;
  let invoiceId: string;

  test('a near-duplicate new part is refused until confirmed different', async () => {
    await expectDomainError(
      buyPartForJob(a.owner, {
        name: 'Brake pads',
        supplierId: shopId,
        quantity: '2',
        unitCost: '45.00',
        paid: 'cash',
      }),
      /Already in the parts list: “Brake pad”/,
    );
  });

  test('bought for the existing part: received into stock, paid in cash, VAT awaiting the bill', async () => {
    const cashBefore = await balanceOf('CASH');
    const result = await buyPartForJob(a.owner, {
      partId: pad(),
      supplierId: shopId,
      quantity: '2',
      unitCost: '45.00',
      taxRate: '5',
      paid: 'cash',
    });
    purchaseId = result.purchaseId;
    assert.equal(result.billAwaited, true);
    assert.equal(await onHand(pad()), 2);

    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
    assert.equal(purchase.status, 'RECEIVED');
    assert.equal(purchase.billStatus, 'PENDING');
    assert.equal(purchase.totalAmount?.toString(), '94.5');
    // The last price paid is the part's cost now.
    const part = await prisma.part.findUniqueOrThrow({ where: { id: pad() } });
    assert.equal(part.defaultCostPrice?.toFixed(2), '45.00');

    assert.equal(await balanceOf('VAT_INPUT_PENDING'), 450);
    assert.equal(await balanceOf('VAT_INPUT'), 0);
    assert.equal(cashBefore - (await balanceOf('CASH')), 9450);
    assert.ok((await listBillsAwaiting(a.owner)).some((bill) => bill.id === purchaseId));
  });

  test('the invoice takes it out of stock and books its cost at the line’s cost', async () => {
    const cogsBefore = await balanceOf('COST_OF_PARTS');
    const result = await createDirectInvoice(a.owner, {
      customerId,
      items: [partLine(pad(), '2', '45.00'), partLine(oil(), '1')],
    });
    invoiceId = result.invoiceId;
    assert.equal(await onHand(pad()), 0);
    assert.equal(await onHand(oil()), 9);
    const items = await prisma.invoiceItem.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
    });
    assert.deepEqual(
      items.map((item) => [item.partId, item.unitCost?.toFixed(2)]),
      [
        [pad(), '45.00'],
        [oil(), '20.00'], // blank cost: the part's current cost
      ],
    );
    // 2 × 45.00 + 1 × 20.00
    assert.equal((await balanceOf('COST_OF_PARTS')) - cogsBefore, 11000);
  });

  test('correcting the invoice moves only the difference', async () => {
    const before = await prisma.invoiceItem.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
    });
    await updateInvoice(a.owner, invoiceId, {
      items: [
        { ...partLine(pad(), '1', '45.00'), sourceId: before[0].id },
        { ...partLine(oil(), '3'), sourceId: before[1].id },
      ],
    });
    assert.equal(await onHand(pad()), 1);
    assert.equal(await onHand(oil()), 7);
    const moved = await prisma.inventoryTransaction.count({ where: { invoiceId } });
    assert.equal(moved, 4, 'two out on issue, one back and one out on the correction');
  });

  test('voiding returns every part and reverses the cost of sales', async () => {
    const cogsBefore = await balanceOf('COST_OF_PARTS');
    await voidInvoice(a.owner, invoiceId, { reason: 'Test void' });
    assert.equal(await onHand(pad()), 2);
    assert.equal(await onHand(oil()), 10);
    // 1 × 45.00 + 3 × 20.00 taken back off cost of sales.
    assert.equal(cogsBefore - (await balanceOf('COST_OF_PARTS')), 10500);
  });

  test('a bill that doesn’t agree is refused; one that does moves the VAT', async () => {
    await expectDomainError(
      matchBill(a.owner, purchaseId, {
        outcome: 'RECEIVED',
        supplierInvoiceNumber: `SHOP-${RUN}`,
        billDate: localDateString(),
        receivedOn: localDateString(),
        subtotal: '100.00',
        taxAmount: '5.00',
        totalAmount: '105.00',
      }),
      /doesn't agree/,
    );
    await matchBill(a.owner, purchaseId, {
      outcome: 'RECEIVED',
      supplierInvoiceNumber: `SHOP-${RUN}`,
      billDate: localDateString(),
      receivedOn: localDateString(),
      subtotal: '90.00',
      taxAmount: '4.50',
      totalAmount: '94.50',
    });
    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
    assert.equal(purchase.billStatus, 'RECEIVED');
    assert.equal(purchase.supplierInvoiceNumber, `SHOP-${RUN}`);
    assert.equal(await balanceOf('VAT_INPUT_PENDING'), 0);
    assert.equal(await balanceOf('VAT_INPUT'), 450);
    assert.ok(!(await listBillsAwaiting(a.owner)).some((bill) => bill.id === purchaseId));
  });
});

describe('a new part bought with no tax invoice coming', () => {
  test('added after confirming it is different, then closed without a bill: its VAT is cost', async () => {
    const result = await buyPartForJob(a.owner, {
      name: 'Brake pad rear',
      confirmNew: '1',
      supplierId: shopId,
      quantity: '1',
      unitCost: '60.00',
      taxRate: '5',
      paid: 'later',
    });
    assert.equal(result.created, true);
    const cogsBefore = await balanceOf('COST_OF_PARTS');
    await matchBill(a.owner, result.purchaseId, {
      outcome: 'NO_TAX_INVOICE',
      note: 'Cash receipt only',
    });
    assert.equal(await balanceOf('VAT_INPUT_PENDING'), 0);
    assert.equal((await balanceOf('COST_OF_PARTS')) - cogsBefore, 300);
  });
});

describe('a purchase entered with its bill in hand', () => {
  test('never waits for a bill: its VAT is claimable at once', async () => {
    const vatBefore = await balanceOf('VAT_INPUT');
    const purchase = await createPurchase(
      a.owner,
      {
        supplierId: shopId,
        supplierInvoiceNumber: `BILL-${RUN}`,
        supplierInvoiceDate: localDateString(),
        items: [{ partId: oil(), quantity: '2', unitCost: '20.00', taxRate: '5' }],
      },
      { receive: true },
    );
    const saved = await prisma.purchase.findUniqueOrThrow({ where: { id: purchase.id } });
    assert.equal(saved.billStatus, 'RECEIVED');
    assert.equal((await balanceOf('VAT_INPUT')) - vatBefore, 200);
  });
});
