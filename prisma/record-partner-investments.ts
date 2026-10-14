/*
 * ONE-OFF — do not commit. Enters the partners' INVESTMENTS sheet (Shahid,
 * Afin, Munavar) as decided on 14 Oct 2026. The partners bought the whole
 * company from Mr. Naseer, its only owner: the same company, licence and VAT
 * number, new owners.
 *
 *   npx tsx prisma/record-partner-investments.ts           check only: reads, changes nothing
 *   npx tsx prisma/record-partner-investments.ts --apply   records it
 *
 * Partners: Afin and Munavar are added beside Shahid.
 *
 * Buying the company — NOT in its books (the partners bought it; the
 * company paid nothing): Money → Owner's money → Buying the business.
 *   #1–#6 Afin: approval fee, 10,000 key money to Mr. Naseer, three ownership
 *         transfer fees, agreement typing — 15,114.89
 *   #10   Shahid: 90,000 first payout to Mr. Naseer (cheque from Shahid &
 *         Munavar — each one's share to be confirmed; the sheet counts it
 *         as Shahid's)
 *
 * Paid by Afin for the company — IN its books, as Afin's capital. Each is
 * money he put in (Owner's money, capital) and the company spending it, so
 * cash on hand ends where it was:
 *   #7 #8 Establishment card 104.03 + MOHRE transfer 523.46 — the company's
 *         government fees, paid 14 Sep; booked 16 Sep, the books' first day
 *   #12   September salary 4,000 — his pay as the company's employee, not
 *         taken: a salary cost, left in as his capital
 *   #14   Laptop 2,500 — an office asset (computers), worn down over 3 years
 *
 * Already in the books: #13, #15 Shahid's cash 2,000 + 4,500 (OWN-000002/3).
 * Left for the bank statement: #9 RAK Bank 785 (what it paid is not known).
 *
 * Safe to run again: anything already recorded is skipped.
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { PERMISSION_CODES } from '@/lib/auth/permission-catalog';
import { addPartner, recordOwnerMoney } from '@/lib/finance/owner-money';
import { recordBusinessPurchasePayment } from '@/lib/finance/business-purchase';
import { recordExpense } from '@/lib/finance/expenses';
import { createFixedAsset } from '@/lib/accounting/fixed-assets';
import { toFils } from '@/lib/money';

const ORG = '01a0d2e0-cc97-700a-9f8a-6b9834e20c27';
const ACTOR = '01a0d2e1-5041-7561-ba63-05efe9cf5421';
const APPLY = process.argv.includes('--apply');

const PURCHASES = [
  { sheet: 1, partner: 'Afin', amount: '116.66', paidOn: '2026-09-09', paidTo: 'Tasheel', description: 'Initial approval fee — change of ownership', reference: 'SMS' },
  { sheet: 2, partner: 'Afin', amount: '10000.00', paidOn: '2026-09-10', paidTo: 'Mr. Naseer', description: 'Key money advance — buying the company', reference: 'Bank' },
  { sheet: 3, partner: 'Afin', amount: '381.78', paidOn: '2026-09-11', paidTo: 'Tasheel', description: 'Ownership transfer fee', reference: 'SMS' },
  { sheet: 4, partner: 'Afin', amount: '3842.19', paidOn: '2026-09-11', paidTo: 'Tasheel', description: 'Ownership transfer fee', reference: 'Copy' },
  { sheet: 5, partner: 'Afin', amount: '379.26', paidOn: '2026-09-11', paidTo: 'Tasheel', description: 'Ownership transfer fee', reference: 'SMS' },
  { sheet: 6, partner: 'Afin', amount: '395.00', paidOn: '2026-09-11', paidTo: 'Al Alif', description: 'Agreement writing (advance) — transfer agreement', reference: 'Copy' },
  { sheet: 10, partner: 'Shahid', amount: '90000.00', paidOn: '2026-09-20', paidTo: 'Mr. Naseer', description: '1st payout — buying the company', reference: 'Cheque', extra: 'Cheque from Shahid & Munavar — each one’s share to be confirmed.' },
];

/** Afin's money put in for something the company then paid for. */
const CAPITAL = [
  { sheet: '7, 8', amount: '627.49', movedOn: '2026-09-16', note: 'Paid by Afin on 14 Sep: the company’s establishment card and MOHRE fees' },
  { sheet: '12', amount: '4000.00', movedOn: '2026-09-30', note: 'Afin’s September salary, not taken — left in as capital' },
  { sheet: '14', amount: '2500.00', movedOn: '2026-09-28', note: 'Laptop for the office, bought by Afin' },
];

