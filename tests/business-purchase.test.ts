/**
 * Integration tests for buying the business (lib/finance/business-purchase.ts):
 *
 *  - a partner's payment to buy the company is kept against them, and
 *    books nothing: no journal entry, no account moves;
 *  - a future date or an unknown partner is refused;
 *  - voided, it stays on record and counts for nothing.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npx tsx --test tests/business-purchase.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import { addPartner } from '@/lib/finance/owner-money';
import {
  listBusinessPurchasePayments,
  recordBusinessPurchasePayment,
  voidBusinessPurchasePayment,
} from '@/lib/finance/business-purchase';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let partnerId: string;

before(async () => {
  a = await createTestOrg('Business purchase', []);
  partnerId = (await addPartner(a.owner, { name: `Partner ${RUN}` })).id;
});

after(async () => {
  await prisma.$disconnect();
});

const journalLines = () => prisma.journalEntryLine.count({ where: { organizationId: a.organizationId } });

describe('buying the business', () => {
  test('kept against the partner, and nothing is booked', async () => {
    const linesBefore = await journalLines();
    const row = await recordBusinessPurchasePayment(a.owner, {
      partnerId,
      amount: '90000',
      paidOn: '2026-09-20',
      paidTo: 'Previous owner',
      description: '1st payout — buying the company',
      reference: 'Cheque 1',
    });
    await recordBusinessPurchasePayment(a.owner, {
      partnerId,
      amount: '381.78',
      paidOn: '2026-09-11',
      paidTo: 'Tasheel',
      description: 'Ownership transfer fee',
    });
    assert.equal(await journalLines(), linesBefore, 'no journal entry');

    const list = await listBusinessPurchasePayments(a.owner);
    assert.equal(list.total, '90381.78');
    assert.equal(list.byPartner.get(partnerId), 9038178);

    await voidBusinessPurchasePayment(a.owner, row.id, { reason: 'Entered twice' });
    const after = await listBusinessPurchasePayments(a.owner);
    assert.equal(after.total, '381.78');
    assert.equal(after.rows.length, 2, 'the void one stays on record');
    await expectDomainError(
      voidBusinessPurchasePayment(a.owner, row.id, { reason: 'Again' }),
      /already void/,
    );
  });

  test('a future date or an unknown partner is refused', async () => {
    await expectDomainError(
      recordBusinessPurchasePayment(a.owner, {
        partnerId,
        amount: '10',
        paidOn: '2999-01-01',
        paidTo: 'Tasheel',
        description: 'Fee',
      }),
      /not a future one/,
    );
    await expectDomainError(
      recordBusinessPurchasePayment(a.owner, {
        partnerId: '01a0d2e0-0000-7000-8000-000000000000',
        amount: '10',
        paidOn: '2026-09-11',
        paidTo: 'Tasheel',
        description: 'Fee',
      }),
      /Choose a partner/,
    );
  });
});
