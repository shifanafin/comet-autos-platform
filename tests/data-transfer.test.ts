/**
 * Integration tests for spreadsheet import and export.
 *
 *  - every list exports, with the screen's own search and filters;
 *  - an export carries only the caller's organization, and only lists their
 *    permissions allow;
 *  - importing customers, vehicles, parts and suppliers goes through the
 *    same services the forms use — same validation, same audit;
 *  - a row already on file is skipped, not duplicated;
 *  - one bad row means nothing is written;
 *  - job cards, quotations and invoices from an old system come in with
 *    their own numbers and dates, priced by the app's rules, and move the
 *    number sequence past them; payments are never imported on their own.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { checkInVehicle } from '@/lib/workshop/check-in';
import { createQuotation, saveEstimateDraft } from '@/lib/workshop/estimates';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { buildExport, EXPORTS, exportGuide } from '@/lib/data-transfer/exports';
import { importCsv, importTemplate, isImportable, IMPORTS } from '@/lib/data-transfer/imports';
import { parseCsv, parseCsvRows, toCsv } from '@/lib/data-transfer/csv';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let b: TestOrg;

const validUntil = () => localDateString(new Date(Date.now() + 7 * 86400000));

/** The rows of an export, as a spreadsheet would read them. */
function rowsOf(csv: string) {
  const cells = parseCsvRows(csv);
  return { headers: cells[0], body: cells.slice(1), records: parseCsv(csv).records };
}

before(async () => {
  a = await createTestOrg('TransferA');
  b = await createTestOrg('TransferB');
});