const EXPENSES = [
  { description: 'Establishment card approval fee — Tasheel (paid by Afin, 14 Sep)', amount: '104.03', date: '2026-09-16', account: '5180' },
  { description: 'MOHRE transfer fees — Tasheel (paid by Afin, 14 Sep)', amount: '523.46', date: '2026-09-16', account: '5180' },
  { description: 'Salary — Afin, September 2026 (not taken; left in as capital)', amount: '4000.00', date: '2026-09-30', account: '5160' },
];

const LAPTOP = { name: 'Laptop — office', acquiredOn: '2026-09-28', cost: '2500.00', months: '36' };

/** Ends in a colon, so #1 never matches #10. */
const tag = (sheet: number | string) => `Investments sheet #${sheet}:`;

async function main() {
  const actor = await prisma.user.findFirstOrThrow({
    where: { id: ACTOR, organizationId: ORG },
    select: { id: true, organizationId: true, fullName: true, primaryBranchId: true, email: true },
  });
  const user: AuthenticatedUser = {
    ...actor,
    roleNames: ['Owner'],
    orgWidePermissions: new Set(PERMISSION_CODES),
    branchPermissions: new Map(),
  };
  console.log(`As ${actor.fullName}. ${APPLY ? 'APPLYING.' : 'Check only — nothing will change.'}\n`);
  let problems = 0;

  const accounts = new Map(
    (
      await prisma.chartOfAccount.findMany({
        where: { organizationId: ORG, accountCode: { in: ['1000', '1530', '1590', '5160', '5180', '5800'] }, isActive: true },
        select: { id: true, accountCode: true },
      })
    ).map((account) => [account.accountCode, account.id]),
  );
  for (const code of ['1000', '1530', '1590', '5160', '5180', '5800']) {
    if (!accounts.has(code)) {
      console.log(`Account ${code} not found — refused`);
      problems += 1;
    }
  }

  // Afin's September salary must not already have gone through payroll.
  const septemberPayroll = await prisma.payroll.count({
    where: {
      organizationId: ORG,
      periodStart: { lte: new Date('2026-09-30') },
      periodEnd: { gte: new Date('2026-09-01') },
    },
  });
  if (septemberPayroll) {
    console.log('A payroll already covers September — the salary step would count it twice. Refused.');
    problems += 1;
  }

  const partners = async () =>
    new Map(
      (
        await prisma.partner.findMany({ where: { organizationId: ORG }, select: { id: true, name: true } })
      ).map((partner) => [partner.name.toLowerCase(), partner.id]),
    );
  let byName = await partners();
  const newPartners = ['Afin', 'Munavar'].filter((name) => !byName.has(name.toLowerCase()));
  console.log(newPartners.length ? `Partners to add: ${newPartners.join(', ')}` : 'Partners: all there');

  const purchases = [];
  for (const entry of PURCHASES) {
    const done = await prisma.businessPurchasePayment.count({
      where: { organizationId: ORG, voidedAt: null, notes: { startsWith: tag(entry.sheet) } },
    });
    if (done) console.log(`#${entry.sheet} ${entry.amount}: already recorded — skipped`);
    else {
      console.log(`#${entry.sheet} ${entry.partner} ${entry.amount} to ${entry.paidTo} → buying the business (outside the books)`);
      purchases.push(entry);
    }
  }

  const capital = [];
  for (const entry of CAPITAL) {
    const done = await prisma.ownerMoney.count({
      where: { organizationId: ORG, status: 'POSTED', notes: { startsWith: tag(entry.sheet) } },
    });
    if (done) console.log(`#${entry.sheet} capital ${entry.amount}: already recorded — skipped`);
    else {
      console.log(`#${entry.sheet} Afin ${entry.amount} → capital, into cash on hand on ${entry.movedOn}`);
      capital.push(entry);
    }
  }
  const expenses = [];
  for (const entry of EXPENSES) {
    const done = await prisma.expense.count({
      where: { organizationId: ORG, status: 'RECORDED', description: entry.description },
    });
    if (done) console.log(`  “${entry.description}”: already recorded — skipped`);
    else {
      console.log(`  ${entry.amount} → ${entry.account}, paid from cash on hand on ${entry.date}`);
      expenses.push(entry);
    }
  }
  const laptopDone = await prisma.fixedAsset.count({ where: { organizationId: ORG, name: LAPTOP.name } });
  console.log(
    laptopDone
      ? '  Laptop: already in fixed assets — skipped'
      : `  ${LAPTOP.cost} → fixed asset “${LAPTOP.name}” (1530), ${LAPTOP.months} months, paid from cash on hand`,
  );

  if (problems) {
    console.log(`\n${problems} problem(s). Nothing changed — send me this output.`);
    return;
  }
  if (!APPLY) {
    console.log('\nAll checks passed. Run again with --apply to record it.');
    return;
  }

  for (const name of newPartners) {
    await addPartner(user, { name });
    console.log(`  added partner ${name}`);
  }
  byName = await partners();
  const partnerId = (name: string) => byName.get(name.toLowerCase())!;

  for (const entry of purchases) {
    await recordBusinessPurchasePayment(user, {
      partnerId: partnerId(entry.partner),
      amount: entry.amount,
      paidOn: entry.paidOn,
      paidTo: entry.paidTo,
      description: entry.description,
      reference: entry.reference,
      notes: [tag(entry.sheet), entry.extra].filter(Boolean).join(' '),
    });
    console.log(`  done: #${entry.sheet}`);
  }
  for (const entry of capital) {
    await recordOwnerMoney(user, {
      kind: 'CAPITAL_IN',
      accountId: accounts.get('1000'),
      partnerId: partnerId('Afin'),
      amount: entry.amount,
      movedOn: entry.movedOn,
      notes: `${tag(entry.sheet)} ${entry.note}`,
    });
    console.log(`  done: capital #${entry.sheet}`);
  }
  for (const entry of expenses) {
    await recordExpense(user, {
      description: entry.description,
      amount: entry.amount,
      taxRate: '',
      expenseDate: entry.date,
      vendorName: entry.account === '5160' ? 'Afin' : 'Tasheel',
      paymentMethod: 'CASH',
      paidFromAccountId: accounts.get('1000'),
      categoryId: accounts.get(entry.account),
      notes: 'From the partners’ investments sheet: paid by Afin, recorded as his capital.',
    });
    console.log(`  done: ${entry.description}`);
  }
  if (!laptopDone) {
    await createFixedAsset(user, {
      name: LAPTOP.name,
      description: 'Bought by Afin for the office (investments sheet #14); recorded as his capital.',
      assetAccountId: accounts.get('1530'),
      accumulatedAccountId: accounts.get('1590'),
      expenseAccountId: accounts.get('5800'),
      acquiredOn: LAPTOP.acquiredOn,
      cost: LAPTOP.cost,
      residualValue: '0',
      usefulLifeMonths: LAPTOP.months,
      funding: 'PAID',
      paidFromAccountId: accounts.get('1000'),
    });
    console.log('  done: laptop');
  }

  // Each partner's whole investment, as the Owner's money screen shows it.
  const [money, bought] = await Promise.all([
    prisma.ownerMoney.findMany({
      where: { organizationId: ORG, status: 'POSTED' },
      select: { kind: true, amount: true, partner: { select: { name: true } } },
    }),
    prisma.businessPurchasePayment.findMany({
      where: { organizationId: ORG, voidedAt: null },
      select: { amount: true, partner: { select: { name: true } } },
    }),
  ]);
  console.log('\nTotal invested (sheet: Shahid 97,285 incl. RAK 785 still to confirm; Afin 22,242):');
  for (const name of ['Shahid', 'Afin', 'Munavar']) {
    const inBooks = money
      .filter((row) => row.partner?.name === name)
      .reduce((sum, row) => sum + (row.kind === 'DRAWINGS' ? -1 : 1) * toFils(row.amount.toString()), 0);
    const outside = bought
      .filter((row) => row.partner.name === name)
      .reduce((sum, row) => sum + toFils(row.amount.toString()), 0);
    console.log(
      `  ${name.padEnd(8)} in the company ${(inBooks / 100).toFixed(2).padStart(10)}   bought the business ${(outside / 100).toFixed(2).padStart(10)}   total ${((inBooks + outside) / 100).toFixed(2).padStart(10)}`,
    );
  }
  console.log('\nDone.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
