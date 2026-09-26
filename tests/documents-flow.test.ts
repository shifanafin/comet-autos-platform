/**
 * Integration tests for customer documents and sharing: quotation, invoice
 * and receipt documents and their PDFs, WhatsApp messages and links, and the
 * secure customer links behind them — against the local database.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { checkInVehicle } from '@/lib/workshop/check-in';
import { startInspection, saveInspection } from '@/lib/workshop/inspection';
import { saveDiagnosis } from '@/lib/workshop/diagnosis';
import {
  createEstimate,
  recordCustomerDecision,
  saveEstimateDraft,
  sendEstimate,
} from '@/lib/workshop/estimates';
import { recordLabour, recordPartUsage, startRepair } from '@/lib/workshop/repair';
import { recordQualityCheck } from '@/lib/workshop/quality-check';
import { createInvoice, getJobInvoice, recordPayment } from '@/lib/billing/invoice';
import {
  getInvoiceDocument,
  getInvoiceDocumentForLink,
  getJobDocuments,
  getQuotationDocument,
  getQuotationDocumentForLink,
  getReceiptDocument,
  getReceiptDocumentForLink,
} from '@/lib/documents/build';
import { formatAed } from '@/lib/documents/model';
import { renderDocumentPdf } from '@/lib/documents/pdf/render';
import { sanitizePdfText, wrapText } from '@/lib/documents/pdf/writer';
import { createShareLink, shareResult } from '@/lib/customer-access/share';
import { getCustomerAccess } from '@/lib/customer-access/access';
import { hashToken } from '@/lib/customer-access/tokens';
import {
  invoiceMessage,
  normalizeWhatsAppNumber,
  quotationMessage,
  whatsAppUrl,
} from '@/lib/sharing/whatsapp';
import { localDateString, toLocalDateTimeInput } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

const ORIGIN = 'https://workshop.example';
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const PARTS = [
  { sku: 'AC-CLUTCH', name: 'AC compressor clutch', cost: '310.00', price: '480.00', stock: '3' },
];

/** Checks the PDF is structurally sound: header, every xref offset lands on its object, trailer. */
function assertValidPdf(pdf: Buffer) {
  const text = pdf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const startxref = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.ok(text.slice(startxref).startsWith('xref'), 'startxref points at the xref table');
  const entries = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
    Number(m[1]),
  );
  entries.forEach((offset, index) =>
    assert.ok(text.slice(offset).startsWith(`${index + 1} 0 obj`), `object ${index + 1} offset`),
  );
  return text;
}

/** Visible text of a PDF: the literal strings drawn with Tj. */
const pdfText = (pdf: Buffer) =>
  [...pdf.toString('latin1').matchAll(/\((.*?)\) Tj/g)]
    .map((m) => m[1].replace(/\\([()\\])/g, '$1'))
    .join('\n');

let a: TestOrg;
let b: TestOrg;
let jobCardId: string;
let estimateId: string;
let invoiceId: string;
let firstPaymentId: string;
let secondPaymentId: string;
const plate = `D${RUN.slice(-4)} 77`;

before(async () => {
  a = await createTestOrg('DocA', PARTS);
  b = await createTestOrg('DocB', PARTS);
  await prisma.organization.update({
    where: { id: a.organizationId },
    data: {
      name: 'Comet Autos',
      phone: '04 555 1234',
      email: 'service@comet.test',
      taxNumber: '100200300400003',
    },
  });

  ({ jobCardId } = await checkInVehicle(a.owner, {
    mode: 'new',
    customer: { name: 'Ahmed Al Marzooqi', phone: '050 123 4567', email: '' },
    vehicle: { plateNumber: plate, make: 'Toyota', model: 'Camry' },
    visit: { complaint: 'AC not cooling', mileage: '64000' },
  }));
  const inspection = await startInspection(a.owner, jobCardId, a.technicianIds[0]);
  await saveInspection(
    a.owner,
    inspection.id,
    { items: [{ description: 'Air conditioning', result: 'FAILED', notes: 'Clutch' }] },
    { complete: true },
  );
  await saveDiagnosis(a.owner, jobCardId, {
    employeeId: a.technicianIds[0],
    findings: 'Clutch failed',
    recommendedAction: 'Replace clutch',
  });
  const estimate = await createEstimate(a.owner, jobCardId);
  estimateId = estimate.id;
  await saveEstimateDraft(a.owner, estimateId, {
    validUntil: localDateString(new Date(Date.now() + 7 * 86400000)),
    items: [
      {
        itemType: 'LABOUR',
        description: 'Replace AC compressor clutch',
        quantity: '2.5',
        unitPrice: '150',
      },
      { itemType: 'PART', description: 'AC compressor clutch', quantity: '1', unitPrice: '480' },
    ],
  });
});

