/**
 * Integration tests for inventory management — parts catalogue, suppliers,
 * purchase receiving, the stock ledger, stock controls, job usage and
 * returns — against the local PostgreSQL database through the real services.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { checkInVehicle } from '@/lib/workshop/check-in';
import { startInspection, saveInspection } from '@/lib/workshop/inspection';
import { saveDiagnosis } from '@/lib/workshop/diagnosis';
import {
  createEstimate,
  recordCustomerDecision,
  saveEstimateDraft,
  sendEstimate,
} from '@/lib/workshop/estimates';
import {
  getRepairWorkspace,
  recordLabour,
  recordPartUsage,
  returnPartFromJob,
  startRepair,
} from '@/lib/workshop/repair';
import { recordQualityCheck } from '@/lib/workshop/quality-check';
import { getStockOnHand } from '@/lib/inventory/stock';
import { getPartCatalog } from '@/lib/inventory/part-options';
import {
  adjustStock,
  createPart,
  getPartDetail,
  listMovements,
  listParts,
  reverseMovement,
  updatePart,
} from '@/lib/inventory/parts';
import {
  cancelPurchase,
  createPurchase,
  getPurchaseDetail,
  receivePurchase,
  updatePurchase,
} from '@/lib/inventory/purchases';
import {
  createSupplier,
  getSupplierDetail,
  listSuppliers,
  updateSupplier,
} from '@/lib/inventory/suppliers';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

const SEED_ORG = '00000000-0000-7000-8000-000000000001';

async function seedCounts() {
  const where = { organizationId: SEED_ORG };
  return {
    parts: await prisma.part.count({ where }),
    suppliers: await prisma.supplier.count({ where }),
    purchases: await prisma.purchase.count({ where }),
    inventory: await prisma.inventoryTransaction.count({ where }),
    partUsages: await prisma.partUsage.count({ where }),
  };
}

const stock = (org: TestOrg, partId: string) =>
  getStockOnHand(prisma, org.organizationId, org.branchId, partId);
const withPermissions = (user: AuthenticatedUser, codes: string[]): AuthenticatedUser => ({
  ...user,
  orgWidePermissions: new Set(codes),
});

/** A job in REPAIR whose approved quotation has one part line. */
async function jobInRepair(
  org: TestOrg,
  suffix: string,
  part: { description: string; quantity: string; price: string },
) {
  const { jobCardId } = await checkInVehicle(org.owner, {
    mode: 'new',
    customer: {
      name: `Stock Customer ${suffix}`,
      phone: `054 ${suffix.padStart(3, '0')} 6655`,
      email: '',
    },
    vehicle: { plateNumber: `S${suffix} ${RUN.slice(-4)}`, make: 'Toyota', model: 'Corolla' },
    visit: { complaint: 'Service', mileage: '50000' },
  });
  const inspection = await startInspection(org.owner, jobCardId, org.technicianIds[0]);
  await saveInspection(
    org.owner,
    inspection.id,
    { items: [{ description: 'Brakes', result: 'ATTENTION_NEEDED', notes: 'Worn' }] },
    { complete: true },
  );
  await saveDiagnosis(org.owner, jobCardId, {
    employeeId: org.technicianIds[0],
    findings: 'Worn parts',
    recommendedAction: 'Replace',
  });
  const estimate = await createEstimate(org.owner, jobCardId);
  await saveEstimateDraft(org.owner, estimate.id, {
    validUntil: localDateString(new Date(Date.now() + 7 * 86400000)),
    items: [
      {
        itemType: 'PART',
        description: part.description,
        quantity: part.quantity,
        unitPrice: part.price,
      },
      { itemType: 'LABOUR', description: 'Fit parts', quantity: '1', unitPrice: '100' },
    ],
  });
  await sendEstimate(org.owner, estimate.id);
  await recordCustomerDecision(org.owner, estimate.id, {
    decision: 'APPROVED',
    method: 'IN_PERSON',
  });
  await startRepair(org.owner, jobCardId);
  const lines = await prisma.estimateItem.findMany({ where: { estimateId: estimate.id } });
  return {
    jobCardId,
    partLine: lines.find((l) => l.itemType === 'PART')!.id,
    labourLine: lines.find((l) => l.itemType === 'LABOUR')!.id,
  };
}

let a: TestOrg;
let b: TestOrg;
let seedBefore: Awaited<ReturnType<typeof seedCounts>>;

before(async () => {
  seedBefore = await seedCounts();
  a = await createTestOrg('InvA');
  b = await createTestOrg('InvB');
});

