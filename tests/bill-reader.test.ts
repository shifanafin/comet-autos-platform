/**
 * Integration tests for "Scan bill" against the database:
 *
 * - a PDF with a text layer is read without OCR; a scanned one asks for it;
 * - our own TRN is never taken as the supplier's; a supplier on file is
 *   found by TRN, else by name; a bill already recorded is flagged;
 * - reading writes nothing — not a row, in any table;
 * - a view-only user can't scan;
 * - saving a scanned bill writes the "filled from scanned bill" audit entry,
 *   and the file is kept with the record under the shared attachment rules.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { ROLE_PRESETS } from '@/lib/auth/permission-catalog';
import { readBill, readBillPdf } from '@/lib/bill-reader/read';
import {
  attachFile,
  listAttachments,
  readAttachment,
  removeAttachment,
} from '@/lib/documents/attachments';
import { attachExpenseBill, listExpenseBills } from '@/lib/finance/expense-bills';
import { recordExpense, voidExpense } from '@/lib/finance/expenses';
import { createPurchase } from '@/lib/inventory/purchases';
import { listAuditLog } from '@/lib/access/audit';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';
import { PDF_BILL, scannedPdf, textPdf } from './bill-fixtures';

const STORAGE_DIR = mkdtempSync(path.join(tmpdir(), 'garage-bill-test-'));
process.env.LOCAL_STORAGE_DIR = STORAGE_DIR;

const OWN_TRN = '100234567800003';
const SUPPLIER_TRN = '100445566778003';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)]);
const isAuthError = (error: unknown) => error instanceof AuthError;

let a: TestOrg;
let partner: AuthenticatedUser;
let byTrn: { id: string; name: string };
let byName: { id: string; name: string };

/** Rows this organization holds in every table, to prove a read changed none. */
async function rowCounts(organizationId: string) {
  const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'organization_id' order by table_name`,
  );
  const counts: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [row] = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `select count(*) as n from "${table_name}" where organization_id = $1::uuid`,
      organizationId,
    );
    counts[table_name] = Number(row.n);
  }
  return counts;
}

before(async () => {
  a = await createTestOrg('Scan', [
    { sku: 'OF-TOY-01', name: 'Oil filter Toyota', cost: '18.50', price: '30.00', stock: '0' },
  ]);
  await prisma.organization.update({
    where: { id: a.organizationId },
    data: { taxNumber: OWN_TRN },
  });
  partner = {
    ...a.owner,
    orgWidePermissions: new Set(ROLE_PRESETS.find((preset) => preset.key === 'partner')!.codes),
  };
  byTrn = await prisma.supplier.create({
    // The name on file differs from the one printed: only the TRN ties them.
    data: { organizationId: a.organizationId, name: `Gulf Lubes ${RUN}`, taxNumber: SUPPLIER_TRN },
    select: { id: true, name: true },
  });
  byName = await prisma.supplier.create({
    data: { organizationId: a.organizationId, name: 'Taimoor Auto Spare Parts Tr. L.L.C' },
    select: { id: true, name: true },
  });
});

after(async () => {
  await prisma.$disconnect();
  rmSync(STORAGE_DIR, { recursive: true, force: true });
});

describe('reading a bill', () => {
  test('a PDF with a text layer is read without OCR', async () => {
    const result = await readBillPdf(a.owner, 'expense', textPdf(PDF_BILL));
    assert.equal(result.needsOcr, false);
    assert.ok(!result.needsOcr);
    assert.equal(result.draft.billNumber, 'GL-20455');
    assert.equal(result.draft.billDate, '2026-09-21');
    assert.deepEqual(
      [result.draft.subtotal, result.draft.vat, result.draft.total],
      ['400.00', '20.00', '420.00'],
    );
    assert.equal(result.draft.isTaxInvoice, true);
    assert.equal(result.draft.supplier?.id, byTrn.id, 'the supplier is found by its TRN');
  });

  test('a scanned PDF has no text layer and asks for OCR', async () => {
    assert.deepEqual(await readBillPdf(a.owner, 'expense', scannedPdf()), { needsOcr: true });
    await expectDomainError(readBillPdf(a.owner, 'expense', JPEG), /isn’t a PDF/);
  });

  test('our own TRN is never taken as the supplier’s', async () => {
    const onlyOurs = await readBill(
      a.owner,
      'expense',
      `CASH BILL\nTo: Mohammed Mowla Auto Garage TRN ${OWN_TRN}\nTotal 50.00`,
    );
    assert.equal(onlyOurs.supplierTrn, null);
    assert.equal(onlyOurs.isTaxInvoice, false);
    const both = await readBill(
      a.owner,
      'expense',
      PDF_BILL.join('\n') + `\nCustomer TRN ${OWN_TRN}`,
    );
    assert.equal(both.supplierTrn, SUPPLIER_TRN);
  });

  test('a supplier without a TRN on file is found by name, not by the Bill To row', async () => {
    const draft = await readBill(
      a.owner,
      'purchase',
      [
        'TAIMOOR AUTO SPARE PARTS TR. LLC',
        'TRN 100-3344-5566-7003',
        'Tax Invoice',
        'Doc. No: TI/26/004512     Dated 03-Sep-2026',
        `Bill To: Gulf Lubes ${RUN}`,
        '1 OIL FILTER TOYOTA OF-TOY-01   4   18.50   74.00',
        'Taxable Amount 74.00',
        'VAT 5% 3.70',
        'Total Amount 77.70',
      ].join('\n'),
    );
    assert.equal(draft.supplier?.id, byName.id);
    assert.equal(draft.lines.length, 1);
    assert.equal(
      draft.lines[0].partId,
      a.parts['OF-TOY-01'].id,
      'the row is matched to the part by SKU',
    );
    assert.deepEqual(draft.filled, [
      'supplier',
      'billNumber',
      'billDate',
      'subtotal',
      'vat',
      'total',
      'lines',
    ]);
  });

  test('an expense gets no item rows', async () => {
    const draft = await readBill(
      a.owner,
      'expense',
      'X TRADING\n1 OIL FILTER 4 18.50 74.00\nSub Total 74.00\nVAT Amount 3.70\nTotal Amount 77.70',
    );
    assert.deepEqual(draft.lines, []);
  });

  test('reading writes nothing to the database', async () => {
    const beforeCounts = await rowCounts(a.organizationId);
    await readBill(a.owner, 'expense', PDF_BILL.join('\n'));
    await readBill(a.owner, 'purchase', PDF_BILL.join('\n'));
    await readBillPdf(a.owner, 'expense', textPdf(PDF_BILL));
    await readBillPdf(a.owner, 'purchase', scannedPdf());
    assert.deepEqual(await rowCounts(a.organizationId), beforeCounts);
  });

  test('a view-only user can’t scan', async () => {
    for (const user of [a.viewer, partner]) {
      await assert.rejects(readBill(user, 'expense', PDF_BILL.join('\n')), isAuthError);
      await assert.rejects(readBill(user, 'purchase', PDF_BILL.join('\n')), isAuthError);
      await assert.rejects(readBillPdf(user, 'expense', textPdf(PDF_BILL)), isAuthError);
    }
    // Recording expenses doesn't let someone scan for a purchase.
    const clerk = { ...a.owner, orgWidePermissions: new Set(['expense.view', 'expense.create']) };
    assert.ok(await readBill(clerk, 'expense', PDF_BILL.join('\n')));
    await assert.rejects(readBill(clerk, 'purchase', PDF_BILL.join('\n')), isAuthError);
  });
});

describe('saving a scanned bill', () => {
  test('an expense: audited as filled from a scanned bill, the file kept, a repeat flagged', async () => {
    const draft = await readBill(a.owner, 'expense', PDF_BILL.join('\n'));
    assert.equal(draft.duplicate, null);
    const expense = await recordExpense(a.owner, {
      description: `Engine oil ${RUN}`,
      amount: draft.subtotal!,
      taxRate: '5',
      expenseDate: draft.billDate!,
      vendorName: draft.supplier!.name,
      billNumber: draft.billNumber!,
      paymentMethod: 'CASH',
      scannedFields: draft.filled.join(','),
    });
    await attachExpenseBill(
      a.owner,
      expense.id,
      { name: 'bill.pdf', bytes: textPdf(PDF_BILL) },
      { note: 'Scanned bill' },
    );

    const entry = await prisma.auditLog.findFirst({
      where: { entityId: expense.id, action: 'expense.filled_from_scan' },
    });
    assert.ok(entry, 'the scan is in the audit log');
    assert.deepEqual((entry.afterData as { filled: string[] }).filled, draft.filled);
    const log = await listAuditLog(a.owner, { module: 'expense' });
    assert.ok(
      log.entries.some((row) => /^Filled from a scanned bill: expense/.test(row.sentence)),
      'and reads as a sentence',
    );

    const [bill] = (await listExpenseBills(a.owner, [expense.id])).get(expense.id) ?? [];
    assert.equal(bill.fileName, 'bill.pdf');
    assert.equal(bill.note, 'Scanned bill');
    assert.equal(bill.uploadedBy, a.owner.fullName);

    const again = await readBill(a.owner, 'expense', PDF_BILL.join('\n'));
    assert.match(
      again.duplicate?.label ?? '',
      /^Expense /,
      'the same bill scanned again is flagged',
    );
  });

  test('a purchase: audited, flagged as a duplicate next time', async () => {
    // GL-20455 was filed as an expense above, and one bill is entered once:
    // void the expense before entering it as a stock purchase.
    const asExpense = await prisma.expense.findFirstOrThrow({
      where: { organizationId: a.organizationId, billNumber: 'GL-20455', status: 'RECORDED' },
      select: { id: true },
    });
    await voidExpense(a.owner, asExpense.id, { reason: 'Re-entered as a stock purchase' });
    const purchase = await createPurchase(a.owner, {
      supplierId: byTrn.id,
      supplierInvoiceNumber: 'GL-20455',
      supplierInvoiceDate: localDateString(),
      items: [{ partId: a.parts['OF-TOY-01'].id, quantity: '2', unitCost: '18.50', taxRate: '5' }],
      scannedFields: 'supplier,billNumber',
    });
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: purchase.id, action: 'purchase.filled_from_scan' },
      }),
    );
    const draft = await readBill(a.owner, 'purchase', PDF_BILL.join('\n'));
    assert.deepEqual(draft.duplicate, {
      label: `Purchase ${purchase.purchaseNumber}`,
      href: `/inventory/purchases/${purchase.id}`,
    });

    // The file kept with it: attach, list, read, remove (soft).
    const document = await attachFile(a.owner, 'Purchase', purchase.id, {
      name: 'invoice.jpg',
      bytes: JPEG,
    });
    const [row] =
      (await listAttachments(a.owner, 'Purchase', [purchase.id])).get(purchase.id) ?? [];
    assert.equal(row.id, document.id);
    assert.deepEqual((await readAttachment(a.owner, 'Purchase', document.id)).bytes, JPEG);

    // A text file renamed .pdf is refused by its bytes.
    await expectDomainError(
      attachFile(a.owner, 'Purchase', purchase.id, {
        name: 'invoice.pdf',
        bytes: Buffer.from('not a pdf at all'),
      }),
      /isn’t a photo/,
    );

    // A view-only user opens it, but can neither add nor remove one.
    assert.ok(await readAttachment(partner, 'Purchase', document.id));
    await assert.rejects(
      attachFile(partner, 'Purchase', purchase.id, { name: 'x.jpg', bytes: JPEG }),
      isAuthError,
    );
    await assert.rejects(removeAttachment(partner, 'Purchase', document.id), isAuthError);

    await removeAttachment(a.owner, 'Purchase', document.id);
    assert.equal((await listAttachments(a.owner, 'Purchase', [purchase.id])).size, 0);
    const kept = await prisma.document.findUniqueOrThrow({ where: { id: document.id } });
    assert.ok(kept.deletedAt, 'soft delete: the row stays');
    assert.equal(kept.deletedByUserId, a.owner.id);
    assert.ok(
      await prisma.auditLog.findFirst({
        where: { entityId: purchase.id, action: 'purchase.bill_removed' },
      }),
    );
  });
});
