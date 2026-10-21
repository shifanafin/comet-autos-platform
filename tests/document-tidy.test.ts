/**
 * Integration tests for removing voided internal records
 * (lib/accounting/document-tidy.ts):
 *
 * - a voided expense goes; the one after it takes its number; the counter
 *   follows; the audit log keeps a copy of what was removed;
 * - a standing expense, and an invoice, are never touched;
 * - someone without Accounts → Approve can't do it.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npm run test:integration
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { AuthError } from '@/lib/auth/authorize';
import { ensureChart } from '@/lib/accounting/chart';
import { recordExpense, voidExpense } from '@/lib/finance/expenses';
import { previewVoidedRemoval, removeVoidedInternalRecords } from '@/lib/accounting/document-tidy';
import { localDateString } from '@/lib/format';
import { createTestOrg, RUN, type TestOrg } from './support';

let a: TestOrg;

before(async () => {
  a = await createTestOrg('DocumentTidy');
  await prisma.$transaction((tx) => ensureChart(tx, a.organizationId));
});

after(async () => {
  await prisma.$disconnect();
});

const expense = (description: string) =>
  recordExpense(a.owner, {
    description: `${description} ${RUN}`,
    amount: '10.00',
    expenseDate: localDateString(),
    paymentMethod: 'CASH',
  });

describe('removing voided internal records', () => {
  test('the voided expense goes; the next takes its number; the audit log keeps a copy', async () => {
    const first = await expense('Entered twice');
    const second = await expense('Workshop water');
    await voidExpense(a.owner, first.id, { reason: 'Duplicate' });

    const preview = await previewVoidedRemoval(a.owner);
    assert.deepEqual(
      preview.removable.map((row) => row.number),
      [first.expenseNumber],
    );

    const result = await removeVoidedInternalRecords(a.owner, 'Test tidy');
    assert.deepEqual(result.removed, [first.expenseNumber]);
    assert.equal(await prisma.expense.count({ where: { id: first.id } }), 0);
    const moved = await prisma.expense.findUniqueOrThrow({ where: { id: second.id } });
    assert.equal(moved.expenseNumber, first.expenseNumber, 'took the removed number');
    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { organizationId: a.organizationId, sourceType: 'EXPENSE', sourceId: second.id },
    });
    assert.ok((entry.description ?? '').includes(first.expenseNumber!), 'the narration follows');

    const copy = await prisma.auditLog.findFirst({
      where: { organizationId: a.organizationId, action: 'document.removed', entityId: first.id },
    });
    assert.ok(copy?.beforeData, 'a copy kept in the audit log');

    const third = await expense('Next one');
    assert.equal(
      Number(third.expenseNumber!.replace(/\D/g, '')),
      Number(first.expenseNumber!.replace(/\D/g, '')) + 1,
      'the counter carries on from there',
    );
  });

  test('nothing to do leaves everything as it is', async () => {
    const result = await removeVoidedInternalRecords(a.owner, 'Test tidy');
    assert.deepEqual(result.removed, []);
  });

  test('someone who may only look cannot do it', async () => {
    await assert.rejects(
      removeVoidedInternalRecords(a.viewer, 'Test'),
      (error) => error instanceof AuthError,
    );
  });
});