after(async () => {
  await prisma.$disconnect();
});

describe('inventory management', () => {
  let supplierId: string;
  let filterId: string;
  let padsId: string;

  test('suppliers: create, duplicate name refused, edit', async () => {
    const supplier = await createSupplier(a.owner, {
      name: 'Gulf Auto Parts',
      contactName: 'Imran',
      phone: '04 222 3344',
      email: 'Sales@GulfParts.test',
      address: 'Deira',
    });
    supplierId = supplier.id;
    assert.equal(supplier.email, 'sales@gulfparts.test');
    await expectDomainError(
      createSupplier(a.owner, { name: '  gulf  auto parts ' }),
      /already exists/,
    );
    await updateSupplier(a.owner, supplierId, {
      name: 'Gulf Auto Parts',
      contactName: 'Imran K',
      phone: '04 222 3344',
      email: '',
      address: 'Deira',
    });
    // Another organization may use the same supplier name.
    await createSupplier(b.owner, { name: 'Gulf Auto Parts' });
  });

  test('parts: create with opening stock; SKU normalized; duplicate SKU refused', async () => {
    const filter = await createPart(a.owner, {
      sku: ' flt-oil-01 ',
      name: 'Oil filter',
      category: 'Filters',
      unitOfMeasure: 'Piece',
      costPrice: '14',
      sellingPrice: '28',
      reorderLevel: '5',
      preferredSupplierId: supplierId,
      openingStock: '8',
    });
    filterId = filter.id;
    assert.equal(filter.sku, 'FLT-OIL-01');
    assert.equal(filter.unitOfMeasure, 'piece');
    assert.equal(await stock(a, filterId), 8000);
    const opening = await prisma.inventoryTransaction.findFirstOrThrow({
      where: { partId: filterId },
    });
    assert.equal(opening.transactionType, 'OPENING_STOCK');
    assert.equal(opening.performedByUserId, a.owner.id);
    assert.equal(opening.unitCost?.toString(), '14');

    const pads = await createPart(a.owner, {
      sku: 'BRK-PAD-01',
      name: 'Brake pads',
      category: 'filters',
      unitOfMeasure: 'set',
      costPrice: '95',
      sellingPrice: '180',
      reorderLevel: '2',
    });
    padsId = pads.id;
    assert.equal(pads.category, 'Filters', 'category spelling reuses the existing one');
    assert.equal(await stock(a, padsId), 0);
    assert.equal(
      await prisma.inventoryTransaction.count({ where: { partId: padsId } }),
      0,
      'no opening stock row for zero',
    );

    await expectDomainError(
      createPart(a.owner, {
        sku: 'flt-oil-01',
        name: 'Copy',
        unitOfMeasure: 'piece',
        costPrice: '1',
        sellingPrice: '2',
      }),
      /already used by “Oil filter”/,
    );
    await expectDomainError(
      updatePart(a.owner, padsId, {
        sku: 'FLT-OIL-01',
        name: 'Brake pads',
        unitOfMeasure: 'set',
        costPrice: '95',
        sellingPrice: '180',
      }),
      /already used/,
    );
    await expectDomainError(
      createPart(a.owner, {
        sku: 'X1',
        name: 'Bad price',
        unitOfMeasure: 'piece',
        costPrice: '-1',
        sellingPrice: '2',
      }),
      /cost price/,
    );
    // The same SKU in another organization is fine.
    await createPart(b.owner, {
      sku: 'FLT-OIL-01',
      name: 'Oil filter (B)',
      unitOfMeasure: 'piece',
      costPrice: '10',
      sellingPrice: '20',
    });
  });

  test('catalogue: search, filters and low / out-of-stock', async () => {
    let list = await listParts(a.owner, { q: 'oil' });
    assert.deepEqual(
      list.parts.map((p) => p.sku),
      ['FLT-OIL-01'],
    );
    assert.equal(list.parts[0].state, 'IN_STOCK');
    list = await listParts(a.owner, { stock: 'out' });
    assert.deepEqual(
      list.parts.map((p) => p.sku),
      ['BRK-PAD-01'],
    );
    assert.equal(list.summary.out, 1);
    list = await listParts(a.owner, { category: 'Filters', supplierId });
    assert.deepEqual(
      list.parts.map((p) => p.sku),
      ['FLT-OIL-01'],
    );
    assert.deepEqual(list.categories, ['Filters']);

    await adjustStock(a.owner, filterId, {
      direction: 'OUT',
      quantity: '3',
      reason: 'DAMAGED',
      note: 'Dented housing',
    });
    list = await listParts(a.owner, { stock: 'low' });
    assert.deepEqual(
      list.parts.map((p) => p.sku),
      ['FLT-OIL-01'],
      '5 on hand at a minimum of 5 is low',
    );
  });

  let purchaseId: string;
  let filterLine: string;
  let padsLine: string;

  test('part picker: each part with its stock and prices, for this workshop only', async () => {
    const catalog = await getPartCatalog(a.owner);
    assert.equal(catalog.canCreate, true);
    assert.ok(Number(catalog.defaultVat) > 0, 'a new part defaults to the standard VAT rate');
    const filter = catalog.parts.find((part) => part.id === filterId);
    assert.ok(filter, 'the oil filter is offered');
    assert.equal(filter.sku, 'FLT-OIL-01');
    assert.equal(
      Number(filter.stock),
      5,
      'stock on hand from the ledger (8 opening, 3 written off)',
    );
    assert.equal(Number(filter.price), 28);
    assert.equal(Number(filter.cost), 14);
    assert.ok(catalog.suppliers.some((supplier) => supplier.id === supplierId));
    const other = await getPartCatalog(b.owner);
    assert.ok(!other.parts.some((part) => part.id === filterId), 'never another workshop’s parts');
  });

  test('purchases: a draft calculates totals on the server and does not touch stock', async () => {
    const purchase = await createPurchase(a.owner, {
      supplierId,
      supplierInvoiceNumber: 'GAP-7781',
      supplierInvoiceDate: localDateString(),
      items: JSON.stringify([
        { partId: filterId, quantity: '10', unitCost: '12.50', taxRate: '5' },
        { partId: padsId, quantity: '4', unitCost: '33.33' },
      ]),
    });
    purchaseId = purchase.id;
    assert.equal(purchase.status, 'DRAFT');
    assert.match(purchase.purchaseNumber, /^PO-\d{6}$/);
    // 10 × 12.50 = 125.00 (VAT 6.25); 4 × 33.33 = 133.32 (VAT 6.666 → 6.67)
    assert.equal(purchase.subtotal?.toString(), '258.32');
    assert.equal(purchase.taxAmount?.toString(), '12.92');
    assert.equal(purchase.totalAmount?.toString(), '271.24');
    assert.equal(await stock(a, filterId), 5000, 'a draft receives nothing');

    await expectDomainError(
      createPurchase(a.owner, {
        supplierId,
        items: [
          { partId: filterId, quantity: '1', unitCost: '1' },
          { partId: filterId, quantity: '2', unitCost: '1' },
        ],
      }),
      /only once/,
    );
    await expectDomainError(
      createPurchase(a.owner, { supplierId, items: [] }),
      /at least one part/,
    );
    await expectDomainError(
      createPurchase(a.owner, {
        supplierId,
        supplierInvoiceNumber: 'gap-7781',
        items: [{ partId: padsId, quantity: '1', unitCost: '1' }],
      }),
      /already entered as PO-/,
    );
    await expectDomainError(
      createPurchase(a.owner, {
        supplierId,
        supplierInvoiceDate: localDateString(new Date(Date.now() + 3 * 86400000)),
        items: [{ partId: padsId, quantity: '1', unitCost: '1' }],
      }),
      /future/,
    );

    // A draft can be edited; totals are recalculated.
    await updatePurchase(a.owner, purchaseId, {
      supplierId,
      supplierInvoiceNumber: 'GAP-7781',
      items: [
        { partId: filterId, quantity: '10', unitCost: '12.50', taxRate: '5' },
        { partId: padsId, quantity: '4', unitCost: '90' },
      ],
    });
    const detail = await getPurchaseDetail(a.owner, purchaseId);
    assert.equal(
      detail.purchase.totalAmount?.toString(),
      '509.25',
      '125 + 360 = 485.00 + 24.25 VAT',
    );
    filterLine = detail.lines.find((l) => l.partId === filterId)!.id;
    padsLine = detail.lines.find((l) => l.partId === padsId)!.id;
  });

  test('purchases: receiving increases stock through ledger rows, in part and then in full', async () => {
    const partial = await receivePurchase(a.owner, purchaseId, {
      [filterLine]: '6',
      [padsLine]: '',
    });
    assert.equal(partial.status, 'PARTIALLY_RECEIVED');
    assert.equal(await stock(a, filterId), 11000);
    assert.equal(await stock(a, padsId), 0);
    const receipt = await prisma.inventoryTransaction.findFirstOrThrow({
      where: { purchaseItemId: filterLine },
    });
    assert.equal(receipt.transactionType, 'PURCHASE_RECEIPT');
    assert.equal(receipt.quantity.toString(), '6');
    assert.equal(receipt.unitCost?.toString(), '12.5');
    assert.equal(receipt.performedByUserId, a.owner.id);

    await expectDomainError(
      receivePurchase(a.owner, purchaseId, { [filterLine]: '5' }),
      /only 4 still to receive/,
    );
    await expectDomainError(
      receivePurchase(a.owner, purchaseId, { [filterLine]: '0', [padsLine]: '0' }),
      /at least one line/,
    );
    await expectDomainError(
      updatePurchase(a.owner, purchaseId, {
        supplierId,
        items: [{ partId: padsId, quantity: '1', unitCost: '1' }],
      }),
      /Only a draft/,
    );
    await expectDomainError(cancelPurchase(a.owner, purchaseId), /nothing received/);

    const full = await receivePurchase(a.owner, purchaseId, null);
    assert.equal(full.status, 'RECEIVED');
    assert.equal(await stock(a, filterId), 15000);
    assert.equal(await stock(a, padsId), 4000);
    await expectDomainError(receivePurchase(a.owner, purchaseId, null), /already been received/);

    const purchase = await prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
    assert.equal(purchase.receivedByUserId, a.owner.id);
    assert.ok(purchase.receivedAt);
    // The database refuses receiving more than was ordered, even bypassing the service.
    await assert.rejects(
      prisma.purchaseItem.update({ where: { id: filterLine }, data: { quantityReceived: '11' } }),
      /purchase_items_quantities|check constraint/i,
    );
  });

  test('purchases: create-and-receive in one step; cancel a draft', async () => {
    const quick = await createPurchase(
      a.owner,
      {
        supplierId,
        supplierInvoiceNumber: 'GAP-7790',
        items: [{ partId: padsId, quantity: '2', unitCost: '90' }],
      },
      { receive: true },
    );
    assert.equal(
      (await prisma.purchase.findUniqueOrThrow({ where: { id: quick.id } })).status,
      'RECEIVED',
    );
    assert.equal(await stock(a, padsId), 6000);

    const draft = await createPurchase(a.owner, {
      supplierId,
      supplierInvoiceNumber: 'GAP-7791',
      items: [{ partId: padsId, quantity: '1', unitCost: '90' }],
    });
    await cancelPurchase(a.owner, draft.id);
    assert.equal(
      (await prisma.purchase.findUniqueOrThrow({ where: { id: draft.id } })).status,
      'CANCELLED',
    );
    await expectDomainError(receivePurchase(a.owner, draft.id, null), /can no longer be received/);
    // A cancelled entry frees its supplier invoice number.
    const again = await createPurchase(a.owner, {
      supplierId,
      supplierInvoiceNumber: 'GAP-7791',
      items: [{ partId: padsId, quantity: '1', unitCost: '90' }],
    });
    await cancelPurchase(a.owner, again.id);
  });

  test('suppliers: parts, purchase history and outstanding (value received, nothing paid yet)', async () => {
    const detail = await getSupplierDetail(a.owner, supplierId);
    // Received: 10 × 12.50 + 5% = 131.25; 4 × 90 + 5% = 378.00; 2 × 90 + 5% = 189.00 → 698.25
    assert.equal(detail.balance.received, '698.25');
    assert.equal(detail.balance.paid, '0.00');
    assert.equal(detail.balance.outstanding, '698.25');
    assert.deepEqual(
      detail.parts.map((p) => [p.part.sku, p.preferred, p.lastCost]),
      [
        ['BRK-PAD-01', false, '90'],
        ['FLT-OIL-01', true, '12.5'],
      ],
    );
    assert.equal(detail.purchases.length, 4);
    const list = await listSuppliers(a.owner, 'gulf');
    assert.equal(list.length, 1);
    assert.equal(list[0].balance.outstanding, '698.25');
  });

  test('negative stock is refused everywhere; a failed movement changes nothing', async () => {
    const before = await prisma.inventoryTransaction.count({
      where: { organizationId: a.organizationId },
    });
    await expectDomainError(
      adjustStock(a.owner, padsId, { direction: 'OUT', quantity: '6.001', reason: 'LOST' }),
      /Only 6 in stock/,
    );
    await expectDomainError(
      adjustStock(a.owner, padsId, { direction: 'OUT', quantity: '1', reason: 'OTHER' }),
      /Describe the reason/,
    );
    const job = await jobInRepair(a, '1', {
      description: 'Brake pads',
      quantity: '2',
      price: '180',
    });
    await expectDomainError(
      recordPartUsage(a.owner, job.jobCardId, {
        partId: padsId,
        quantity: '7',
        employeeId: a.technicianIds[0],
        estimateItemId: job.partLine,
      }),
      /Only 6 in stock/,
    );
    assert.equal(
      await prisma.inventoryTransaction.count({ where: { organizationId: a.organizationId } }),
      before,
    );
    assert.equal(
      await prisma.partUsage.count({ where: { jobCardId: job.jobCardId } }),
      0,
      'the part usage rolled back with the stock-out',
    );
    assert.equal(await stock(a, padsId), 6000);
  });

  test('concurrent stock-outs cannot oversell', async () => {
    const part = await createPart(a.owner, {
      sku: 'RACE-01',
      name: 'Race part',
      unitOfMeasure: 'piece',
      costPrice: '5',
      sellingPrice: '10',
      openingStock: '3',
    });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        adjustStock(a.owner, part.id, { direction: 'OUT', quantity: '1', reason: 'WORKSHOP_USE' }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 3);
    assert.equal(await stock(a, part.id), 0);
    const detail = await getPartDetail(a.owner, part.id);
    assert.ok(
      detail.history.every((m) => m.balanceMilli >= 0),
      'the running balance never went negative',
    );
  });

  test('parts without a number get an automatic code; a part without a selling price is priced on the job', async () => {
    const first = await createPart(a.owner, {
      sku: '',
      name: 'Unbranded clip',
      unitOfMeasure: 'piece',
      costPrice: '2',
      openingStock: '10',
    });
    assert.match(first.sku, /^P-\d{4,}$/);
    assert.equal(first.defaultSellingPrice, null);
    const second = await createPart(a.owner, {
      name: 'Unbranded bolt',
      unitOfMeasure: 'piece',
      costPrice: '1',
      sellingPrice: '',
    });
    assert.equal(
      Number(second.sku.slice(2)),
      Number(first.sku.slice(2)) + 1,
      'automatic codes run in sequence',
    );
    const edited = await updatePart(a.owner, first.id, {
      sku: '',
      name: 'Unbranded clip',
      unitOfMeasure: 'piece',
      costPrice: '2',
    });
    assert.equal(edited.sku, first.sku, 'saving with the code left empty keeps the automatic one');

    const clipJob = await jobInRepair(a, '3', {
      description: 'Clips',
      quantity: '2',
      price: '7.50',
    });
    await expectDomainError(
      recordPartUsage(a.owner, clipJob.jobCardId, {
        partId: first.id,
        quantity: '2',
        employeeId: a.technicianIds[0],
        estimateItemId: clipJob.partLine,
      }),
      /no selling price/,
    );
    const usage = await recordPartUsage(a.owner, clipJob.jobCardId, {
      partId: first.id,
      quantity: '2',
      employeeId: a.technicianIds[0],
      estimateItemId: clipJob.partLine,
      unitPrice: '7.50',
    });
    assert.equal(usage.unitPrice.toString(), '7.5');
    assert.equal(usage.unitCost.toString(), '2');
    assert.equal(await stock(a, first.id), 8000);
  });

  let job: Awaited<ReturnType<typeof jobInRepair>>;
  let usageId: string;

  test('using stock on a job: part usage and stock-out are one transaction', async () => {
    job = await jobInRepair(a, '2', { description: 'Brake pads', quantity: '2', price: '180' });
    const usage = await recordPartUsage(a.owner, job.jobCardId, {
      partId: padsId,
      quantity: '3',
      employeeId: a.technicianIds[0],
      estimateItemId: job.partLine,
    });
    usageId = usage.id;
    assert.equal(await stock(a, padsId), 3000);
    const out = await prisma.inventoryTransaction.findFirstOrThrow({
      where: { partUsageId: usageId },
    });
    assert.equal(out.transactionType, 'JOB_CONSUMPTION');
    assert.equal(out.quantity.toString(), '-3');
    const detail = await getPartDetail(a.owner, padsId);
    assert.equal(
      detail.history[0].partUsage?.jobCard.id,
      job.jobCardId,
      'the movement shows the job it went to',
    );
  });

  test('returns: incorrect usage is taken back with a JOB_RETURN, never deleted', async () => {
    await expectDomainError(
      returnPartFromJob(a.owner, job.jobCardId, usageId, {
        quantity: '4',
        reason: 'Counted wrong',
      }),
      /Only 3 of this part/,
    );
    await expectDomainError(
      returnPartFromJob(a.owner, job.jobCardId, usageId, { quantity: '1', reason: '' }),
      /why/,
    );
    await returnPartFromJob(a.owner, job.jobCardId, usageId, {
      quantity: '1',
      reason: 'Only two pads fitted',
    });
    assert.equal(await stock(a, padsId), 4000);
    let workspace = await getRepairWorkspace(a.owner, job.jobCardId);
    const usage = workspace.partUsages.find((u) => u.id === usageId)!;
    assert.equal(usage.netMilli, 2000);
    assert.equal(usage.returnedMilli, 1000);
    assert.equal(
      usage.returns[0].note,
      `Taken back from job ${(await prisma.jobCard.findUniqueOrThrow({ where: { id: job.jobCardId } })).jobNumber}: Only two pads fitted`,
    );
    assert.equal(workspace.approvedLines.find((l) => l.id === job.partLine)!.progress, 'DONE');

    // Taking back the rest leaves the approved line incomplete, so QC can't pass.
    await returnPartFromJob(a.owner, job.jobCardId, usageId, {
      quantity: '2',
      reason: 'Wrong pads — wrong model',
    });
    await expectDomainError(
      returnPartFromJob(a.owner, job.jobCardId, usageId, { quantity: '1', reason: 'Again' }),
      /already been taken back in full/,
    );
    workspace = await getRepairWorkspace(a.owner, job.jobCardId);
    assert.equal(
      workspace.approvedLines.find((l) => l.id === job.partLine)!.progress,
      'NOT_STARTED',
    );
    await recordLabour(a.owner, job.jobCardId, {
      employeeId: a.technicianIds[0],
      description: 'Fit parts',
      hours: '1',
      rate: '100',
      estimateItemId: job.labourLine,
    });
    await expectDomainError(
      recordQualityCheck(a.owner, job.jobCardId, {
        employeeId: a.technicianIds[0],
        result: 'PASSED',
      }),
      /approved work is incomplete/,
    );

    // The original usage and both returns are all still there.
    assert.equal(await prisma.partUsage.count({ where: { id: usageId } }), 1);
    const rows = await prisma.inventoryTransaction.findMany({
      where: { partUsageId: usageId },
      orderBy: { createdAt: 'asc' },
    });
    assert.deepEqual(
      rows.map((r) => [r.transactionType, r.quantity.toString()]),
      [
        ['JOB_CONSUMPTION', '-3'],
        ['JOB_RETURN', '1'],
        ['JOB_RETURN', '2'],
      ],
    );
    assert.equal(await stock(a, padsId), 6000);

    // Fit the right quantity; the job completes normally and billing sees only the net usage.
    await recordPartUsage(a.owner, job.jobCardId, {
      partId: padsId,
      quantity: '2',
      employeeId: a.technicianIds[0],
      estimateItemId: job.partLine,
    });
    await recordQualityCheck(a.owner, job.jobCardId, {
      employeeId: a.technicianIds[0],
      result: 'PASSED',
    });
    await expectDomainError(
      returnPartFromJob(a.owner, job.jobCardId, usageId, { quantity: '1', reason: 'Too late' }),
      /while the job is in repair/,
    );
  });

  test('reversal: an adjustment is cancelled by an equal and opposite row, once', async () => {
    const found = await adjustStock(a.owner, filterId, {
      direction: 'IN',
      quantity: '5',
      reason: 'FOUND',
    });
    const onHand = await stock(a, filterId);
    const reversal = await reverseMovement(a.owner, found.id, {
      reason: 'Entered on the wrong part',
    });
    assert.equal(reversal.transactionType, 'REVERSAL');
    assert.equal(reversal.quantity.toString(), '-5');
    assert.equal(reversal.reversalOfTransactionId, found.id);
    assert.equal(await stock(a, filterId), onHand - 5000);
    // The books follow: the reversal is booked the other way round, so the
    // adjustment and its reversal leave Inventory where it was.
    const entries = await prisma.journalEntry.findMany({
      where: { sourceType: 'STOCK_MOVEMENT', sourceId: { in: [found.id, reversal.id] } },
      select: {
        sourceId: true,
        lines: {
          select: {
            debitAmount: true,
            creditAmount: true,
            chartOfAccount: { select: { role: true } },
          },
        },
      },
    });
    assert.equal(entries.length, 2, 'both the adjustment and its reversal are booked');
    const inventoryNet = entries
      .flatMap((entry) => entry.lines)
      .filter((line) => line.chartOfAccount.role === 'INVENTORY')
      .reduce((sum, line) => sum + Number(line.debitAmount) - Number(line.creditAmount), 0);
    assert.equal(inventoryNet, 0, 'they cancel in Inventory');
    await expectDomainError(
      reverseMovement(a.owner, found.id, { reason: 'Twice' }),
      /already been reversed/,
    );
    await expectDomainError(
      reverseMovement(a.owner, reversal.id, { reason: 'Undo the undo' }),
      /Only stock adjustments/,
    );
    const consumption = await prisma.inventoryTransaction.findFirstOrThrow({
      where: { partUsageId: usageId, transactionType: 'JOB_CONSUMPTION' },
    });
    await expectDomainError(
      reverseMovement(a.owner, consumption.id, { reason: 'Wrong' }),
      /corrected from the job card/,
    );

    // Reversing stock that has since been used would go negative — refused.
    const extra = await adjustStock(a.owner, padsId, {
      direction: 'IN',
      quantity: '1',
      reason: 'FOUND',
    });
    await adjustStock(a.owner, padsId, {
      direction: 'OUT',
      quantity: String((await stock(a, padsId)) / 1000),
      reason: 'COUNT_CORRECTION',
    });
    await expectDomainError(
      reverseMovement(a.owner, extra.id, { reason: 'Not found after all' }),
      /out of stock/,
    );

    const detail = await getPartDetail(a.owner, filterId);
    const original = detail.history.find((m) => m.id === found.id)!;
    assert.equal(original.reversible, false);
    assert.equal(original.reversedBy?.id, reversal.id);
    assert.equal(
      detail.history[0].balanceMilli,
      detail.onHandMilli,
      'current stock = the ledger running balance',
    );
  });

  test('the ledger is append-only and self-consistent in the database', async () => {
    const row = await prisma.inventoryTransaction.findFirstOrThrow({
      where: { organizationId: a.organizationId },
    });
    await assert.rejects(
      prisma.inventoryTransaction.delete({ where: { id: row.id } }),
      /append-only/,
    );
    await assert.rejects(
      prisma.inventoryTransaction.update({ where: { id: row.id }, data: { quantity: '999' } }),
      /append-only/,
    );
    const base = {
      organizationId: a.organizationId,
      branchId: a.branchId,
      partId: filterId,
      performedByUserId: a.owner.id,
    };
    await assert.rejects(
      prisma.inventoryTransaction.create({
        data: { ...base, transactionType: 'JOB_RETURN', quantity: '1' },
      }),
      /inventory_job_movements_name_usage|check constraint/i,
    );
    await assert.rejects(
      prisma.inventoryTransaction.create({
        data: { ...base, transactionType: 'REVERSAL', quantity: '1' },
      }),
      /inventory_reversal_names_original|check constraint/i,
    );
    await assert.rejects(
      prisma.inventoryTransaction.create({
        data: { ...base, transactionType: 'PURCHASE_RECEIPT', quantity: '-1' },
      }),
      /check constraint|inventory_/i,
    );
    await assert.rejects(
      prisma.inventoryTransaction.create({
        data: { ...base, transactionType: 'ADJUSTMENT', quantity: '0' },
      }),
      /inventory_quantity_nonzero|check constraint/i,
    );
  });

  test('organization isolation', async () => {
    assert.ok(!(await listParts(b.owner, {})).parts.some((p) => p.id === filterId));
    await expectDomainError(getPartDetail(b.owner, filterId), /could not be found/);
    await expectDomainError(
      adjustStock(b.owner, filterId, { direction: 'IN', quantity: '1', reason: 'FOUND' }),
      /could not be found/,
    );
    await expectDomainError(
      updatePart(b.owner, filterId, {
        sku: 'X',
        name: 'Hijack',
        unitOfMeasure: 'piece',
        costPrice: '1',
        sellingPrice: '1',
      }),
      /could not be found/,
    );
    await expectDomainError(getPurchaseDetail(b.owner, purchaseId), /could not be found/);
    await expectDomainError(receivePurchase(b.owner, purchaseId, null), /could not be found/);
    await expectDomainError(cancelPurchase(b.owner, purchaseId), /could not be found/);
    await expectDomainError(getSupplierDetail(b.owner, supplierId), /could not be found/);
    await expectDomainError(
      updateSupplier(b.owner, supplierId, { name: 'Hijack' }),
      /could not be found/,
    );
    const found = await prisma.inventoryTransaction.findFirstOrThrow({
      where: { organizationId: a.organizationId, transactionType: 'ADJUSTMENT' },
    });
    await expectDomainError(
      reverseMovement(b.owner, found.id, { reason: 'Not mine' }),
      /could not be found/,
    );
    await expectDomainError(
      createPurchase(b.owner, {
        supplierId,
        items: [{ partId: filterId, quantity: '1', unitCost: '1' }],
      }),
      /Choose the supplier/,
    );
    const bSupplier = await createSupplier(b.owner, { name: 'B Supplies' });
    await expectDomainError(
      createPurchase(b.owner, {
        supplierId: bSupplier.id,
        items: [{ partId: filterId, quantity: '1', unitCost: '1' }],
      }),
      /choose a part from the catalogue/,
    );
    await expectDomainError(
      createPart(b.owner, {
        sku: 'B-2',
        name: 'Uses A supplier',
        unitOfMeasure: 'piece',
        costPrice: '1',
        sellingPrice: '2',
        preferredSupplierId: supplierId,
      }),
      /Choose a supplier/,
    );
    assert.ok(!(await listMovements(b.owner, {})).movements.some((m) => m.partId === filterId));
  });

  test('permissions', async () => {
    const viewer = a.viewer; // inventory.view only
    assert.ok((await listParts(viewer, {})).parts.length > 0, 'a viewer can see the catalogue');
    await assert.rejects(
      createPart(viewer, {
        sku: 'V-1',
        name: 'Nope',
        unitOfMeasure: 'piece',
        costPrice: '1',
        sellingPrice: '2',
      }),
      AuthError,
    );
    await assert.rejects(
      adjustStock(viewer, filterId, { direction: 'IN', quantity: '1', reason: 'FOUND' }),
      AuthError,
    );
    await assert.rejects(createSupplier(viewer, { name: 'Nope' }), AuthError);
    await assert.rejects(
      createPurchase(viewer, {
        supplierId,
        items: [{ partId: filterId, quantity: '1', unitCost: '1' }],
      }),
      AuthError,
    );
    const found = await prisma.inventoryTransaction.findFirstOrThrow({
      where: {
        organizationId: a.organizationId,
        transactionType: 'ADJUSTMENT',
        reversedBy: null,
        quantity: { gt: 0 },
      },
    });
    await assert.rejects(reverseMovement(viewer, found.id, { reason: 'Nope' }), AuthError);

    // A clerk may enter purchases but not receive stock.
    const clerk = withPermissions(a.owner, ['inventory.view', 'purchase.view', 'purchase.create']);
    const draft = await createPurchase(clerk, {
      supplierId,
      items: [{ partId: filterId, quantity: '1', unitCost: '12.50' }],
    });
    await assert.rejects(receivePurchase(clerk, draft.id, null), AuthError);
    await assert.rejects(
      createPurchase(
        clerk,
        { supplierId, items: [{ partId: filterId, quantity: '1', unitCost: '12.50' }] },
        { receive: true },
      ),
      AuthError,
    );
    // Returning a part from a job needs Parts & stock → Edit as well as job_card.edit.
    const noIssue = withPermissions(a.owner, ['job_card.view', 'job_card.edit']);
    await assert.rejects(
      returnPartFromJob(noIssue, job.jobCardId, usageId, { quantity: '1', reason: 'x'.repeat(5) }),
      AuthError,
    );
    await cancelPurchase(a.owner, draft.id);
  });

  test('audit history records every inventory change', async () => {
    const logs = await prisma.auditLog.findMany({
      where: { organizationId: a.organizationId, actorUserId: a.owner.id },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const actions = new Set(logs.map((l) => l.action));
    for (const action of [
      'supplier.created',
      'supplier.updated',
      'part.created',
      'purchase.created',
      'purchase.updated',
      'purchase.received',
      'purchase.cancelled',
      'inventory.adjusted',
      'inventory.reversed',
      'part_usage.recorded',
      'part_usage.returned',
    ]) {
      assert.ok(actions.has(action), `missing audit entry ${action}`);
    }
    const returned = logs.find((l) => l.action === 'part_usage.returned')!;
    assert.equal((returned.metadata as { reason: string }).reason, 'Only two pads fitted');
    const reversed = logs.find((l) => l.action === 'inventory.reversed')!;
    assert.equal((reversed.afterData as { reason: string }).reason, 'Entered on the wrong part');
  });

  test('existing Mohammed Mowla Auto Garage data is untouched', async () => {
    assert.deepEqual(await seedCounts(), seedBefore);
  });
});