after(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------

describe('CSV itself', () => {
  test('quotes what needs quoting and survives a round trip', () => {
    const rows = [
      { name: 'Al "Fast" Motors, Dubai', note: 'line one\nline two', amount: '1250.00' },
    ];
    const csv = toCsv(rows, [
      { header: 'Name', value: (row) => row.name },
      { header: 'Note', value: (row) => row.note },
      { header: 'Amount', value: (row) => row.amount },
    ]);
    assert.ok(csv.startsWith('﻿'), 'a byte-order mark, so Excel reads UTF-8');
    assert.ok(csv.includes('"Al ""Fast"" Motors, Dubai"'));
    const back = parseCsv(csv);
    assert.equal(back.records[0].name, 'Al "Fast" Motors, Dubai');
    assert.equal(back.records[0].note, 'line one\nline two');
    assert.equal(back.records[0].amount, '1250.00');
  });

  test('a value that looks like a formula is written as text', () => {
    const csv = toCsv([{ v: '=1+1' }], [{ header: 'V', value: (row) => row.v }]);
    assert.ok(csv.includes("'=1+1"), 'Excel would otherwise evaluate it');
    assert.equal(parseCsv(csv).records[0].v, '=1+1', 'and it reads back unchanged');
  });

  test('a negative number stays a number; anything else starting with - is still guarded', () => {
    const csv = toCsv(
      [{ v: '-2.000' }, { v: -50 }, { v: '-2+3' }, { v: '-SUM(A1)' }],
      [{ header: 'V', value: (row) => row.v }],
    );
    const cells = csv.split('\r\n').slice(1).filter(Boolean);
    assert.deepEqual(cells, ['-2.000', '-50', "'-2+3", "'-SUM(A1)"]);
  });

  test('headings match however they were typed', () => {
    const sheet = parseCsv('Mobile Number,customer_name\r\n050 111 2222,Ahmed\r\n');
    assert.equal(sheet.records[0].mobilenumber, '050 111 2222');
    assert.equal(sheet.records[0].customername, 'Ahmed');
  });
});

// ---------------------------------------------------------------------------

describe('export', () => {
  test('every list has an export, and each one runs', async () => {
    for (const entity of Object.keys(EXPORTS)) {
      const { csv, rows } = await buildExport(a.owner, entity, {});
      assert.ok(csv.split('\r\n')[0].length > 0, `${entity} has headings`);
      assert.ok(rows >= 0, `${entity} ran`);
    }
  });

  test('customers export carries the rows and their vehicles', async () => {
    const customer = await prisma.customer.create({
      data: {
        organizationId: a.organizationId,
        name: `Export Customer ${RUN}`,
        phone: '050 900 1122',
      },
    });
    await prisma.vehicle.create({
      data: {
        organizationId: a.organizationId,
        customerId: customer.id,
        plateNumber: `X1 ${RUN.slice(-4)}`,
        make: 'Toyota',
        model: 'Corolla',
      },
    });
    const { csv } = await buildExport(a.owner, 'customers', {});
    const { headers, records } = rowsOf(csv);
    assert.deepEqual(headers.slice(0, 3), ['Name', 'Mobile', 'Email']);
    const row = records.find((record) => record.name === `Export Customer ${RUN}`);
    assert.ok(row, 'the new customer is in the file');
    assert.equal(row.mobile, '050 900 1122');
    assert.equal(row.vehicles, `X1 ${RUN.slice(-4)}`);
    assert.equal(row.numberofvehicles, '1');
    assert.equal(row.balanceowed, '0.00', 'nothing invoiced yet');
    for (const header of ['TRN', 'Address', 'Total invoiced', 'Paid', 'Last visit']) {
      assert.ok(headers.includes(header), `the file has ${header}`);
    }
  });

  test('every export explains itself: what the file holds, and the columns', () => {
    for (const entity of Object.keys(EXPORTS)) {
      const guide = exportGuide(entity);
      assert.ok(guide && guide.description.length > 20, `${entity} says what it holds`);
      assert.equal(guide.columns.length, EXPORTS[entity].columns.length);
    }
  });

  test('the search that filtered the screen filters the file', async () => {
    // Someone the search must leave out.
    await prisma.customer.create({
      data: {
        organizationId: a.organizationId,
        name: `Other Person ${RUN}`,
        phone: '050 900 7788',
      },
    });
    const all = await buildExport(a.owner, 'customers', {});
    const filtered = await buildExport(a.owner, 'customers', { q: 'Export Customer' });
    assert.ok(filtered.rows >= 1);
    assert.ok(filtered.rows < all.rows, 'the search narrowed the export');
    assert.ok(
      rowsOf(filtered.csv).records.every((record) => record.name.includes('Export Customer')),
    );
  });

  test('an export never reaches another organization', async () => {
    const mine = rowsOf((await buildExport(a.owner, 'customers', {})).csv).records;
    const theirs = rowsOf((await buildExport(b.owner, 'customers', {})).csv).records;
    assert.ok(mine.some((record) => record.name === `Export Customer ${RUN}`));
    assert.equal(
      theirs.some((record) => record.name === `Export Customer ${RUN}`),
      false,
    );
  });

  test('a user who may not see a list may not export it', async () => {
    // The viewer has customer.view but not invoice.view.
    await buildExport(a.viewer, 'customers', {});
    await assert.rejects(buildExport(a.viewer, 'invoices', {}), AuthError);
    await assert.rejects(buildExport(a.viewer, 'payments', {}), AuthError);
  });

  test('an unknown list is not found', async () => {
    await expectDomainError(buildExport(a.owner, 'salaries', {}), /could not be found/);
  });

  test('documents export with their money as plain decimals', async () => {
    const customer = await prisma.customer.create({
      data: { organizationId: a.organizationId, name: `Export Doc ${RUN}`, phone: '050 900 3344' },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        organizationId: a.organizationId,
        customerId: customer.id,
        plateNumber: `X2 ${RUN.slice(-4)}`,
        make: 'Nissan',
        model: 'Sunny',
      },
    });
    await checkInVehicle(a.owner, {
      mode: 'existing',
      vehicleId: vehicle.id,
      visit: { complaint: 'Service' },
    });
    const quote = await createQuotation(a.owner, {
      customerId: customer.id,
      vehicleId: vehicle.id,
    });
    await saveEstimateDraft(a.owner, quote.id, {
      validUntil: validUntil(),
      items: [{ itemType: 'PART', description: 'Filter', quantity: '2', unitPrice: '55.50' }],
    });
    await createDirectInvoice(a.owner, {
      customerId: customer.id,
      vehicleId: vehicle.id,
      items: [{ itemType: 'LABOUR', description: 'Service', quantity: '1', unitPrice: '300' }],
    });

    const quotations = rowsOf((await buildExport(a.owner, 'quotations', {})).csv).records;
    const quotation = quotations.find((record) => record.customer === `Export Doc ${RUN}`);
    assert.ok(quotation);
    assert.equal(quotation.total, '116.55', '111.00 + 5% VAT');
    assert.equal(quotation.registration, `X2 ${RUN.slice(-4)}`);

    const invoices = rowsOf((await buildExport(a.owner, 'invoices', {})).csv).records;
    const invoice = invoices.find((record) => record.customer === `Export Doc ${RUN}`);
    assert.ok(invoice);
    assert.equal(invoice.total, '315.00');
    assert.equal(invoice.balancedue, '315.00');

    const workOrders = rowsOf((await buildExport(a.owner, 'work-orders', {})).csv).records;
    assert.ok(workOrders.some((record) => record.registration === `X2 ${RUN.slice(-4)}`));
  });
});

