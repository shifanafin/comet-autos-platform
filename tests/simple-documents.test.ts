/**
 * Integration tests for the simple daily path — Work Order, Quotation,
 * Invoice, Payment — as documents in their own right, and for the promise
 * that making them optional broke nothing underneath:
 *
 *  - a work order needs only customer, vehicle and the work requested;
 *  - a quotation can exist with no work order (and with no vehicle), and can
 *    still be filed against one;
 *  - an invoice can exist with no work order, be raised from a quotation
 *    (billing exactly what was quoted), or bill a work order at any stage;
 *  - payments, receipts, PDFs, WhatsApp links and online approval work for
 *    all of them through the same services;
 *  - every quotation and invoice that existed before the migration still
 *    names the same customer, branch and vehicle it did through its job card;
 *  - the full detailed workflow still runs end to end;
 *  - organization isolation, permissions and duplicate protection hold.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { DuplicateSubmissionError } from '@/lib/errors';
import { checkInVehicle } from '@/lib/workshop/check-in';
import { startInspection, saveInspection } from '@/lib/workshop/inspection';
import { saveDiagnosis } from '@/lib/workshop/diagnosis';
import {
  createEstimate,
  createQuotation,
  recordCustomerDecision,
  reviseEstimate,
  saveEstimateDraft,
  sendEstimate,
} from '@/lib/workshop/estimates';
import { recordLabour, startRepair } from '@/lib/workshop/repair';
import { recordQualityCheck } from '@/lib/workshop/quality-check';
import {
  createInvoice,
  deliverVehicle,
  getInvoiceDetail,
  recordInvoicePayment,
  recordPayment,
} from '@/lib/billing/invoice';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import {
  getInvoiceDocument,
  getQuotationDocument,
  getReceiptDocument,
} from '@/lib/documents/build';
import { renderDocumentPdf } from '@/lib/documents/pdf/render';
import { createShareLink, shareResult } from '@/lib/customer-access/share';
import { decideQuoteAsCustomer, getQuoteAccess } from '@/lib/customer-access/quote';
import { getQuotation, listQuotations } from '@/lib/workshop/quotations';
import { listInvoices } from '@/lib/billing/lists';
import { calculateLine, calculateTotals } from '@/lib/money';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import { createTestOrg, expectDomainError, historyStatuses, jobStatus, RUN, type TestOrg } from './support';

const ORIGIN = 'https://workshop.example';
const now = () => toLocalDateTimeInput(new Date());
const validUntil = () => localDateString(new Date(Date.now() + 7 * 86400000));
/** Money as stored: two decimals, whatever Decimal.toString() trims. */
const money = (value: { toString(): string } | null | undefined) =>
  Number(value?.toString() ?? 'NaN').toFixed(2);
const key = (label: string) => `${label}-${RUN}-${Math.random().toString(36).slice(2, 10)}`.padEnd(20, 'x');

function assertPdf(pdf: Buffer) {
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'), 'a PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'a PDF trailer');
  return text;
}

/** A customer with one vehicle, created directly — no work order involved. */
async function customerWithVehicle(org: TestOrg, suffix: string) {
  const customer = await prisma.customer.create({
    data: { organizationId: org.organizationId, name: `Simple Customer ${suffix}`, phone: `050 ${suffix.padStart(3, '0')} 4411` },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.organizationId,
      customerId: customer.id,
      plateNumber: `S${suffix} ${RUN.slice(-4)}`,
      make: 'Toyota',
      model: 'Hilux',
    },
  });
  return { customer, vehicle };
}

let a: TestOrg;
let b: TestOrg;

before(async () => {
  a = await createTestOrg('SimpleA');
  b = await createTestOrg('SimpleB');
});

