/**
 * Integration tests for capital put in without cash or bank, and each
 * partner's whole investment (lib/finance/owner-money.ts,
 * lib/finance/partner-contributions.ts):
 *
 *  - a business cost a partner paid from their own pocket books
 *    Dr the expense / Cr Owner's capital, named for the partner;
 *  - something the business owed a partner, left in, books
 *    Dr what was owed / Cr Owner's capital;
 *  - neither is allowed without a partner, as a loan, or against a cash account;
 *  - a partner's page lists their owner's money and what they paid to buy
 *    the business, in date order with a running total; void entries count
 *    for nothing.
 *
 * Every record is made in a throwaway test organization.
 *
 *   npx tsx --test tests/partner-contributions.test.ts
 */
import 'dotenv/config';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '@/lib/prisma';
import {
  addPartner,
  getOwnerMoneyForm,
  listOwnerMoney,
  recordOwnerMoney,
  voidOwnerMoney,
} from '@/lib/finance/owner-money';
import { recordBusinessPurchasePayment } from '@/lib/finance/business-purchase';
import { getPartnerContributions } from '@/lib/finance/partner-contributions';
import { createTestOrg, expectDomainError, RUN, type TestOrg } from './support';

let a: TestOrg;
let afin: string;
let shahid: string;
let form: Awaited<ReturnType<typeof getOwnerMoneyForm>>;

before(async () => {
  a = await createTestOrg('Partner contributions', []);
  afin = (await addPartner(a.owner, { name: `Afin ${RUN}` })).id;
  shahid = (await addPartner(a.owner, { name: `Shahid ${RUN}` })).id;
  form = await getOwnerMoneyForm(a.owner);
});

after(async () => {
  await prisma.$disconnect();
});

/** The entry an owner's money record booked: account code → [debit, credit]. */
async function entryOf(id: string) {
  const entry = await prisma.journalEntry.findFirstOrThrow({
    where: { organizationId: a.organizationId, sourceType: 'OWNER_MONEY', sourceId: id },
    select: {
      description: true,
      lines: {
        select: {
          debitAmount: true,
          creditAmount: true,
          chartOfAccount: { select: { accountCode: true } },
        },
      },
    },
  });
  return {
    description: entry.description,
    lines: Object.fromEntries(
      entry.lines.map((line) => [
        line.chartOfAccount.accountCode,
        [line.debitAmount.toFixed(2), line.creditAmount.toFixed(2)],
      ]),
    ),
  };
}