// ---------------------------------------------------------------------------

describe('import', () => {
  test('master data and document history are importable — payments on their own are not', () => {
    assert.deepEqual(Object.keys(IMPORTS).sort(), [
      'customers',
      'expenses',
      'invoices',
      'parts',
      'purchases',
      'quotations',
      'suppliers',
      'vehicles',
      'work-orders',
    ]);
    for (const entity of ['payments', 'stock-movements']) {
      assert.equal(isImportable(entity), false, `${entity} cannot be imported`);
    }
  });

  test('the template has the headings and an example row', () => {
    const { csv } = importTemplate('customers');
    const { headers, body } = rowsOf(csv);
    assert.deepEqual(headers, ['Name', 'Mobile', 'Email', 'Address', 'TRN']);
    assert.equal(body.length, 1, 'one example row');
    assert.equal(body[0][0], 'Ahmed Al Qasimi');
  });

  test('customers: imported, normalized and audited like the form', async () => {
    const csv = [
      'Name,Mobile,Email',
      `Import One ${RUN},050 777 1111,one@test.local`,
      `Import Two ${RUN},"055 777 2222",`,
    ].join('\r\n');
    const outcome = await importCsv(a.owner, 'customers', csv);
    assert.equal(outcome.created, 2);
    assert.equal(outcome.errors.length, 0);
    assert.equal(outcome.skipped.length, 0);

    const created = await prisma.customer.findFirst({
      where: { organizationId: a.organizationId, name: `Import One ${RUN}` },
    });
    assert.ok(created);
    assert.equal(created.email, 'one@test.local');
    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: a.organizationId, action: 'customer.created', entityId: created.id },
    });
    assert.ok(audit, 'the import is audited the same as the form');
  });

  test('a customer already on file is skipped, not duplicated', async () => {
    const csv = ['Name,Mobile', `Import One Again ${RUN},050 777 1111`].join('\r\n');
    const outcome = await importCsv(a.owner, 'customers', csv);
    assert.equal(outcome.created, 0);
    assert.equal(outcome.skipped.length, 1);
    assert.match(outcome.skipped[0].reason, /already on file as Import One/);
    assert.equal(
      await prisma.customer.count({
        where: { organizationId: a.organizationId, phone: { contains: '777 1111' } },
      }),
      1,
    );
  });

  test('one bad row and nothing is written', async () => {
    const before = await prisma.customer.count({ where: { organizationId: a.organizationId } });
    const csv = [
      'Name,Mobile',
      `Good Row ${RUN},050 777 3333`,
      `,050 777 4444`,
      `Another Good ${RUN},050 777 5555`,
    ].join('\r\n');
    const outcome = await importCsv(a.owner, 'customers', csv);
    assert.equal(outcome.created, 0, 'nothing written');
    assert.equal(outcome.errors.length, 1);
    assert.equal(outcome.errors[0].row, 3, 'the spreadsheet row number');
    assert.equal(
      await prisma.customer.count({ where: { organizationId: a.organizationId } }),
      before,
    );
  });

  test('vehicles: matched to their owner by mobile number', async () => {
    const csv = [
      'Registration,Customer mobile,Make,Model,Year',
      `V1 ${RUN.slice(-4)},050 777 1111,Toyota,Hilux,2020`,
    ].join('\r\n');
    const outcome = await importCsv(a.owner, 'vehicles', csv);
    assert.equal(outcome.created, 1);
    const vehicle = await prisma.vehicle.findFirst({
      where: { organizationId: a.organizationId, plateNumber: `V1 ${RUN.slice(-4)}` },
      include: { customer: true },
    });
    assert.ok(vehicle);
    assert.equal(vehicle.customer.name, `Import One ${RUN}`);
    assert.equal(vehicle.year, 2020);
  });

  test('vehicles: an unknown owner is refused with a message that says what to do', async () => {
    const csv = [
      'Registration,Customer mobile,Make,Model',
      `V9 ${RUN.slice(-4)},059 000 0000,Toyota,Hilux`,
    ].join('\r\n');
    const outcome = await importCsv(a.owner, 'vehicles', csv);
    assert.equal(outcome.created, 0);
    assert.match(outcome.errors[0].message, /No customer has the mobile number 059 000 0000/);
  });

  test('parts and suppliers import through their own services', async () => {
    const suppliers = await importCsv(
      a.owner,
      'suppliers',
      ['Name,Contact name,Mobile', `Gulf Parts ${RUN},Rashid,04 111 2222`].join('\r\n'),
    );
    assert.equal(suppliers.created, 1);

    const parts = await importCsv(
      a.owner,
      'parts',
      [
        'SKU,Name,Unit,Cost price,Selling price,VAT %',
        `IMP-${RUN},Imported brake pad,piece,95,180,5`,
      ].join('\r\n'),
    );
    assert.equal(parts.created, 1);
    const part = await prisma.part.findFirst({
      where: { organizationId: a.organizationId, sku: `IMP-${RUN}` },
    });
    assert.ok(part);
    assert.equal(part.defaultSellingPrice?.toString(), '180');
  });

  test('a file with no rows, or too many, is refused before anything is read', async () => {
    await expectDomainError(importCsv(a.owner, 'customers', 'Name,Mobile\r\n'), /no rows/);
    const many = [
      'Name,Mobile',
      ...Array.from({ length: 2100 }, (_, i) => `Bulk ${i},05000000${i}`),
    ];
    await expectDomainError(
      importCsv(a.owner, 'customers', many.join('\r\n')),
      /up to 2000 at a time/,
    );
  });

  test('permissions and organizations are enforced', async () => {
    const csv = ['Name,Mobile', `Denied ${RUN},050 888 0000`].join('\r\n');
    await assert.rejects(importCsv(a.viewer, 'customers', csv), AuthError);
    await expectDomainError(importCsv(a.owner, 'payments', csv), /could not be found/);

    // Org B importing the same file makes B's own customer, not A's.
    await importCsv(
      b.owner,
      'customers',
      ['Name,Mobile', `Shared Name ${RUN},050 999 1234`].join('\r\n'),
    );
    assert.equal(
      await prisma.customer.count({
        where: { organizationId: a.organizationId, name: `Shared Name ${RUN}` },
      }),
      0,
    );
    assert.equal(
      await prisma.customer.count({
        where: { organizationId: b.organizationId, name: `Shared Name ${RUN}` },
      }),
      1,
    );
  });

  test('the same file submitted twice imports once', async () => {
    const csv = ['Name,Mobile', `Once Only ${RUN},050 321 4321`].join('\r\n');
    const key = `import-${RUN}-once`.padEnd(20, 'x');
    const first = await importCsv(a.owner, 'customers', csv, key);
    assert.equal(first.created, 1);
    await assert.rejects(importCsv(a.owner, 'customers', csv, key));
    assert.equal(
      await prisma.customer.count({
        where: { organizationId: a.organizationId, name: `Once Only ${RUN}` },
      }),
      1,
    );
  });

  test('what was exported can be imported again', async () => {
    const { csv } = await buildExport(b.owner, 'customers', {});
    const roundTrip = await importCsv(b.owner, 'customers', csv);
    assert.equal(roundTrip.created, 0, 'every row already exists');
    assert.equal(roundTrip.errors.length, 0, 'and the file reads cleanly');
    assert.ok(roundTrip.skipped.length > 0);
  });
});

