/**
 * Integration tests for catching an entry made twice, by its number:
 *
 *  - an expense's bill number may not repeat for the same vendor, nor match
 *    a stock purchase from a supplier of that name (and the other way round);
 *    another vendor, no vendor, or a voided expense doesn't block;
 *  - a payment reference (cheque, transfer, card slip) is never refused, but
 *    the live entries already carrying it are found to warn with — not
 *    voided ones, not the expense being edited, and only what the user may see.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npx tsx --test tests/duplicate-entries.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { ensureChart } from '@/lib/accounting/chart';
import { recordExpense, updateExpense, voidExpense } from '@/lib/finance/expenses';
import { recordMoneyTransfer, voidMoneyTransfer } from '@/lib/finance/money';
import { findReferenceMatches } from '@/lib/finance/reference-matches';
import { createPurchase } from '@/lib/inventory/purchases';
import { createSupplier } from '@/lib/inventory/suppliers';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;
let supplierId: string;

const today = () => localDateString();
const VENDOR = `Al Noor Trading ${RUN}`;

const paidExpense = (fields: Record<string, string>) =>
  recordExpense(a.owner, {
    description: `Workshop supplies ${RUN}`,
    amount: '100',
    expenseDate: today(),
    paymentMethod: 'CASH',
    paidFromAccountId: roles.CASH,
    ...fields,
  });

before(async () => {
  a = await createTestOrg('Duplicates', [
    { sku: 'DUP-OIL', name: 'Engine oil', cost: '20', price: '35', stock: '0' },
  ]);
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  supplierId = (await createSupplier(a.owner, { name: VENDOR })).id;
});

after(async () => {
  await prisma.$disconnect();
});

describe('bill numbers are entered once', () => {
  let firstId: string;

  test('the same vendor’s bill number is refused, naming the expense it is on', async () => {
    const first = await paidExpense({ vendorName: VENDOR, billNumber: 'INV-501' });
    firstId = first.id;
    await expectDomainError(
      paidExpense({ vendorName: VENDOR.toUpperCase(), billNumber: 'inv-501' }),
      new RegExp(`already entered as ${first.expenseNumber}`),
    );
  });

  test('another vendor or no vendor is not a duplicate — unless the date and total match too', async () => {
    await paidExpense({ vendorName: `Other Vendor ${RUN}`, billNumber: 'INV-501', amount: '101' });
    await paidExpense({ billNumber: 'INV-501', amount: '102' });
    await paidExpense({ billNumber: 'INV-501', amount: '103' });
    // Same number, date and total is the same bill, whoever it is said to be from.
    await expectDomainError(
      paidExpense({ vendorName: `Third Vendor ${RUN}`, billNumber: 'INV-501', amount: '101' }),
      /already entered as/,
    );
  });

  test('editing an expense keeps its own bill number; voiding frees it', async () => {
    await updateExpense(a.owner, firstId, {
      description: `Workshop supplies ${RUN} (corrected)`,
      amount: '110',
      expenseDate: today(),
      paymentMethod: 'CASH',
      paidFromAccountId: roles.CASH,
      vendorName: VENDOR,
      billNumber: 'INV-501',
    });
    await voidExpense(a.owner, firstId, { reason: 'Entered on the wrong date' });
    await paidExpense({ vendorName: VENDOR, billNumber: 'INV-501' });
  });

  test('a bill on a stock purchase cannot also be entered as an expense, and the other way round', async () => {
    const purchase = await createPurchase(a.owner, {
      supplierId,
      supplierInvoiceNumber: 'GRN-77',
      supplierInvoiceDate: today(),
      items: JSON.stringify([{ partId: a.parts['DUP-OIL'].id, quantity: '2', unitCost: '20' }]),
    });
    await expectDomainError(
      paidExpense({ vendorName: VENDOR, billNumber: 'GRN-77' }),
      new RegExp(`purchase ${purchase.purchaseNumber}`),
    );
    const expense = await paidExpense({ vendorName: VENDOR, billNumber: 'EXP-BILL-9' });
    await expectDomainError(
      createPurchase(a.owner, {
        supplierId,
        supplierInvoiceNumber: 'exp-bill-9',
        items: JSON.stringify([{ partId: a.parts['DUP-OIL'].id, quantity: '1', unitCost: '20' }]),
      }),
      new RegExp(`expense ${expense.expenseNumber}`),
    );
  });
});

describe('payment references warn, never refuse', () => {
  const CHEQUE = `CHQ-${RUN}`;
  let expenseId: string;

  test('a repeated reference still saves, and both live entries are found', async () => {
    const expense = await paidExpense({ paymentReference: CHEQUE });
    expenseId = expense.id;
    const transfer = await recordMoneyTransfer(a.owner, {
      fromAccountId: roles.CASH,
      toAccountId: roles.BANK,
      amount: '50',
      transferredOn: today(),
      reference: CHEQUE,
    });

    const matches = await findReferenceMatches(a.owner, `  ${CHEQUE.toLowerCase()} `);
    assert.deepEqual(matches.map((m) => m.label).sort(), [
      `Expense ${expense.expenseNumber}`,
      `Transfer ${transfer.transferNumber}`,
    ]);
    assert.ok(matches.some((m) => m.href === `/finance/expenses/${expense.id}`));

    // A voided transfer no longer counts.
    await voidMoneyTransfer(a.owner, transfer.id, { reason: 'Keyed twice' });
    assert.deepEqual(
      (await findReferenceMatches(a.owner, CHEQUE)).map((m) => m.label),
      [`Expense ${expense.expenseNumber}`],
    );
  });

  test('the expense being edited does not match itself', async () => {
    assert.deepEqual(await findReferenceMatches(a.owner, CHEQUE, expenseId), []);
  });

  test('short references are ignored, and only entries the user may see are shown', async () => {
    assert.deepEqual(await findReferenceMatches(a.owner, 'NA'), []);
    assert.deepEqual(
      await findReferenceMatches(a.viewer, CHEQUE),
      [],
      'a viewer without expense or money access sees nothing',
    );
  });

  test('another organization’s references are never matched', async () => {
    const other = await createTestOrg('Duplicates other');
    assert.deepEqual(await findReferenceMatches(other.owner, CHEQUE), []);
  });
});
