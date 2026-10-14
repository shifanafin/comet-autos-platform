/**
 * Integration tests for settling the Parts lines of invoices issued before
 * parts were tied to stock (lib/inventory/old-part-lines.ts):
 *
 *  - costed at the write-off its part already left stock on: the job's
 *    profit counts the cost, while stock and the books don't move at all;
 *    a write-off costs no more than it took out; an edit can't change the
 *    line's part or quantity; undone, the line is back on the list;
 *  - taken out of stock now: stock down, its cost on the invoice's entry;
 *  - work, not a part: a Labour line, its income moved to labour sales.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npx tsx --test tests/old-part-lines.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { ensureChart } from '@/lib/accounting/chart';
import { syncPosting } from '@/lib/accounting/journal';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { updateInvoice } from '@/lib/billing/invoice-changes';
import { getJobCost } from '@/lib/finance/job-costing';
import { getStockOnHand, postMovement } from '@/lib/inventory/stock';
import {
  costFromWriteOff,
  getOldPartLines,
  markAsWork,
  takeFromStockNow,
  undoWriteOffCost,
} from '@/lib/inventory/old-part-lines';
import { toFils } from '@/lib/money';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;
let customerId: string;

before(async () => {
  a = await createTestOrg('Old part lines', [
    { sku: `OP-PAD-${RUN}`, name: 'Brake pad set', cost: '60.00', price: '120.00', stock: '5' },
    { sku: `OP-OIL-${RUN}`, name: 'Engine oil 4L', cost: '50.00', price: '90.00', stock: '8' },
  ]);
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  customerId = (
    await prisma.customer.create({
      data: { organizationId: a.organizationId, name: `Old lines customer ${RUN}`, phone: '0500000002' },
    })
  ).id;
});

after(async () => {
  await prisma.$disconnect();
});

const part = (key: string) => a.parts[`OP-${key}-${RUN}`].id;
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

/**
 * An invoice as one was issued before parts were tied to stock: its Parts
 * line names no part and has no cost. (Made as Labour, then turned into
 * such a line — a Parts line typed today must name its part.)
 */
async function oldInvoice(description: string, quantity: string, unitPrice: string) {
  const { invoiceId } = await createDirectInvoice(a.owner, {
    customerId,
    items: [
      { itemType: 'LABOUR', description, quantity, unitPrice, vatTreatment: 'STANDARD' },
      { itemType: 'LABOUR', description: 'Labour', quantity: '1', unitPrice: '50.00', vatTreatment: 'STANDARD' },
    ],
  });
  const line = await prisma.invoiceItem.findFirstOrThrow({ where: { invoiceId, description } });
  await prisma.invoiceItem.update({ where: { id: line.id }, data: { itemType: 'PART' } });
  await prisma.$transaction((tx) =>
    syncPosting(tx, a.organizationId, 'INVOICE', invoiceId, a.owner.id),
  );
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { invoiceNumber: true },
  });
  return { invoiceId, itemId: line.id, invoiceNumber: invoice.invoiceNumber };
}

/** An old write-off: stock out to cost, as on 6 Oct 2026. */
async function writeOff(partId: string, quantity: number, unitCost: string, note: string) {
  return prisma.$transaction((tx) =>
    postMovement(tx, {
      organizationId: a.organizationId,
      branchId: a.branchId,
      partId,
      type: 'ADJUSTMENT',
      quantityMilli: -quantity * 1000,
      unitCost,
      performedByUserId: a.owner.id,
      note,
    }),
  );
}