// ---------------------------------------------------------------------------

describe('import: documents from another system', () => {
  let c: TestOrg;
  before(async () => {
    c = await createTestOrg('TransferC');
  });

  test('job cards keep their number and date, and add the customer and vehicle they need', async () => {
    const csv = [
      'Job card no.,Date,Customer name,Customer mobile,Registration,Make,Model,Mileage (km),Work requested,Status',
      'JC-000150,15/01/2026,Old Customer,050 700 0001,K 70001,Nissan,Patrol,"84,500",Full service,Delivered',
      ',2026-02-01,,050 700 0001,K 70001,,,90000,Brake noise,',
    ].join('\r\n');
    const outcome = await importCsv(c.owner, 'work-orders', csv);
    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.created, 2);

    const jobs = await prisma.jobCard.findMany({
      where: { organizationId: c.organizationId },
      orderBy: { openedAt: 'asc' },
      include: { vehicle: true, customer: true },
    });
    assert.equal(jobs[0].jobNumber, 'JC-000150');
    assert.equal(jobs[0].status, 'DELIVERED');
    assert.equal(jobs[0].openedAt.toISOString().slice(0, 10), '2026-01-15');
    assert.equal(jobs[0].customer.name, 'Old Customer');
    assert.equal(jobs[1].jobNumber, 'JC-000151', 'a blank number follows the imported ones');
    assert.equal(jobs[1].customerId, jobs[0].customerId, 'the new customer is created once');
    assert.equal(jobs[1].vehicle.lastMileage, 90000);

    const again = await importCsv(
      c.owner,
      'work-orders',
      csv.split('\r\n').slice(0, 2).join('\r\n'),
    );
    assert.equal(again.created, 0);
    assert.match(again.skipped[0].reason, /JC-000150 is already on file/);
  });

  test('invoices: rows sharing a number are one invoice, priced here, with its payment', async () => {
    const csv = [
      'Invoice no.,Date,Customer mobile,Registration,Job card no.,Type,Description,Quantity,Unit price,VAT %,Amount paid,Payment method',
      'INV-000900,2026-01-20,050 700 0001,K 70001,JC-000150,Parts,Oil filter,2,50.00,5,315.00,Card',
      'INV-000900,,,,,Labour,Service labour,1,200,5,,',
      'INV-000901,2026-01-21,050 700 0001,,,Labour,Diagnosis,1,100,,,',
    ].join('\r\n');
    const outcome = await importCsv(c.owner, 'invoices', csv);
    assert.deepEqual(outcome.errors, []);
    assert.equal(outcome.created, 2);

    const paid = await prisma.invoice.findFirstOrThrow({
      where: { organizationId: c.organizationId, invoiceNumber: 'INV-000900' },
      include: { items: true, payments: true, jobCard: true },
    });
    assert.equal(paid.items.length, 2);
    assert.equal(paid.subtotal.toString(), '300');
    assert.equal(paid.taxAmount.toString(), '15');
    assert.equal(paid.totalAmount.toString(), '315');
    assert.equal(paid.status, 'PAID');
    assert.equal(paid.issueDate.toISOString().slice(0, 10), '2026-01-20');
    assert.equal(paid.jobCard?.jobNumber, 'JC-000150');
    assert.equal(paid.payments.length, 1);
    assert.equal(paid.payments[0].method, 'CARD');

    const unpaid = await prisma.invoice.findFirstOrThrow({
      where: { organizationId: c.organizationId, invoiceNumber: 'INV-000901' },
    });
    assert.equal(unpaid.status, 'ISSUED');
    assert.equal(unpaid.totalAmount.toString(), '105', "a blank VAT % is the workshop's rate");

    const sequence = await prisma.documentNumberSequence.findFirstOrThrow({
      where: { organizationId: c.organizationId, documentType: 'TAX_INVOICE' },
    });
    assert.equal(
      sequence.nextNumber,
      902,
      'the next invoice numbered here comes after the imported ones',
    );
  });

  test('a bad line is reported against its own row, and nothing is written', async () => {
    const csv = [
      'Quotation no.,Date,Customer mobile,Description,Unit price',
      'EST-000500,2026-01-10,050 700 0001,Front pads,180',
      'EST-000500,,,Rear pads,lots',
    ].join('\r\n');
    const outcome = await importCsv(c.owner, 'quotations', csv);
    assert.equal(outcome.created, 0);
    assert.equal(outcome.errors[0].row, 3);
    assert.equal(await prisma.estimate.count({ where: { organizationId: c.organizationId } }), 0);
  });

  test('quotations: imported with their status and lines', async () => {
    const csv = [
      'Quotation no.,Date,Customer mobile,Type,Description,Quantity,Unit price,Status',
      'EST-000500,2026-01-10,050 700 0001,Parts,Front pads,1,180,Approved',
      'EST-000500,,,Labour,Fitting,1,60,',
    ].join('\r\n');
    const outcome = await importCsv(c.owner, 'quotations', csv);
    assert.deepEqual(outcome.errors, []);
    const quotation = await prisma.estimate.findFirstOrThrow({
      where: { organizationId: c.organizationId, estimateNumber: 'EST-000500' },
      include: { items: true },
    });
    assert.equal(quotation.status, 'APPROVED');
    assert.equal(quotation.items.length, 2);
    assert.equal(quotation.totalAmount.toString(), '252');
  });

  test('an unknown customer with no name, or a date in the future, is refused', async () => {
    const future = localDateString(new Date(Date.now() + 3 * 86400000));
    const csv = [
      'Invoice no.,Date,Customer mobile,Description,Unit price',
      `INV-000950,2026-01-10,050 799 9999,Tyre,300`,
      `INV-000951,${future},050 700 0001,Tyre,300`,
    ].join('\r\n');
    const outcome = await importCsv(c.owner, 'invoices', csv);
    assert.equal(outcome.created, 0);
    assert.match(outcome.errors[0].message, /Fill in the Customer name/);
    assert.match(outcome.errors[1].message, /can't be in the future/);
  });
});
