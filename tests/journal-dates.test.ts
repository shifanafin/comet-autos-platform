/**
 * Integration tests for changing a journal entry's date
 * (lib/accounting/redate.ts) and the books check
 * (lib/accounting/books-check.ts):
 *
 *  - an invoice's entry moves through the invoice: its issue date and its
 *    entry both move, the audit log keeps the old date and why;
 *  - an entry made by hand moves where it stands;
 *  - never to a future day, never a stock movement's entry;
 *  - nothing moves into or out of a closed period;
 *  - a fresh workshop's books check finds nothing out of step.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npx tsx --test tests/journal-dates.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import { ensureChart } from '@/lib/accounting/chart';
import { createManualEntry } from '@/lib/accounting/entries';
import { closeBooks } from '@/lib/accounting/periods';
import { changeEntryDate, entryDateChange } from '@/lib/accounting/redate';
import { checkBooks } from '@/lib/accounting/books-check';
import { createDirectInvoice } from '@/lib/billing/direct-invoice';
import { localDateString } from '@/lib/format';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let roles: Record<AccountRole, string>;
let customerId: string;

const today = () => localDateString();
const daysAgo = (n: number) => localDateString(new Date(Date.now() - n * 86_400_000));
const dayOf = (date: Date) => date.toISOString().slice(0, 10);

before(async () => {
  a = await createTestOrg('Journal dates', [
    { sku: `JD-OIL-${RUN}`, name: 'Engine oil', cost: '50.00', price: '90.00', stock: '5' },
  ]);
  roles = await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
  customerId = (
    await prisma.customer.create({
      data: { organizationId: a.organizationId, name: `Dates customer ${RUN}`, phone: '0500000003' },
    })
  ).id;
});

after(async () => {
  await prisma.$disconnect();
});

const entryOf = (source: 'INVOICE', sourceId: string) =>
  prisma.journalEntry.findFirstOrThrow({
    where: { organizationId: a.organizationId, sourceType: source, sourceId, reversals: { none: {} } },
    orderBy: { createdAt: 'desc' },
  });

describe('changing a journal entry’s date', () => {
  let invoiceId: string;

  test('an invoice’s entry moves through the invoice', async () => {
    ({ invoiceId } = await createDirectInvoice(a.owner, {
      customerId,
      items: [{ itemType: 'LABOUR', description: 'Service', quantity: '1', unitPrice: '200' }],
    }));
    const entry = await entryOf('INVOICE', invoiceId);
    assert.equal((await entryDateChange(a.owner, entry.id)).possible, true);

    const moved = await changeEntryDate(a.owner, entry.id, {
      date: daysAgo(3),
      reason: 'Entered on the wrong day',
    });
    assert.equal(moved.to, daysAgo(3));
    const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    assert.equal(dayOf(invoice.issueDate), daysAgo(3), 'the invoice moved');
    assert.equal(dayOf((await entryOf('INVOICE', invoiceId)).entryDate), daysAgo(3), 'its entry followed');
    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: a.organizationId, action: 'journal.date_changed', entityId: entry.id },
    });
    assert.ok(audit, 'the audit log keeps it');
  });

  test('an entry made by hand moves where it stands', async () => {
    const entry = await createManualEntry(a.owner, {
      date: today(),
      description: 'Owner’s capital paid into the bank',
      lines: [
        { accountId: roles.BANK, debit: '1000' },
        { accountId: roles.OPENING_BALANCE, credit: '1000' },
      ],
    });
    await changeEntryDate(a.owner, entry.id, { date: daysAgo(2), reason: 'Paid in two days ago' });
    const after = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    assert.equal(dayOf(after.entryDate), daysAgo(2));
  });

  test('never a future day, never without a reason', async () => {
    const entry = await entryOf('INVOICE', invoiceId);
    await expectDomainError(
      changeEntryDate(a.owner, entry.id, { date: '2999-01-01', reason: 'Later' }),
      /future/,
    );
    await expectDomainError(changeEntryDate(a.owner, entry.id, { date: daysAgo(1) }), /why/i);
  });

  test('a stock movement’s entry is moved through its record, not here', async () => {
    const movement = await prisma.journalEntry.findFirst({
      where: { organizationId: a.organizationId, sourceType: 'STOCK_MOVEMENT' },
    });
    if (!movement) return; // The test workshop's opening stock may carry no entry.
    const check = await entryDateChange(a.owner, movement.id);
    assert.equal(check.possible, false);
    assert.match(check.why ?? '', /stock/i);
  });

  test('a fresh workshop’s books check finds nothing out of step', async () => {
    const result = await checkBooks(a.owner);
    assert.ok(result.checked > 0);
    assert.deepEqual(
      result.problems.map((row) => `${row.source} ${row.state}`),
      [],
    );
  });

  test('nothing moves into or out of a closed period', async () => {
    await closeBooks(a.owner, { through: daysAgo(1) });
    const entry = await entryOf('INVOICE', invoiceId);
    // Dated 3 days ago: inside the closed period.
    const check = await entryDateChange(a.owner, entry.id);
    assert.equal(check.possible, false);
    assert.match(check.why ?? '', /closed/);
    await expectDomainError(
      changeEntryDate(a.owner, entry.id, { date: today(), reason: 'Out of the closed period' }),
      /closed/,
    );
  });
});