describe('costed at the write-off its part already left stock on', () => {
  test('the job counts the cost; stock and the books do not move', async () => {
    const old = await oldInvoice('Front pads', '2', '150.00');
    const off = await writeOff(part('PAD'), 2, '60.00', `Historical consumption — ${old.invoiceNumber} Front pads`);

    const before = await getJobCost(a.owner, old.invoiceId);
    assert.equal(before!.uncostedLines, 1);
    assert.equal(before!.partsFils, 0);

    const listed = (await getOldPartLines(a.owner)).open.find((line) => line.id === old.itemId);
    assert.ok(listed);
    assert.equal(listed.likely[0], off.id, 'the write-off naming the invoice comes first');

    const stock = await onHand(part('PAD'));
    const cogs = await balanceOf('COST_OF_PARTS');
    const inventory = await balanceOf('INVENTORY');
    await costFromWriteOff(a.owner, { itemId: old.itemId, movementId: off.id });

    const line = await prisma.invoiceItem.findUniqueOrThrow({ where: { id: old.itemId } });
    assert.equal(line.partId, part('PAD'));
    assert.equal(line.costMovementId, off.id);
    assert.equal(line.unitCost?.toString(), '60');
    assert.equal(await onHand(part('PAD')), stock, 'nothing more leaves stock');
    assert.equal(await balanceOf('COST_OF_PARTS'), cogs, 'no second cost booked');
    assert.equal(await balanceOf('INVENTORY'), inventory);
    assert.equal(
      await prisma.inventoryTransaction.count({ where: { invoiceId: old.invoiceId } }),
      0,
    );

    const after = await getJobCost(a.owner, old.invoiceId);
    assert.equal(after!.uncostedLines, 0);
    assert.equal(after!.partsFils, 12000);
    assert.ok(!(await getOldPartLines(a.owner)).open.some((entry) => entry.id === old.itemId));
  });

  test('a write-off costs no more of its part than it took out', async () => {
    const first = await oldInvoice('Rear pads', '1', '140.00');
    const second = await oldInvoice('Rear pads again', '1', '140.00');
    const off = await writeOff(part('PAD'), 1, '60.00', 'Historical consumption — used on customer vehicles');
    await costFromWriteOff(a.owner, { itemId: first.itemId, movementId: off.id });
    await expectDomainError(
      costFromWriteOff(a.owner, { itemId: second.itemId, movementId: off.id }),
      /can’t cost this line|left to cost/,
    );
    await expectDomainError(
      costFromWriteOff(a.owner, { itemId: first.itemId, movementId: off.id }),
      /already settled/,
    );
  });

  test('an edit keeps it, but can’t change its quantity; undone, it is back on the list', async () => {
    const old = await oldInvoice('Pads for edit', '1', '150.00');
    const off = await writeOff(part('PAD'), 1, '60.00', `Historical consumption — ${old.invoiceNumber}`);
    await costFromWriteOff(a.owner, { itemId: old.itemId, movementId: off.id });
    const items = await prisma.invoiceItem.findMany({
      where: { invoiceId: old.invoiceId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const edited = (quantity: (id: string) => string) =>
      items.map((item) => ({
        sourceId: item.id,
        itemType: item.itemType ?? 'LABOUR',
        description: item.description,
        quantity: quantity(item.id),
        unitPrice: item.unitPrice.toString(),
        vatTreatment: 'STANDARD',
        partId: item.partId ?? '',
        unitCost: item.unitCost?.toString() ?? '',
      }));

    await expectDomainError(
      updateInvoice(a.owner, old.invoiceId, {
        items: edited((id) => (id === old.itemId ? '2' : '1')),
      }),
      /costed at old stock already written off/,
    );
    await updateInvoice(a.owner, old.invoiceId, { items: edited(() => '1'), notes: 'Corrected' });
    const kept = await prisma.invoiceItem.findFirstOrThrow({
      where: { invoiceId: old.invoiceId, description: 'Pads for edit' },
    });
    assert.equal(kept.costMovementId, off.id);
    assert.equal(
      await prisma.inventoryTransaction.count({ where: { invoiceId: old.invoiceId } }),
      0,
      'the edit took nothing out of stock',
    );

    await undoWriteOffCost(a.owner, { itemId: kept.id });
    const undone = await prisma.invoiceItem.findUniqueOrThrow({ where: { id: kept.id } });
    assert.equal(undone.costMovementId, null);
    assert.equal(undone.partId, null);
    assert.ok((await getOldPartLines(a.owner)).open.some((entry) => entry.id === kept.id));
  });
});

describe('taken out of stock now', () => {
  test('stock down, and its cost booked on the invoice', async () => {
    const old = await oldInvoice('Engine oil', '1', '90.00');
    const stock = await onHand(part('OIL'));
    const cogs = await balanceOf('COST_OF_PARTS');
    await takeFromStockNow(a.owner, { itemId: old.itemId, partId: part('OIL') });
    assert.equal(await onHand(part('OIL')), stock - 1);
    assert.equal((await balanceOf('COST_OF_PARTS')) - cogs, 5000);
    const cost = await getJobCost(a.owner, old.invoiceId);
    assert.equal(cost!.partsFils, 5000);
    assert.equal(cost!.uncostedLines, 0);
  });
});

describe('work, not a part', () => {
  test('a Labour line, its income moved to labour sales', async () => {
    const old = await oldInvoice('Injector cleaning', '4', '30.00');
    const parts = await balanceOf('SALES_PARTS');
    const labour = await balanceOf('SALES_LABOUR');
    await markAsWork(a.owner, { itemId: old.itemId });
    const line = await prisma.invoiceItem.findUniqueOrThrow({ where: { id: old.itemId } });
    assert.equal(line.itemType, 'LABOUR');
    // Income is a credit: parts sales falls by 120.00, labour sales rises by it.
    assert.equal((await balanceOf('SALES_PARTS')) - parts, 12000);
    assert.equal(labour - (await balanceOf('SALES_LABOUR')), 12000);
    const cost = await getJobCost(a.owner, old.invoiceId);
    assert.equal(cost!.uncostedLines, 0);
  });
});