describe('capital put in without cash or bank', () => {
  test('a cost paid from the partner’s pocket: Dr the expense / Cr capital', async () => {
    const fees = form.direct.cost.find((account) => account.code === '5180') ?? form.direct.cost[0];
    assert.ok(fees, 'an expense account to choose');
    assert.ok(
      !form.direct.cost.some((account) => account.code === '5000'),
      'cost of parts is the stock postings’ own, never chosen by hand',
    );
    const row = await recordOwnerMoney(a.owner, {
      kind: 'CAPITAL_IN',
      how: 'cost',
      accountId: fees.id,
      partnerId: afin,
      amount: '627.49',
      movedOn: '2026-09-14',
      notes: 'Establishment card and MOHRE fees',
    });
    const entry = await entryOf(row.id);
    assert.deepEqual(entry.lines[fees.code], ['627.49', '0.00']);
    assert.deepEqual(entry.lines['3000'], ['0.00', '627.49']);
    assert.match(entry.description ?? '', /Afin/);

    const list = await listOwnerMoney(a.owner);
    assert.match(list.rows.find((r) => r.id === row.id)!.where, /^paid for /);
  });

  test('something owed, left in: Dr what was owed / Cr capital', async () => {
    const salaries = form.direct.owed.find((account) => account.code === '2200');
    assert.ok(salaries, 'salaries payable can be left in');
    const row = await recordOwnerMoney(a.owner, {
      kind: 'CAPITAL_IN',
      how: 'owed',
      accountId: salaries.id,
      partnerId: afin,
      amount: '4000',
      movedOn: '2026-09-30',
    });
    const entry = await entryOf(row.id);
    assert.deepEqual(entry.lines['2200'], ['4000.00', '0.00']);
    assert.deepEqual(entry.lines['3000'], ['0.00', '4000.00']);
  });

  test('refused without a partner, as a loan, or against the wrong account', async () => {
    const fees = form.direct.cost[0];
    const cash = form.accounts.find((account) => account.kind === 'cash')!;
    const base = { amount: '10', movedOn: '2026-09-14' };
    await expectDomainError(
      recordOwnerMoney(a.owner, { ...base, kind: 'CAPITAL_IN', how: 'cost', accountId: fees.id }),
      /Choose the partner/,
    );
    await expectDomainError(
      recordOwnerMoney(a.owner, {
        ...base,
        kind: 'LOAN_IN',
        how: 'cost',
        accountId: fees.id,
        partnerId: afin,
      }),
      /Only money put in/,
    );
    await expectDomainError(
      recordOwnerMoney(a.owner, {
        ...base,
        kind: 'CAPITAL_IN',
        how: 'cost',
        accountId: cash.id,
        partnerId: afin,
      }),
      /Choose the expense/,
    );
    await expectDomainError(
      recordOwnerMoney(a.owner, {
        ...base,
        kind: 'CAPITAL_IN',
        how: 'money',
        accountId: fees.id,
        partnerId: afin,
      }),
      /cash, petty cash or bank/,
    );
  });
});

describe('a partner’s whole investment', () => {
  test('owner’s money and buying the business, in date order, void ones left out', async () => {
    const cash = form.accounts.find((account) => account.kind === 'cash')!;
    await recordBusinessPurchasePayment(a.owner, {
      partnerId: afin,
      amount: '10000',
      paidOn: '2026-09-10',
      paidTo: 'Previous owner',
      description: 'Key money advance',
    });
    await recordOwnerMoney(a.owner, {
      kind: 'CAPITAL_IN',
      accountId: cash.id,
      partnerId: afin,
      amount: '2500',
      movedOn: '2026-09-28',
    });
    const mistake = await recordOwnerMoney(a.owner, {
      kind: 'CAPITAL_IN',
      accountId: cash.id,
      partnerId: afin,
      amount: '999',
      movedOn: '2026-09-29',
    });
    await voidOwnerMoney(a.owner, mistake.id, { reason: 'Entered twice' });
    await recordOwnerMoney(a.owner, {
      kind: 'DRAWINGS',
      accountId: cash.id,
      partnerId: afin,
      amount: '500',
      movedOn: '2026-10-01',
    });
    // Another partner's money is not theirs.
    await recordOwnerMoney(a.owner, {
      kind: 'CAPITAL_IN',
      accountId: cash.id,
      partnerId: shahid,
      amount: '2000',
      movedOn: '2026-09-28',
    });

    const page = await getPartnerContributions(a.owner, afin);
    // 10,000 bought + 627.49 fees + 4,000 salary + 2,500 cash − 500 drawings.
    assert.equal(page.totals.capitalIn, '7127.49');
    assert.equal(page.totals.drawings, '500.00');
    assert.equal(page.totals.inBusiness, '6627.49');
    assert.equal(page.totals.bought, '10000.00');
    assert.equal(page.totals.invested, '16627.49');
    assert.deepEqual(
      page.lines.map((line) => line.amount),
      ['10000.00', '627.49', '2500.00', '4000.00', '-500.00'],
      'date order: 10, 14, 28, 30 Sep, 1 Oct — the void one left out',
    );
    assert.equal(page.lines.at(-1)!.runningTotal, '16627.49');
    assert.equal(page.lines[0].source, 'purchase');
    assert.ok(page.lines[1].journalEntry, 'owner’s money shows its journal entry');

    const other = await getPartnerContributions(a.owner, shahid);
    assert.equal(other.totals.invested, '2000.00');
  });
});
