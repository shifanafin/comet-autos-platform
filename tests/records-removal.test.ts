/**
 * Delete on the lists — one row or many. Each record goes through its own
 * service, so what a bulk action may do is exactly what a single one may:
 * unused things are removed, things with history are archived, documents
 * are voided, cancelled or reversed, and anything unsafe is skipped with
 * the reason while the rest carry on.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { removeRecords } from '@/lib/records/remove';
import { checkInVehicle } from '@/lib/workshop/check-in';
import { createQuotation, saveEstimateDraft, sendEstimate } from '@/lib/workshop/estimates';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { recordInvoicePayment } from '@/lib/billing/invoice';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import { createTestOrg, jobStatus, RUN, type TestOrg } from './support';

let org: TestOrg;
const now = () => toLocalDateTimeInput(new Date());
const validUntil = () => localDateString(new Date(Date.now() + 7 * 86400000));

async function party(suffix: string) {
  const customer = await prisma.customer.create({
    data: { organizationId: org.organizationId, name: `Removal ${suffix}`, phone: `050 ${suffix.padStart(3, '0')} 7711` },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.organizationId,
      customerId: customer.id,
      plateNumber: `R${suffix} ${RUN.slice(-4)}`,
      make: 'Toyota',
      model: 'Corolla',
    },
  });
  return { customer, vehicle };
}

before(async () => {
  org = await createTestOrg('Removal', [
    { sku: `STOCKED-${RUN}`, name: 'Stocked filter', cost: '10', price: '20', stock: '5' },
  ]);
});

after(async () => {
  await prisma.$disconnect();
});

describe('customers and vehicles', () => {
  test('bulk delete archives the free ones and skips one with an open job card', async () => {
    const free = await party('1');
    const busy = await party('2');
    await checkInVehicle(org.owner, { mode: 'existing', vehicleId: busy.vehicle.id, visit: { complaint: 'Service' } });

    const outcome = await removeRecords(org.owner, {
      entity: 'customers',
      ids: [free.customer.id, busy.customer.id],
      reason: 'Duplicate entries',
    });
    assert.deepEqual(outcome.done, [free.customer.id]);
    assert.equal(outcome.skipped.length, 1);
    assert.equal(outcome.skipped[0].id, busy.customer.id);
    assert.match(outcome.skipped[0].reason, /open job card/);

    const archived = await prisma.customer.findUniqueOrThrow({ where: { id: free.customer.id } });
    assert.equal(archived.isActive, false, 'archived, not erased');
    assert.equal(
      (await prisma.vehicle.findUniqueOrThrow({ where: { id: free.vehicle.id } })).isActive,
      false,
      'their car goes with them',
    );
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: busy.customer.id } })).isActive, true);

    // Doing it again changes nothing and says so.
    const again = await removeRecords(org.owner, { entity: 'customers', ids: [free.customer.id] });
    assert.equal(again.done.length, 0);
    assert.match(again.skipped[0].reason, /already deleted/);
  });

  test('without the permission nothing changes, and the reason says why', async () => {
    const { vehicle } = await party('3');
    const outcome = await removeRecords(org.viewer, { entity: 'vehicles', ids: [vehicle.id] });
    assert.equal(outcome.done.length, 0);
    assert.match(outcome.skipped[0].reason, /isn't allowed/);
    assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).isActive, true);
  });

  test("another workshop's records are never touched", async () => {
    const other = await createTestOrg('RemovalOther');
    const theirs = await prisma.customer.create({
      data: { organizationId: other.organizationId, name: 'Not yours', phone: '050 999 7711' },
    });
    const outcome = await removeRecords(org.owner, { entity: 'customers', ids: [theirs.id] });
    assert.equal(outcome.done.length, 0);
    assert.equal((await prisma.customer.findUniqueOrThrow({ where: { id: theirs.id } })).isActive, true);
  });
});

describe('job cards', () => {
  test('an open job card is cancelled (kept, with its number); an invoiced one is skipped', async () => {
    const a = await party('4');
    const b = await party('5');
    const open = await checkInVehicle(org.owner, { mode: 'existing', vehicleId: a.vehicle.id, visit: { complaint: 'Noise' } });
    const billed = await checkInVehicle(org.owner, { mode: 'existing', vehicleId: b.vehicle.id, visit: { complaint: 'Oil' } });
    await createDirectInvoice(org.owner, {
      customerId: b.customer.id,
      vehicleId: b.vehicle.id,
      jobCardId: billed.jobCardId,
      items: [{ itemType: 'LABOUR', description: 'Oil change', quantity: '1', unitPrice: '100' }],
    });

    const outcome = await removeRecords(org.owner, {
      entity: 'job-cards',
      ids: [open.jobCardId, billed.jobCardId],
    });
    assert.deepEqual(outcome.done, [open.jobCardId]);
    assert.equal(await jobStatus(open.jobCardId), 'CANCELLED');
    assert.ok(await prisma.jobCard.findUnique({ where: { id: open.jobCardId } }), 'still on record');
    assert.match(outcome.skipped[0].reason, /invoiced.*Void its invoice first/);
    assert.equal(await jobStatus(billed.jobCardId), 'INVOICED');
  });
});

describe('quotations', () => {
  test('a draft is deleted; a sent quotation stays', async () => {
    const { customer, vehicle } = await party('6');
    const draft = await createQuotation(org.owner, { customerId: customer.id });
    const sent = await createQuotation(org.owner, { customerId: customer.id, vehicleId: vehicle.id });
    await saveEstimateDraft(org.owner, sent.id, {
      validUntil: validUntil(),
      items: [{ itemType: 'LABOUR', description: 'Check', quantity: '1', unitPrice: '50' }],
    });
    await sendEstimate(org.owner, sent.id);

    const outcome = await removeRecords(org.owner, { entity: 'quotations', ids: [draft.id, sent.id] });
    assert.deepEqual(outcome.done, [draft.id]);
    assert.equal(await prisma.estimate.findUnique({ where: { id: draft.id } }), null, 'draft gone');
    assert.match(outcome.skipped[0].reason, /draft that was never sent/);
    assert.equal((await prisma.estimate.findUniqueOrThrow({ where: { id: sent.id } })).status, 'SENT');
    const audit = await prisma.auditLog.findFirst({ where: { entityId: draft.id, action: 'estimate.draft_deleted' } });
    assert.ok(audit, 'the audit log keeps what the draft was');
  });
});

describe('invoices and payments', () => {
  test('voiding needs a reason; an unpaid invoice is voided, a paid one skipped; payments are reversed', async () => {
    const { customer } = await party('7');
    const line = [{ itemType: 'LABOUR' as const, description: 'Wash', quantity: '1', unitPrice: '40' }];
    const unpaid = await createDirectInvoice(org.owner, { customerId: customer.id, items: line });
    const paid = await createDirectInvoice(org.owner, { customerId: customer.id, items: line });
    const payment = await recordInvoicePayment(org.owner, paid.invoiceId, { amount: '42', method: 'CASH', receivedAt: now() });

    await assert.rejects(
      removeRecords(org.owner, { entity: 'invoices', ids: [unpaid.invoiceId] }),
      /Say why/,
      'no reason, nothing happens',
    );
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: unpaid.invoiceId } })).status, 'ISSUED');

    const voided = await removeRecords(org.owner, {
      entity: 'invoices',
      ids: [unpaid.invoiceId, paid.invoiceId],
      reason: 'Raised by mistake',
    });
    assert.deepEqual(voided.done, [unpaid.invoiceId]);
    const row = await prisma.invoice.findUniqueOrThrow({ where: { id: unpaid.invoiceId } });
    assert.equal(row.status, 'VOID');
    assert.equal(row.voidReason, 'Raised by mistake');
    assert.ok(row.invoiceNumber, 'the number stays');
    assert.match(voided.skipped[0].reason, /Reverse the payment first/);

    const paymentId = payment.id;
    const reversed = await removeRecords(org.owner, { entity: 'payments', ids: [paymentId], reason: 'Card declined' });
    assert.deepEqual(reversed.done, [paymentId]);
    assert.equal(
      await prisma.payment.count({ where: { reversalOfPaymentId: paymentId } }),
      1,
      'an opposite entry is added; the original stays',
    );
    const twice = await removeRecords(org.owner, { entity: 'payments', ids: [paymentId], reason: 'Again' });
    assert.match(twice.skipped[0].reason, /already been reversed/);
  });
});

describe('parts, suppliers and stock movements', () => {
  test('unused part removed; used part with no stock archived; stocked part skipped', async () => {
    const unused = await prisma.part.create({
      data: { organizationId: org.organizationId, sku: `UNUSED-${RUN}`, name: 'Never used', unitOfMeasure: 'piece' },
    });
    const used = await prisma.part.create({
      data: { organizationId: org.organizationId, sku: `USED-${RUN}`, name: 'Used up', unitOfMeasure: 'piece' },
    });
    for (const quantity of ['2', '-2']) {
      await prisma.inventoryTransaction.create({
        data: {
          organizationId: org.organizationId,
          branchId: org.branchId,
          partId: used.id,
          transactionType: 'ADJUSTMENT',
          quantity,
          performedByUserId: org.owner.id,
        },
      });
    }
    const stocked = org.parts[`STOCKED-${RUN}`].id;

    const outcome = await removeRecords(org.owner, { entity: 'parts', ids: [unused.id, used.id, stocked] });
    assert.deepEqual(outcome.done, [unused.id, used.id]);
    assert.equal(outcome.archived, 1);
    assert.equal(await prisma.part.findUnique({ where: { id: unused.id } }), null, 'removed outright');
    assert.equal((await prisma.part.findUniqueOrThrow({ where: { id: used.id } })).isActive, false, 'archived');
    assert.match(outcome.skipped[0].reason, /still has 5 piece in stock/);
    assert.equal((await prisma.part.findUniqueOrThrow({ where: { id: stocked } })).isActive, true);
  });

  test('unused supplier removed; one named on a part archived', async () => {
    const unused = await prisma.supplier.create({ data: { organizationId: org.organizationId, name: `Nobody ${RUN}` } });
    const named = await prisma.supplier.create({ data: { organizationId: org.organizationId, name: `Preferred ${RUN}` } });
    await prisma.part.update({ where: { id: org.parts[`STOCKED-${RUN}`].id }, data: { preferredSupplierId: named.id } });

    const outcome = await removeRecords(org.owner, { entity: 'suppliers', ids: [unused.id, named.id] });
    assert.deepEqual(outcome.done, [unused.id, named.id]);
    assert.equal(outcome.archived, 1);
    assert.equal(await prisma.supplier.findUnique({ where: { id: unused.id } }), null);
    assert.equal((await prisma.supplier.findUniqueOrThrow({ where: { id: named.id } })).isActive, false);
  });

  test('an adjustment is reversed (the original stays); a reversal can’t be reversed', async () => {
    const adjustment = await prisma.inventoryTransaction.findFirstOrThrow({
      where: { organizationId: org.organizationId, partId: org.parts[`STOCKED-${RUN}`].id },
    });
    const outcome = await removeRecords(org.owner, {
      entity: 'movements',
      ids: [adjustment.id],
      reason: 'Counted twice',
    });
    assert.deepEqual(outcome.done, [adjustment.id]);
    const reversal = await prisma.inventoryTransaction.findFirstOrThrow({
      where: { reversalOfTransactionId: adjustment.id },
    });
    assert.equal(reversal.quantity.toString(), '-5');
    assert.ok(await prisma.inventoryTransaction.findUnique({ where: { id: adjustment.id } }), 'original kept');

    const again = await removeRecords(org.owner, {
      entity: 'movements',
      ids: [reversal.id],
      reason: 'Not needed after all',
    });
    assert.equal(again.done.length, 0);
    assert.ok(again.skipped[0].reason.length > 0, again.skipped[0].reason);
  });
});

describe('guards on the request itself', () => {
  test('ids must be real ids, and at most a page at a time', async () => {
    await assert.rejects(removeRecords(org.owner, { entity: 'customers', ids: ['not-an-id'] }));
    await assert.rejects(removeRecords(org.owner, { entity: 'customers', ids: [] }), /at least one/);
    const tooMany = Array.from({ length: 101 }, () => crypto.randomUUID());
    await assert.rejects(removeRecords(org.owner, { entity: 'customers', ids: tooMany }), /up to 100/);
    await assert.rejects(removeRecords(org.owner, { entity: 'users', ids: [crypto.randomUUID()] }));
  });
});