after(async () => {
  await prisma.$disconnect();
});

describe('customer documents and sharing', () => {
  test('a draft quotation cannot be shared; a sent one produces a WhatsApp message and a secure link', async () => {
    await expectDomainError(
      createShareLink(a.owner, { kind: 'quotation', id: estimateId }),
      /Send the quotation first/,
    );
    await sendEstimate(a.owner, estimateId);

    const shared = shareResult(
      await createShareLink(a.owner, { kind: 'quotation', id: estimateId }),
      ORIGIN,
    );
    assert.match(shared.link, /^https:\/\/workshop\.example\/customer\/quote\/[A-Za-z0-9_-]{43}$/);
    assert.ok(
      shared.whatsappUrl.startsWith('https://wa.me/971501234567?text='),
      'local mobile normalised to 971…',
    );
    const decoded = decodeURIComponent(shared.whatsappUrl.split('?text=')[1]);
    assert.equal(decoded, shared.message);
    for (const expected of [
      'Hello Ahmed Al Marzooqi,',
      'Your quotation from Comet Autos is ready.',
      'Vehicle: Toyota Camry',
      `Registration: ${plate}`,
      'Total: AED 897.75',
      shared.link,
      '👉 *Tap to view and approve your quotation:*',
    ]) {
      assert.ok(shared.message.includes(expected), `message contains ${expected}`);
    }
    assert.ok(!UUID.test(shared.message), 'no internal ids in the message');
    const audit = await prisma.auditLog.findFirst({
      where: {
        organizationId: a.organizationId,
        action: 'customer_access.link_shared',
        entityId: estimateId,
      },
    });
    assert.ok(audit, 'sharing is audited');
  });

  test('quotation document and PDF', async () => {
    const document = await getQuotationDocument(a.owner, estimateId);
    const estimate = await prisma.estimate.findUniqueOrThrow({ where: { id: estimateId } });
    assert.equal(document.number, estimate.estimateNumber);
    assert.equal(document.status?.label, 'Awaiting approval');
    // The workshop's sheet: one numbered list, each line marked parts or labour.
    assert.deepEqual(
      document.sections.map((s) => s.title),
      [''],
    );
    assert.deepEqual(
      document.sections[0].lines.map((l) => l.type),
      ['LABOUR', 'PARTS'],
    );
    // Totals come straight from the estimate: 375 + 480 = 855.00, VAT 5% = 42.75, total 897.75.
    assert.deepEqual(
      document.totals.map((t) => [t.label, t.amount]),
      [
        ['Total excl. VAT', estimate.subtotal.toString()],
        ['VAT 5%', estimate.taxAmount.toString()],
        ['Total', estimate.totalAmount.toString()],
      ],
    );
    assert.equal(estimate.subtotal.toString(), '855');
    assert.equal(estimate.taxAmount.toString(), '42.75');
    assert.equal(estimate.totalAmount.toString(), '897.75');
    assert.equal(document.vehicle?.plateNumber, plate);
    assert.equal(document.customer.phone, '050 123 4567');
    assert.ok(document.narrative.some((n) => n.value === 'AC not cooling'));

    const pdf = renderDocumentPdf(document);
    assertValidPdf(pdf);
    const text = pdfText(pdf);
    for (const expected of [
      'QUOTATION',
      estimate.estimateNumber,
      'Ahmed Al Marzooqi',
      `Registration ${plate}`,
      'AED 897.75',
      'AED 42.75',
      'VAT 5%',
      'Comet Autos',
      'Valid until',
      'S.NO',
      'TYPE',
      'LABOUR',
      'PARTS',
    ]) {
      assert.ok(text.includes(expected), `PDF shows ${expected}`);
    }
    assert.ok(!UUID.test(pdf.toString('latin1')), 'no internal ids in the PDF');
  });

  test('long documents continue on further pages; unsupported characters never break the PDF', async () => {
    const document = await getQuotationDocument(a.owner, estimateId);
    const long = {
      ...document,
      customer: { ...document.customer, name: 'أحمد Ahmed (VIP) \\ test' },
      sections: [
        {
          title: 'Parts',
          lines: Array.from({ length: 70 }, (_, i) => ({
            ...document.sections[0].lines[1],
            description: `Part line ${i + 1} with a fairly long description that needs to wrap onto a second line in the table`,
          })),
        },
      ],
    };
    const pdf = renderDocumentPdf(long);
    const text = assertValidPdf(pdf);
    assert.ok((text.match(/\/Type \/Page /g) ?? []).length >= 3, 'paginated');
    assert.ok(pdfText(pdf).includes('Page 3 of'), 'page numbers');
    assert.equal(sanitizePdfText('أحمد Ahmed'), '???? Ahmed');
    assert.ok(
      wrapText('x'.repeat(400), 'regular', 10, 100).length > 1,
      'very long words are split',
    );
  });

  test('customer link: opens with one tap, only for its own kind, until it expires — and the customer sees only their document', async () => {
    const shared = await createShareLink(a.owner, { kind: 'quotation', id: estimateId });
    const token = shared.path.split('/').pop()!;

    // Nothing to type: the link itself opens the quotation.
    const access = await getCustomerAccess(token, 'ESTIMATE');
    assert.equal(access.state, 'open');
    if (access.state !== 'open') return;
    assert.equal(access.resourceId, estimateId);
    const document = await getQuotationDocumentForLink(access.organizationId, access.resourceId);
    assert.equal(document?.number, (await getQuotationDocument(a.owner, estimateId)).number);

    assert.equal(
      (await getCustomerAccess(token, 'INVOICE')).state,
      'invalid',
      'a quotation link is not an invoice link',
    );

    // Sharing again issues a second link and does not revoke the earlier one.
    const other = (await createShareLink(a.owner, { kind: 'quotation', id: estimateId })).path
      .split('/')
      .pop()!;
    assert.notEqual(other, token);
    assert.equal((await getCustomerAccess(other, 'ESTIMATE')).state, 'open');
    assert.equal((await getCustomerAccess(token, 'ESTIMATE')).state, 'open');

    // Expired links stop working.
    await prisma.customerAccessToken.update({
      where: { tokenHash: hashToken(token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await getCustomerAccess(token, 'ESTIMATE')).state, 'expired');
    // Garbage tokens are simply invalid.
    assert.equal((await getCustomerAccess('not-a-real-token', 'ESTIMATE')).state, 'invalid');
  });

  test('invoice and receipts: documents, totals, VAT and balances', async () => {
    const estimate = await prisma.estimate.findUniqueOrThrow({
      where: { id: estimateId },
      include: { items: true },
    });
    await recordCustomerDecision(a.owner, estimateId, {
      decision: 'APPROVED',
      method: 'IN_PERSON',
    });
    await startRepair(a.owner, jobCardId);
    const labourLine = estimate.items.find((i) => i.itemType === 'LABOUR')!.id;
    const partLine = estimate.items.find((i) => i.itemType === 'PART')!.id;
    await recordLabour(a.owner, jobCardId, {
      employeeId: a.technicianIds[0],
      description: 'Replace AC compressor clutch',
      hours: '2.5',
      rate: '150',
      estimateItemId: labourLine,
    });
    await recordPartUsage(a.owner, jobCardId, {
      partId: a.parts['AC-CLUTCH'].id,
      quantity: '1',
      employeeId: a.technicianIds[0],
      estimateItemId: partLine,
    });
    await recordQualityCheck(a.owner, jobCardId, {
      employeeId: a.technicianIds[0],
      result: 'PASSED',
    });
    const invoice = await createInvoice(a.owner, jobCardId);
    invoiceId = invoice.id;
    firstPaymentId = (
      await recordPayment(a.owner, jobCardId, {
        amount: '300',
        method: 'CARD',
        receivedAt: toLocalDateTimeInput(new Date()),
        referenceNumber: 'SLIP-9',
      })
    ).id;

    const document = await getInvoiceDocument(a.owner, invoiceId);
    const staffView = (await getJobInvoice(a.owner, jobCardId))!;
    assert.equal(document.number, invoice.invoiceNumber);
    // The customer's invoice carries no paid/unpaid badge; its totals say it.
    assert.equal(document.status, null);
    assert.deepEqual(
      document.sections.map((s) => s.title),
      [''],
    );
    assert.deepEqual(
      document.sections[0].lines.map((l) => l.type),
      ['LABOUR', 'PARTS'],
      'a repair-billed line is typed from its labour / part record',
    );
    const totals = Object.fromEntries(document.totals.map((t) => [t.label, t.amount]));
    assert.deepEqual(totals, {
      'Total excl. VAT': '855',
      'VAT 5%': '42.75',
      Total: '897.75',
      'Amount paid': '300.00',
      'Balance due': '597.75',
    });
    assert.equal(
      totals['Balance due'],
      staffView.balanceDue,
      'the document agrees with the staff invoice view',
    );
    const lineVat = document.sections.flatMap((s) => s.lines).length;
    assert.equal(lineVat, 2);
    const pdf = pdfText(renderDocumentPdf(document));
    for (const expected of [
      'TAX INVOICE',
      invoice.invoiceNumber,
      'AED 897.75',
      'Amount paid',
      'AED 300.00',
      'Balance due',
      'AED 597.75',
      'TRN 100200300400003',
    ]) {
      assert.ok(pdf.includes(expected), `invoice PDF shows ${expected}`);
    }
    assert.ok(!pdf.includes('PARTIALLY PAID'), 'the invoice PDF prints no payment badge');

    secondPaymentId = (
      await recordPayment(a.owner, jobCardId, {
        amount: '597.75',
        method: 'CASH',
        receivedAt: toLocalDateTimeInput(new Date()),
      })
    ).id;
    const first = await getReceiptDocument(a.owner, firstPaymentId);
    const second = await getReceiptDocument(a.owner, secondPaymentId);
    const details = (doc: typeof first) =>
      Object.fromEntries(doc.details.map((d) => [d.label, d.value]));
    assert.equal(details(first)['Balance before this payment'], 'AED 897.75');
    assert.equal(details(first)['Remaining balance'], 'AED 597.75');
    assert.equal(details(first)['Reference'], 'SLIP-9');
    assert.equal(first.status?.label, 'Partially paid');
    assert.equal(details(second)['Balance before this payment'], 'AED 597.75');
    assert.equal(details(second)['Remaining balance'], 'AED 0.00');
    assert.equal(second.status?.label, 'Paid in full');
    assert.match(first.number, /^RCT-\d{6}$/);
    const receiptPdf = renderDocumentPdf(second);
    assertValidPdf(receiptPdf);
    for (const expected of [
      'PAYMENT RECEIPT',
      second.number,
      'AED 597.75',
      'Cash',
      invoice.invoiceNumber,
    ]) {
      assert.ok(pdfText(receiptPdf).includes(expected), `receipt PDF shows ${expected}`);
    }
    assert.equal((await getInvoiceDocument(a.owner, invoiceId)).status, null);
  });

  test('invoice and receipt sharing; the customer invoice link shows only that invoice and its receipts', async () => {
    const shared = shareResult(
      await createShareLink(a.owner, { kind: 'invoice', id: invoiceId }),
      ORIGIN,
    );
    assert.match(shared.link, /\/customer\/invoice\/[A-Za-z0-9_-]{43}$/);
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    for (const expected of [
      'Your invoice from Comet Autos is ready.',
      `Invoice: ${invoice.invoiceNumber}`,
      'Total: AED 897.75',
      'Paid: AED 897.75',
      'Balance: AED 0.00',
      '👉 *View your invoice:*',
    ]) {
      assert.ok(shared.message.includes(expected), `invoice message contains ${expected}`);
    }
    const receipt = shareResult(
      await createShareLink(a.owner, { kind: 'receipt', id: firstPaymentId }),
      ORIGIN,
    );
    assert.ok(
      receipt.message.includes('Amount paid: AED 300.00') &&
        receipt.message.includes('Remaining balance: AED 597.75'),
    );

    const token = shared.link.split('/').pop()!;
    const access = await getCustomerAccess(token, 'INVOICE');
    assert.equal(access.state, 'open');
    if (access.state !== 'open') return;
    const data = (await getInvoiceDocumentForLink(access.organizationId, access.resourceId))!;
    assert.equal(data.balance.state, 'PAID');
    assert.equal(data.receipts.length, 2);
    const receiptNumber = data.receipts[0].number;
    assert.equal(
      (await getReceiptDocumentForLink(access.organizationId, access.resourceId, receiptNumber))
        ?.number,
      receiptNumber,
    );
    assert.equal(
      await getReceiptDocumentForLink(access.organizationId, access.resourceId, 'RCT-999999'),
      null,
      'unknown receipt',
    );
    assert.equal(
      await getReceiptDocumentForLink(b.organizationId, access.resourceId, receiptNumber),
      null,
      'another organization',
    );

    const documents = await getJobDocuments(a.owner, jobCardId);
    assert.equal(documents.quotations.length, 1);
    assert.equal(documents.invoice?.receipts.length, 2);
  });

  test('staff access is permission- and organization-checked', async () => {
    await expectDomainError(getInvoiceDocument(b.owner, invoiceId), /could not be found/);
    await expectDomainError(getQuotationDocument(b.owner, estimateId), /could not be found/);
    await expectDomainError(getReceiptDocument(b.owner, firstPaymentId), /could not be found/);
    await expectDomainError(
      createShareLink(b.owner, { kind: 'invoice', id: invoiceId }),
      /could not be found/,
    );
    await assert.rejects(getInvoiceDocument(a.viewer, invoiceId), AuthError);
    await assert.rejects(createShareLink(a.viewer, { kind: 'invoice', id: invoiceId }), AuthError);
    await assert.rejects(
      createShareLink(a.viewer, { kind: 'quotation', id: estimateId }),
      AuthError,
    );
    await expectDomainError(
      createShareLink(a.owner, { kind: 'invoice', id: 'not-a-uuid' }),
      /Invalid|uuid/i,
    );
    const viewerDocs = await getJobDocuments(a.viewer, jobCardId);
    assert.equal(viewerDocs.invoice, null, 'no invoice without invoice.view');
  });

  test('WhatsApp numbers and message encoding', () => {
    assert.equal(normalizeWhatsAppNumber('050 123 4567'), '971501234567');
    assert.equal(normalizeWhatsAppNumber('+971 50 123 4567'), '971501234567');
    assert.equal(normalizeWhatsAppNumber('00971501234567'), '971501234567');
    assert.equal(normalizeWhatsAppNumber('971501234567'), '971501234567');
    assert.equal(normalizeWhatsAppNumber('501234567'), '971501234567');
    assert.equal(normalizeWhatsAppNumber('+44 7700 900123'), '447700900123');
    assert.equal(normalizeWhatsAppNumber('123'), null);
    assert.equal(normalizeWhatsAppNumber(''), null);
    assert.ok(
      whatsAppUrl('123', 'hi').startsWith('https://wa.me/?text='),
      'no recipient when the number is unusable',
    );

    const message = invoiceMessage({
      customerName: 'Sara & Co #1',
      workshopName: 'Comet Autos',
      vehicle: 'Nissan Patrol',
      plateNumber: 'A 12345',
      number: 'INV-000124',
      total: '1250',
      paid: '500',
      balance: '750',
      link: 'https://x.test/customer/invoice/abc?x=1&y=2',
    });
    const url = whatsAppUrl('0501234567', message);
    const encoded = url.split('?text=')[1];
    assert.ok(!/[\s&#?]/.test(encoded), 'spaces, newlines, & # ? are all encoded');
    assert.equal(decodeURIComponent(encoded), message);
    assert.ok(
      message.includes('Total: AED 1,250.00') &&
        message.includes('Paid: AED 500.00') &&
        message.includes('Balance: AED 750.00'),
    );
    assert.equal(formatAed('1234567.5'), 'AED 1,234,567.50');
    assert.ok(
      quotationMessage({
        customerName: '',
        workshopName: 'Comet Autos',
        vehicle: null,
        plateNumber: null,
        number: 'EST-1',
        total: '10',
        awaitingDecision: false,
        link: 'L',
      }).startsWith('Hello there,'),
    );
  });
});