after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('existing data after the migration', () => {
  test('every quotation still names the branch, customer and vehicle of its job card', async () => {
    const mismatched = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM estimates e
      JOIN job_cards j ON j.id = e.job_card_id
      WHERE e.branch_id <> j.branch_id
         OR e.customer_id <> j.customer_id
         OR e.vehicle_id IS DISTINCT FROM j.vehicle_id`;
    assert.equal(Number(mismatched[0].n), 0);
    const orphaned = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM estimates WHERE branch_id IS NULL OR customer_id IS NULL`;
    assert.equal(Number(orphaned[0].n), 0);
  });

  test('every invoice with a job card names that job card’s vehicle', async () => {
    const mismatched = await prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM invoices i
      JOIN job_cards j ON j.id = i.job_card_id
      WHERE i.vehicle_id IS DISTINCT FROM j.vehicle_id`;
    assert.equal(Number(mismatched[0].n), 0);
  });
});

// ---------------------------------------------------------------------------

describe('work order: created simply', () => {
  test('customer, vehicle and the work requested are enough — no mileage, no inspection', async () => {
    const { vehicle } = await customerWithVehicle(a, '10');
    const { jobCardId, jobNumber } = await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: vehicle.id,
      visit: { complaint: 'Oil change and general check' },
    });
    assert.match(jobNumber, /^JC-/);
    const job = await prisma.jobCard.findUniqueOrThrow({ where: { id: jobCardId } });
    assert.equal(job.status, 'ARRIVED');
    assert.equal(job.odometerReading, null);
    assert.equal(job.customerComplaint, 'Oil change and general check');
    // An unread odometer doesn't wipe the vehicle's last known reading.
    assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).lastMileage, null);
  });

  test('a mileage that is given is still checked', async () => {
    const { vehicle } = await customerWithVehicle(a, '11');
    await expectDomainError(
      checkInVehicle(a.owner, { mode: 'existing', vehicleId: vehicle.id, visit: { complaint: 'Brakes', mileage: 'twelve' } }),
      /whole number of km/,
    );
    await checkInVehicle(a.owner, { mode: 'existing', vehicleId: vehicle.id, visit: { complaint: 'Brakes', mileage: '45000' } });
    assert.equal((await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } })).lastMileage, 45000);
  });

  test('the work requested is still required', async () => {
    const { vehicle } = await customerWithVehicle(a, '12');
    await expectDomainError(
      checkInVehicle(a.owner, { mode: 'existing', vehicleId: vehicle.id, visit: { complaint: '' } }),
      /Describe the work/,
    );
  });
});

// ---------------------------------------------------------------------------

describe('quotation without a work order', () => {
  let customerId: string;
  let vehicleId: string;
  let estimateId: string;

  test('customer only: saves, prices with the organization VAT rate, prints — no work order, no vehicle', async () => {
    const party = await customerWithVehicle(a, '20');
    customerId = party.customer.id;
    vehicleId = party.vehicle.id;

    const quote = await createQuotation(a.owner, { customerId });
    assert.equal(quote.jobCardId, null);
    assert.equal(quote.vehicleId, null);
    assert.equal(quote.customerId, customerId);
    assert.equal(quote.branchId, a.branchId);
    assert.equal(quote.status, 'DRAFT');
    assert.match(quote.estimateNumber, /^EST-/);

    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: validUntil(),
      items: [
        { itemType: 'LABOUR', description: 'Full service', quantity: '1.5', unitPrice: '120' },
        { itemType: 'PART', description: 'Oil filter', quantity: '1', unitPrice: '35.50' },
      ],
    });
    // The same money rules, at the organization's 5% default.
    const expected = calculateTotals([
      calculateLine({ quantity: '1.5', unitPrice: '120', taxRate: '5.00' }),
      calculateLine({ quantity: '1', unitPrice: '35.50', taxRate: '5.00' }),
    ]);
    const saved = await prisma.estimate.findUniqueOrThrow({ where: { id: quote.id } });
    assert.equal(money(saved.subtotal), expected.subtotal);
    assert.equal(money(saved.taxAmount), expected.taxAmount);
    assert.equal(money(saved.totalAmount), expected.totalAmount);
    assert.equal(expected.totalAmount, '226.28');

    const document = await getQuotationDocument(a.owner, quote.id);
    assert.equal(document.customer.name, party.customer.name);
    assert.equal(document.vehicle, null);
    assert.equal(document.meta.some((m) => m.label === 'Work order'), false);
    assertPdf(renderDocumentPdf(document));

    // The link opens by itself, so a quotation with no car on file still sends —
    // and its WhatsApp message simply has no vehicle lines.
    const { rawToken } = await sendEstimate(a.owner, quote.id);
    assert.equal((await prisma.estimate.findUniqueOrThrow({ where: { id: quote.id } })).status, 'SENT');
    assert.equal((await getQuoteAccess(rawToken)).state, 'open');
    const shared = shareResult(await createShareLink(a.owner, { kind: 'quotation', id: quote.id }), ORIGIN);
    assert.doesNotMatch(shared.message, /Vehicle:|Registration:/);
  });

  test('with a vehicle: send → WhatsApp → the customer approves online', async () => {
    const quote = await createQuotation(a.owner, { customerId, vehicleId });
    estimateId = quote.id;
    assert.equal(quote.jobCardId, null);
    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: validUntil(),
      items: [{ itemType: 'LABOUR', description: 'AC regas', quantity: '1', unitPrice: '250' }],
    });
    const { rawToken } = await sendEstimate(a.owner, quote.id);
    assert.equal((await prisma.estimate.findUniqueOrThrow({ where: { id: quote.id } })).status, 'SENT');

    const shared = shareResult(await createShareLink(a.owner, { kind: 'quotation', id: quote.id }), ORIGIN);
    assert.match(shared.whatsappUrl, /^https:\/\/wa\.me\/971500204411\?text=/);
    assert.match(shared.message, /Quotation: EST-/);
    assert.match(shared.message, /Registration: S20/);
    assert.match(shared.message, /Total: AED 262\.50/);

    assert.equal((await getQuoteAccess(rawToken)).state, 'open');
    await decideQuoteAsCustomer(rawToken, 'APPROVED', 'Go ahead');

    const approved = await prisma.estimate.findUniqueOrThrow({
      where: { id: quote.id },
      include: { approvals: true },
    });
    assert.equal(approved.status, 'APPROVED');
    assert.equal(approved.approvals[0].customerId, customerId);
    assert.equal(approved.approvals[0].approvalMethod, 'ONLINE');
  });

  test('revising a standalone quotation versions it and revokes the old link', async () => {
    const quote = await createQuotation(a.owner, { customerId, vehicleId });
    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: validUntil(),
      items: [{ itemType: 'PART', description: 'Battery', quantity: '1', unitPrice: '420' }],
    });
    const { rawToken } = await sendEstimate(a.owner, quote.id);
    const revision = await reviseEstimate(a.owner, quote.id);
    assert.equal(revision.version, 2);
    assert.equal(revision.jobCardId, null);
    assert.equal(revision.customerId, customerId);
    assert.equal(revision.vehicleId, vehicleId);
    assert.equal((await getQuoteAccess(rawToken)).state, 'invalid', 'the old link stops working');

    const screen = await getQuotation(a.owner, revision.id);
    assert.deepEqual(screen.versions.map((v) => v.version), [2, 1]);
  });

  test('listed with the rest, whether or not it has a work order', async () => {
    const { quotations } = await listQuotations(a.owner, { q: 'Simple Customer 20' });
    assert.ok(quotations.some((q) => q.id === estimateId && q.jobCard === null));
  });
});

// ---------------------------------------------------------------------------

describe('quotation connected to a work order', () => {
  test('a work order can be quoted straight away — inspection and diagnosis are optional', async () => {
    const { vehicle } = await customerWithVehicle(a, '30');
    const { jobCardId } = await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: vehicle.id,
      visit: { complaint: 'Replace wipers' },
    });
    const estimate = await createEstimate(a.owner, jobCardId);
    assert.equal(estimate.jobCardId, jobCardId);
    assert.equal(estimate.vehicleId, vehicle.id);
    assert.equal(await jobStatus(jobCardId), 'ESTIMATE');
    // The history shows the skip honestly: no invented inspection or diagnosis.
    assert.deepEqual(await historyStatuses(jobCardId), ['ARRIVED', 'ESTIMATE']);
  });

  test('a quotation raised from the customer can be filed against their open work order', async () => {
    const { customer, vehicle } = await customerWithVehicle(a, '31');
    const { jobCardId } = await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: vehicle.id,
      visit: { complaint: 'Tyres' },
    });
    const quote = await createQuotation(a.owner, { customerId: customer.id, jobCardId });
    assert.equal(quote.jobCardId, jobCardId);
    assert.equal(quote.vehicleId, vehicle.id, 'the work order’s vehicle is taken');
    assert.equal(await jobStatus(jobCardId), 'ESTIMATE');
    await expectDomainError(
      createQuotation(a.owner, { customerId: customer.id, jobCardId }),
      /already has quotation/,
    );
  });

  test('a work order and a vehicle must belong to the customer', async () => {
    const one = await customerWithVehicle(a, '32');
    const two = await customerWithVehicle(a, '33');
    await expectDomainError(
      createQuotation(a.owner, { customerId: one.customer.id, vehicleId: two.vehicle.id }),
      /belongs to a different customer/,
    );
    const { jobCardId } = await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: two.vehicle.id,
      visit: { complaint: 'Service' },
    });
    await expectDomainError(
      createQuotation(a.owner, { customerId: one.customer.id, jobCardId }),
      /belongs to a different customer/,
    );
  });
});

// ---------------------------------------------------------------------------

describe('invoice without a work order', () => {
  let invoiceId: string;
  let customerId: string;

  test('typed lines: issued straight away, VAT from the organization, own number, no work order', async () => {
    const party = await customerWithVehicle(a, '40');
    customerId = party.customer.id;
    const result = await createDirectInvoice(a.owner, {
      customerId,
      vehicleId: party.vehicle.id,
      items: [
        { itemType: 'PART', description: 'Wheel alignment', quantity: '1', unitPrice: '150' },
        { itemType: 'PART', description: 'Tyre rotation', quantity: '4', unitPrice: '12.75' },
      ],
      notes: 'Thank you',
    });
    invoiceId = result.invoiceId;
    assert.match(result.invoiceNumber, /^INV-/);

    const invoice = await getInvoiceDetail(a.owner, invoiceId);
    const expected = calculateTotals([
      calculateLine({ quantity: '1', unitPrice: '150', taxRate: '5.00' }),
      calculateLine({ quantity: '4', unitPrice: '12.75', taxRate: '5.00' }),
    ]);
    assert.equal(invoice.jobCardId, null);
    assert.equal(invoice.vehicleId, party.vehicle.id);
    assert.equal(invoice.status, 'ISSUED');
    assert.equal(money(invoice.subtotal), expected.subtotal);
    assert.equal(money(invoice.taxAmount), expected.taxAmount);
    assert.equal(money(invoice.totalAmount), '211.05');
    assert.equal(invoice.customerName, party.customer.name, 'customer details are snapshotted');
    assert.equal(invoice.sellerLegalName, `Test SimpleA ${RUN}`);
    assert.equal(invoice.balanceDue, '211.05');

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: a.organizationId, action: 'invoice.issued', entityId: invoiceId },
    });
    assert.ok(audit, 'the issue is audited');
  });

  test('record payment → receipt → PDF → WhatsApp', async () => {
    await expectDomainError(
      recordInvoicePayment(a.owner, invoiceId, { amount: '500', method: 'CASH', receivedAt: now() }),
      /more than the balance due \(211\.05\)/,
    );
    const first = await recordInvoicePayment(a.owner, invoiceId, { amount: '100', method: 'CARD', receivedAt: now() });
    assert.match(first.paymentNumber!, /^RCT-/);
    assert.equal((await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } })).status, 'PARTIALLY_PAID');
    await recordInvoicePayment(a.owner, invoiceId, { amount: '111.05', method: 'CASH', receivedAt: now() });
    const paid = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.balanceDue, '0.00');
    await expectDomainError(
      recordInvoicePayment(a.owner, invoiceId, { amount: '1', method: 'CASH', receivedAt: now() }),
      /already fully paid/,
    );

    const receipt = await getReceiptDocument(a.owner, first.id);
    assert.equal(money(receipt.highlight?.amount), '100.00');
    assert.ok(receipt.details.some((d) => d.label === 'Remaining balance' && /111\.05/.test(d.value)));
    assertPdf(renderDocumentPdf(receipt));

    const invoicePdf = assertPdf(renderDocumentPdf(await getInvoiceDocument(a.owner, invoiceId)));
    assert.ok(invoicePdf.length > 1000);

    const shared = shareResult(await createShareLink(a.owner, { kind: 'receipt', id: first.id }), ORIGIN);
    assert.match(shared.message, /Receipt: RCT-/);
    assert.match(shared.message, /Registration: S40/);
    assert.match(shared.link, /^https:\/\/workshop\.example\/customer\/invoice\//);
  });

  test('without a vehicle: issued, printed, paid and shared like any other', async () => {
    const result = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'PART', description: 'Car wash', quantity: '1', unitPrice: '40' }],
    });
    const invoice = await getInvoiceDetail(a.owner, result.invoiceId);
    assert.equal(invoice.vehicleId, null);
    assert.equal(money(invoice.totalAmount), '42.00');
    assertPdf(renderDocumentPdf(await getInvoiceDocument(a.owner, result.invoiceId)));
    await recordInvoicePayment(a.owner, result.invoiceId, { amount: '42', method: 'CASH', receivedAt: now() });
    assert.equal((await getInvoiceDetail(a.owner, result.invoiceId)).status, 'PAID');
    const shared = shareResult(
      await createShareLink(a.owner, { kind: 'invoice', id: result.invoiceId }),
      ORIGIN,
    );
    assert.match(shared.link, /\/customer\/invoice\/[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(shared.message, /Vehicle:|Registration:/);
  });

  test('refuses an invoice with nothing on it, and lines that do not add up', async () => {
    await expectDomainError(createDirectInvoice(a.owner, { customerId, items: [] }), /at least one line/);
    await expectDomainError(
      createDirectInvoice(a.owner, { customerId, items: [{ itemType: 'PART', description: 'Oil', quantity: '0', unitPrice: '10' }] }),
      /Line 1: Quantity must be greater than zero/,
    );
  });

  test('found in the invoices list by its own vehicle', async () => {
    const { invoices } = await listInvoices(a.owner, { q: `S40 ${RUN.slice(-4)}` });
    assert.ok(invoices.some((i) => i.id === invoiceId && i.jobCard === null));
  });
});

// ---------------------------------------------------------------------------

describe('invoice from a quotation, and from a work order', () => {
  test('quotation → invoice bills exactly what was quoted', async () => {
    const { customer, vehicle } = await customerWithVehicle(a, '50');
    const quote = await createQuotation(a.owner, { customerId: customer.id, vehicleId: vehicle.id });
    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: validUntil(),
      items: [
        { itemType: 'LABOUR', description: 'Brake service', quantity: '2.25', unitPrice: '133.33' },
        { itemType: 'PART', description: 'Pads', quantity: '1', unitPrice: '199.99' },
      ],
    });
    // A draft can't be billed: the customer hasn't seen it.
    await expectDomainError(
      createDirectInvoice(a.owner, { customerId: customer.id, estimateId: quote.id }),
      /Finish and send the quotation/,
    );
    await sendEstimate(a.owner, quote.id);
    await recordCustomerDecision(a.owner, quote.id, { decision: 'APPROVED', method: 'PHONE' });

    const { invoiceId } = await createDirectInvoice(a.owner, { customerId: customer.id, estimateId: quote.id });
    const [invoice, estimate] = await Promise.all([
      getInvoiceDetail(a.owner, invoiceId),
      prisma.estimate.findUniqueOrThrow({ where: { id: quote.id } }),
    ]);
    assert.equal(money(invoice.subtotal), money(estimate.subtotal));
    assert.equal(money(invoice.taxAmount), money(estimate.taxAmount));
    assert.equal(money(invoice.totalAmount), money(estimate.totalAmount));
    assert.equal(invoice.items.length, 2);
    assert.equal(invoice.jobCardId, null);

    // Another customer's quotation can't be billed to this one.
    const other = await customerWithVehicle(a, '51');
    await expectDomainError(
      createDirectInvoice(a.owner, { customerId: other.customer.id, estimateId: quote.id }),
      /belongs to a different customer/,
    );
  });

  test('a rejected quotation is not billed', async () => {
    const { customer, vehicle } = await customerWithVehicle(a, '52');
    const quote = await createQuotation(a.owner, { customerId: customer.id, vehicleId: vehicle.id });
    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: validUntil(),
      items: [{ itemType: 'PART', description: 'Mirror', quantity: '1', unitPrice: '300' }],
    });
    await sendEstimate(a.owner, quote.id);
    await recordCustomerDecision(a.owner, quote.id, { decision: 'REJECTED', method: 'PHONE' });
    await expectDomainError(
      createDirectInvoice(a.owner, { customerId: customer.id, estimateId: quote.id }),
      /rejected by the customer/,
    );
  });

  test('journey: work order → quotation → approval → invoice → payment → receipt', async () => {
    const { customer, vehicle } = await customerWithVehicle(a, '53');
    const { jobCardId } = await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: vehicle.id,
      visit: { complaint: 'Service and brakes' },
    });
    const estimate = await createEstimate(a.owner, jobCardId);
    await saveEstimateDraft(a.owner, estimate.id, {
      validUntil: validUntil(),
      items: [{ itemType: 'LABOUR', description: 'Service', quantity: '1', unitPrice: '400' }],
    });
    await sendEstimate(a.owner, estimate.id);
    await recordCustomerDecision(a.owner, estimate.id, { decision: 'APPROVED', method: 'IN_PERSON' });
    assert.equal(await jobStatus(jobCardId), 'APPROVED');

    // Billed from the quotation: the work order it belongs to is billed with it.
    const { invoiceId } = await createDirectInvoice(a.owner, { customerId: customer.id, estimateId: estimate.id });
    const invoice = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(invoice.jobCardId, jobCardId);
    assert.equal(money(invoice.totalAmount), '420.00');
    assert.equal(await jobStatus(jobCardId), 'INVOICED');

    // The work order's own payment screen and the invoice's share one rule.
    await recordPayment(a.owner, jobCardId, { amount: '420', method: 'CASH', receivedAt: now() });
    assert.equal(await jobStatus(jobCardId), 'PAID');
    const payment = await prisma.payment.findFirstOrThrow({ where: { invoiceId } });
    assertPdf(renderDocumentPdf(await getReceiptDocument(a.owner, payment.id)));
    assert.deepEqual(await historyStatuses(jobCardId), [
      'ARRIVED',
      'ESTIMATE',
      'WAITING_APPROVAL',
      'APPROVED',
      'INVOICED',
      'PAID',
    ]);

    // Handover still works on a work order that skipped repair and QC.
    await deliverVehicle(a.owner, jobCardId, {});
    assert.equal(await jobStatus(jobCardId), 'DELIVERED');
  });

  test('a work order can be invoiced directly, once', async () => {
    const { customer, vehicle } = await customerWithVehicle(a, '54');
    const { jobCardId } = await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: vehicle.id,
      visit: { complaint: 'Puncture repair' },
    });
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId: customer.id,
      jobCardId,
      items: [{ itemType: 'PART', description: 'Puncture repair', quantity: '1', unitPrice: '30' }],
    });
    const invoice = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(invoice.jobCardId, jobCardId);
    assert.equal(invoice.vehicleId, vehicle.id, 'the work order’s vehicle is billed');
    assert.equal(await jobStatus(jobCardId), 'INVOICED');
    await expectDomainError(
      createDirectInvoice(a.owner, {
        customerId: customer.id,
        jobCardId,
        items: [{ itemType: 'PART', description: 'Again', quantity: '1', unitPrice: '30' }],
      }),
      /already invoiced/,
    );
  });
});

// ---------------------------------------------------------------------------

describe('the detailed workflow is untouched', () => {
  test('check-in → inspection → diagnosis → estimate → approval → repair → QC → invoice → payment → delivery', async () => {
    const { vehicle } = await customerWithVehicle(a, '60');
    const { jobCardId } = await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: vehicle.id,
      visit: { complaint: 'Engine noise', mileage: '120000' },
    });
    const inspection = await startInspection(a.owner, jobCardId, a.technicianIds[0]);
    await saveInspection(a.owner, inspection.id, { items: [{ itemType: 'PART', description: 'Engine', result: 'FAILED', notes: 'Belt' }] }, { complete: true });
    await saveDiagnosis(a.owner, jobCardId, {
      employeeId: a.technicianIds[0],
      findings: 'Worn drive belt',
      recommendedAction: 'Replace drive belt',
    });
    const estimate = await createEstimate(a.owner, jobCardId);
    await saveEstimateDraft(a.owner, estimate.id, {
      validUntil: validUntil(),
      items: [{ itemType: 'LABOUR', description: 'Replace drive belt', quantity: '1', unitPrice: '200' }],
    });
    await sendEstimate(a.owner, estimate.id);
    await recordCustomerDecision(a.owner, estimate.id, { decision: 'APPROVED', method: 'IN_PERSON' });
    const line = await prisma.estimateItem.findFirstOrThrow({ where: { estimateId: estimate.id } });
    await startRepair(a.owner, jobCardId);
    await recordLabour(a.owner, jobCardId, {
      employeeId: a.technicianIds[0],
      description: 'Replace drive belt',
      hours: '1',
      rate: '200',
      estimateItemId: line.id,
    });
    await recordQualityCheck(a.owner, jobCardId, { employeeId: a.technicianIds[1], result: 'PASSED' });
    assert.equal(await jobStatus(jobCardId), 'READY');

    const invoice = await createInvoice(a.owner, jobCardId);
    assert.equal(money(invoice.totalAmount), '210.00');
    assert.equal(invoice.vehicleId, vehicle.id, 'a workflow invoice names its vehicle too');
    await recordPayment(a.owner, jobCardId, { amount: '210', method: 'CARD', receivedAt: now() });
    await deliverVehicle(a.owner, jobCardId, {});
    assert.deepEqual(await historyStatuses(jobCardId), [
      'ARRIVED',
      'INSPECTION',
      'DIAGNOSIS',
      'ESTIMATE',
      'WAITING_APPROVAL',
      'APPROVED',
      'REPAIR',
      'QUALITY_CHECK',
      'READY',
      'INVOICED',
      'PAID',
      'DELIVERED',
    ]);
  });

  test('the repair-derived invoice still waits for the quality check', async () => {
    const { vehicle } = await customerWithVehicle(a, '61');
    const { jobCardId } = await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: vehicle.id,
      visit: { complaint: 'Noise' },
    });
    await expectDomainError(createInvoice(a.owner, jobCardId), /passed its quality check/);
  });
});

// ---------------------------------------------------------------------------

describe('isolation, permissions and duplicate protection', () => {
  test('another organization can see and use none of it', async () => {
    const { customer, vehicle } = await customerWithVehicle(a, '70');
    const quote = await createQuotation(a.owner, { customerId: customer.id, vehicleId: vehicle.id });
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId: customer.id,
      items: [{ itemType: 'PART', description: 'Check', quantity: '1', unitPrice: '50' }],
    });

    await expectDomainError(createQuotation(b.owner, { customerId: customer.id }), /Choose the customer/);
    await expectDomainError(
      createDirectInvoice(b.owner, { customerId: customer.id, items: [{ itemType: 'PART', description: 'x', quantity: '1', unitPrice: '1' }] }),
      /Choose the customer/,
    );
    await expectDomainError(getQuotation(b.owner, quote.id), /could not be found/);
    await expectDomainError(getInvoiceDetail(b.owner, invoiceId), /could not be found/);
    await expectDomainError(
      recordInvoicePayment(b.owner, invoiceId, { amount: '1', method: 'CASH', receivedAt: now() }),
      /could not be found/,
    );
    await expectDomainError(
      createShareLink(b.owner, { kind: 'invoice', id: invoiceId }),
      /could not be found/,
    );
    const { quotations } = await listQuotations(b.owner, {});
    assert.equal(quotations.some((q) => q.id === quote.id), false);
  });

  test('permissions are checked on the server, not only hidden in the screen', async () => {
    const { customer } = await customerWithVehicle(a, '71');
    await assert.rejects(createQuotation(a.viewer, { customerId: customer.id }), AuthError);
    await assert.rejects(
      createDirectInvoice(a.viewer, { customerId: customer.id, items: [{ itemType: 'PART', description: 'x', quantity: '1', unitPrice: '1' }] }),
      AuthError,
    );
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId: customer.id,
      items: [{ itemType: 'PART', description: 'Check', quantity: '1', unitPrice: '10' }],
    });
    await assert.rejects(
      recordInvoicePayment(a.viewer, invoiceId, { amount: '1', method: 'CASH', receivedAt: now() }),
      AuthError,
    );
    await assert.rejects(getInvoiceDetail(a.viewer, invoiceId), AuthError);
  });

  test('a double-submitted form creates one quotation, one invoice, one payment', async () => {
    const { customer } = await customerWithVehicle(a, '72');

    const quoteInput = { customerId: customer.id, requestKey: key('quote') };
    const quote = await createQuotation(a.owner, quoteInput);
    await assert.rejects(createQuotation(a.owner, quoteInput), (error: unknown) => {
      assert.ok(error instanceof DuplicateSubmissionError);
      assert.equal(error.resultId, quote.id);
      return true;
    });
    assert.equal(await prisma.estimate.count({ where: { customerId: customer.id } }), 1);

    const invoiceInput = {
      customerId: customer.id,
      items: [{ itemType: 'PART', description: 'Service', quantity: '1', unitPrice: '100' }],
      requestKey: key('invoice'),
    };
    // Two at once, as a double tap sends them.
    const results = await Promise.allSettled([
      createDirectInvoice(a.owner, invoiceInput),
      createDirectInvoice(a.owner, invoiceInput),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.ok(
      results.some((r) => r.status === 'rejected' && r.reason instanceof DuplicateSubmissionError),
    );
    const invoices = await prisma.invoice.findMany({ where: { customerId: customer.id } });
    assert.equal(invoices.length, 1);

    const paymentInput = { amount: '50', method: 'CASH', receivedAt: now(), requestKey: key('pay') };
    await recordInvoicePayment(a.owner, invoices[0].id, paymentInput);
    await assert.rejects(recordInvoicePayment(a.owner, invoices[0].id, paymentInput), DuplicateSubmissionError);
    assert.equal(await prisma.payment.count({ where: { invoiceId: invoices[0].id } }), 1);
  });

  test('concurrent payments can never take an invoice past its total', async () => {
    const { customer } = await customerWithVehicle(a, '73');
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId: customer.id,
      items: [{ itemType: 'PART', description: 'Service', quantity: '1', unitPrice: '100' }],
    });
    const results = await Promise.allSettled(
      [1, 2, 3].map(() => recordInvoicePayment(a.owner, invoiceId, { amount: '60', method: 'CASH', receivedAt: now() })),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'only one 60 fits in 105');
    const invoice = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(invoice.paidAmount, '60.00');
    assert.equal(invoice.balanceDue, '45.00');
  });
});

// ---------------------------------------------------------------------------

/** The owner's own quotation sheet, line for line: 19 parts and one labour line. */
const OWNER_SHEET = [
  ['PART', 'IGNITION COIL', '4', '85'],
  ['PART', 'GASKET', '1', '45'],
  ['PART', 'AIR FILTER', '1', '25'],
  ['PART', 'P/S HOSE', '1', '155'],
  ['PART', 'COOLANT', '1', '25'],
  ['PART', 'OIL SEAL', '1', '40'],
  ['PART', 'OIL SEAL', '1', '80'],
  ['PART', 'OIL SEAL', '1', '40'],
  ['PART', 'A/T FILTER', '1', '140'],
  ['PART', 'GEAR GASKET', '1', '35'],
  ['PART', 'ATM FLUID W/S', '1', '120'],
  ['PART', 'RACK END', '2', '50'],
  ['PART', 'TIE ROD', '2', '45'],
  ['PART', 'LOWER ARM SUB ASSY', '2', '90'],
  ['PART', 'LINK ROD', '2', '40'],
  ['PART', 'CUT BUSH', '2', '30'],
  ['PART', 'WIPER BLADE', '1', '20'],
  ['PART', 'AC FILTER', '1', '20'],
  ['PART', 'POWER STEERING PUMP', '1', '290'],
  ['LABOUR', 'LABOR AND CONSUMABLES', '1', '2000'],
] as const;

const pdfStrings = (pdf: Buffer) =>
  [...pdf.toString('latin1').matchAll(/\((.*?)\) Tj/g)].map((m) => m[1].replace(/\\([()\\])/g, '$1'));

describe("the owner's quotation sheet", () => {
  test('entered as he writes it, it prices and prints exactly like his sheet', async () => {
    const { customer, vehicle } = await customerWithVehicle(a, '80');
    const quote = await createQuotation(a.owner, { customerId: customer.id, vehicleId: vehicle.id });
    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: validUntil(),
      items: OWNER_SHEET.map(([itemType, description, quantity, unitPrice]) => ({
        itemType,
        description,
        quantity,
        unitPrice,
      })),
    });

    // His totals: 3885 + 5% VAT 194.25 = 4079.25.
    const saved = await prisma.estimate.findUniqueOrThrow({ where: { id: quote.id } });
    assert.equal(money(saved.subtotal), '3885.00');
    assert.equal(money(saved.taxAmount), '194.25');
    assert.equal(money(saved.totalAmount), '4079.25');

    await sendEstimate(a.owner, quote.id);
    const document = await getQuotationDocument(a.owner, quote.id);
    const lines = document.sections.flatMap((s) => s.lines);
    assert.equal(lines.length, 20);
    assert.deepEqual(
      lines.map((l) => [l.type, l.description]),
      OWNER_SHEET.map(([type, description]) => [type === 'PART' ? 'PARTS' : 'LABOUR', description]),
      'every line, in the order he wrote it, with its type',
    );
    assert.deepEqual(
      document.totals.map((t) => [t.label, money(t.amount)]),
      [
        ['Total excl. VAT', '3885.00'],
        ['VAT 5%', '194.25'],
        ['Total', '4079.25'],
      ],
    );

    const text = pdfStrings(renderDocumentPdf(document));
    for (const heading of ['S.NO', 'TYPE', 'DESCRIPTION', 'QTY', 'PRICE', 'AMOUNT']) {
      assert.ok(text.includes(heading), `PDF column ${heading}`);
    }
    assert.ok(text.includes('POWER STEERING PUMP'));
    assert.ok(text.includes('20'), 'the last line is numbered 20');
    assert.equal(text.filter((t) => t === 'PARTS').length, 19);
    assert.equal(text.filter((t) => t === 'LABOUR').length, 1);
    assert.ok(text.includes('AED 4,079.25'));
    // One rate on every line: the totals say "VAT 5%" and no line repeats it.
    assert.ok(text.includes('VAT 5%'));
    assert.equal(text.some((t) => /^\d+(\.\d+)?%$/.test(t)), false, 'no per-line VAT column');
  });

  test('billed from that quotation, the invoice keeps every line’s type', async () => {
    const { customer, vehicle } = await customerWithVehicle(a, '81');
    const quote = await createQuotation(a.owner, { customerId: customer.id, vehicleId: vehicle.id });
    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: validUntil(),
      items: OWNER_SHEET.map(([itemType, description, quantity, unitPrice]) => ({ itemType, description, quantity, unitPrice })),
    });
    await sendEstimate(a.owner, quote.id);
    await recordCustomerDecision(a.owner, quote.id, { decision: 'APPROVED', method: 'PHONE' });
    const { invoiceId } = await createDirectInvoice(a.owner, { customerId: customer.id, estimateId: quote.id });

    const invoice = await getInvoiceDetail(a.owner, invoiceId);
    assert.equal(money(invoice.totalAmount), '4079.25');
    assert.deepEqual(
      invoice.items.map((i) => i.itemType),
      OWNER_SHEET.map(([type]) => type),
    );
    const document = await getInvoiceDocument(a.owner, invoiceId);
    assert.deepEqual(
      document.sections.flatMap((s) => s.lines).map((l) => l.type),
      OWNER_SHEET.map(([type]) => (type === 'PART' ? 'PARTS' : 'LABOUR')),
    );
  });

  test('a typed invoice line must say parts or labour, and keeps it', async () => {
    const { customer } = await customerWithVehicle(a, '82');
    await expectDomainError(
      createDirectInvoice(a.owner, {
        customerId: customer.id,
        items: [{ description: 'Untyped', quantity: '1', unitPrice: '10' }],
      }),
      /parts or labour/,
    );
    const { invoiceId } = await createDirectInvoice(a.owner, {
      customerId: customer.id,
      items: [
        { itemType: 'PART', description: 'Brake pads', quantity: '1', unitPrice: '180' },
        { itemType: 'LABOUR', description: 'Fitting', quantity: '1', unitPrice: '100' },
      ],
    });
    const invoice = await getInvoiceDetail(a.owner, invoiceId);
    assert.deepEqual(invoice.items.map((i) => i.itemType), ['PART', 'LABOUR']);
  });
});
