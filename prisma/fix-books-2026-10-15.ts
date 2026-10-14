/*
 * ONE-OFF — do not commit. The corrections found comparing the owners'
 * spreadsheet with the books (15 Oct 2026), made so the books read as if
 * everything had been entered right the first time: while September and
 * October are open, entries are corrected or removed where they stand — no
 * reversals, no duplicates. Every step goes through the app's own rules and
 * is kept in the audit log.
 *
 *   npx tsx prisma/fix-books-2026-10-15.ts           check only: reads, changes nothing
 *   npx tsx prisma/fix-books-2026-10-15.ts --apply   makes the corrections
 *
 * 1. EXP-000008 — fuel bill 015011 entered twice (EXP-000001 is the same
 *    bill): voided; in an open period its journal entry is removed, so it
 *    counts nowhere.
 * 2. Three costs missing from the books, recorded on their own dates, paid
 *    in cash and filed to their jobs:
 *      Al Amani 20962, KIA parts for Firoz (INV-000011), 3 Oct, 160 + VAT 8;
 *      Afzaal, Avanza labour (INV-000012), 19 Sep, 15;
 *      Noor Al Ahyan 7864, lathe works on the Kicks (INV-000013), 4 Oct, 20.
 * 3. Shaloop's 1,500 card payment on INV-000008 (2 Oct) went straight into
 *    RAK Bank: the receipt is booked to the bank instead of Card
 *    settlements, its entry corrected in place.
 * 4. The upholstery money: 450 a customer of Imran Upholstery Works paid
 *    on our card machine on 23 Sep, of which 416 was handed over in cash on
 *    10 Oct and 34 kept for the card charges. That is a card collection —
 *    money held for them, not our sale, not our expense. Payment voucher
 *    PV-000002 (which Imran signed for the 416) becomes that card
 *    collection; the expense it booked (EXP-000019) is voided and its entry
 *    removed; the hand-made entry of 23 Sep is deleted.
 * 5. EXP-000018 (350, the Audi A3 roof liner Imran fitted): filed under
 *    Cost of sales — sublet repairs, not Miscellaneous.
 *
 * Safe to run again: whatever is already done is skipped.
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { PERMISSION_CODES } from '@/lib/auth/permission-catalog';
import { recordExpense, voidExpense } from '@/lib/finance/expenses';
import { deleteManualEntry } from '@/lib/accounting/entries';
import { syncPosting } from '@/lib/accounting/journal';
import { booksClosedThrough } from '@/lib/accounting/periods';
import { writeAuditLog } from '@/lib/audit';

const ORG = '01a0d2e0-cc97-700a-9f8a-6b9834e20c27';
const ACTOR = '01a0d2e1-5041-7561-ba63-05efe9cf5421';
const APPLY = process.argv.includes('--apply');

const COSTS = [
  {
    invoice: 'INV-000011',
    description: 'Parts for the KIA — Firoz (INV-000011)',
    vendorName: 'Al Amani Trading L.L.C',
    billNumber: '20962',
    date: '2026-10-03',
    amount: '160.00',
    taxRate: '5',
    taxAmount: '8.00',
    account: '5000',
  },
  {
    invoice: 'INV-000012',
    description: 'Labour — Toyota Avanza (INV-000012)',
    vendorName: 'Afzaal',
    billNumber: '',
    date: '2026-09-19',
    amount: '15.00',
    taxRate: '',
    taxAmount: '',
    account: '5020',
  },
  {
    invoice: 'INV-000013',
    description: 'Lathe works — Nissan Kicks 97180 (INV-000013)',
    vendorName: 'Noor Al Ahyan',
    billNumber: '7864',
    date: '2026-10-04',
    amount: '20.00',
    taxRate: '',
    taxAmount: '',
    account: '5020',
  },
];

const day = (text: string) => new Date(`${text}T00:00:00Z`);

async function balances() {
  const rows = await prisma.$queryRaw<{ code: string; name: string; balance: string }[]>`
    SELECT a.account_code AS code, a.account_name AS name,
           COALESCE(SUM(l.debit_amount - l.credit_amount), 0)::text AS balance
      FROM chart_of_accounts a
      LEFT JOIN journal_entry_lines l ON l.chart_of_account_id = a.id
     WHERE a.organization_id = ${ORG}::uuid
       AND (a.account_code IN ('1000', '1005', '1010', '1020', '1300', '2000', '4100', '5000', '5020', '5110', '5190', '5900')
            OR a.role = 'MONEY_HELD_FOR_OTHERS')
     GROUP BY a.account_code, a.account_name
     ORDER BY a.account_code`;
  return rows;
}

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
  console.log(
    `As ${actor.fullName}. ${APPLY ? 'APPLYING.' : 'Check only — nothing will change.'}\n`,
  );

  const closed = await booksClosedThrough(prisma, ORG);
  if (closed && closed >= day('2026-10-10')) {
    console.log(
      `The books are closed through ${closed.toISOString().slice(0, 10)}: these corrections would be reversals. Stopped.`,
    );
    return;
  }
  const reconciled = await prisma.reconciledLine.count({ where: { organizationId: ORG } });
  if (reconciled > 0) {
    console.log(
      `Note: ${reconciled} line(s) are ticked on a bank reconciliation. A ticked entry is reversed, not corrected — check those first.`,
    );
  }

  const before = await balances();
  const account = async (code: string) =>
    (
      await prisma.chartOfAccount.findFirstOrThrow({
        where: { organizationId: ORG, accountCode: code },
        select: { id: true },
      })
    ).id;
  const [bank, card, sublet] = await Promise.all([
    account('1010'),
    account('1020'),
    account('5020'),
  ]);
  let problems = 0;
  const steps: { label: string; run: () => Promise<unknown> }[] = [];

  // 1. The fuel bill entered twice.
  const duplicate = await prisma.expense.findFirst({
    where: { organizationId: ORG, expenseNumber: 'EXP-000008' },
    select: { id: true, status: true, billNumber: true, amount: true },
  });
  const original = await prisma.expense.findFirst({
    where: {
      organizationId: ORG,
      expenseNumber: 'EXP-000001',
      status: 'RECORDED',
      billNumber: '015011',
    },
    select: { id: true },
  });
  if (!duplicate || duplicate.billNumber !== '015011' || !original) {
    console.log('1. EXP-000008 / EXP-000001 not as expected (both bill 015011) — refused');
    problems += 1;
  } else if (duplicate.status === 'VOID') {
    console.log('1. EXP-000008 already voided — skipped');
  } else {
    console.log(
      '1. EXP-000008 (30.00, fuel bill 015011, the same bill as EXP-000001) → voided, its entry removed',
    );
    steps.push({
      label: 'EXP-000008 voided',
      run: () =>
        voidExpense(user, duplicate.id, {
          reason: 'Entered twice: the same fuel bill 015011 as EXP-000001.',
        }),
    });
  }

  // 2. The three missing costs.
  const categories = new Map(
    (
      await prisma.chartOfAccount.findMany({
        where: { organizationId: ORG, accountCode: { in: ['5000', '5020'] }, isActive: true },
        select: { id: true, accountCode: true },
      })
    ).map((row) => [row.accountCode, row.id]),
  );
  for (const cost of COSTS) {
    const invoice = await prisma.invoice.findFirst({
      where: {
        organizationId: ORG,
        invoiceNumber: cost.invoice,
        status: { notIn: ['VOID', 'CANCELLED', 'DRAFT'] },
      },
      select: { id: true },
    });
    const already = await prisma.expense.count({
      where: { organizationId: ORG, description: cost.description, status: 'RECORDED' },
    });
    if (already) {
      console.log(`2. ${cost.description}: already recorded — skipped`);
    } else if (!invoice || !categories.has(cost.account)) {
      console.log(
        `2. ${cost.description}: ${!invoice ? `${cost.invoice} not found` : `account ${cost.account} missing`} — refused`,
      );
      problems += 1;
    } else {
      console.log(
        `2. ${cost.date} ${cost.vendorName} ${cost.billNumber || ''} ${cost.amount}${cost.taxAmount ? ` + VAT ${cost.taxAmount}` : ''} → ${cost.description}`,
      );
      steps.push({
        label: cost.description,
        run: () =>
          recordExpense(user, {
            description: cost.description,
            amount: cost.amount,
            taxRate: cost.taxRate,
            taxAmount: cost.taxAmount,
            expenseDate: cost.date,
            vendorName: cost.vendorName,
            billNumber: cost.billNumber,
            paymentMethod: 'CASH',
            categoryId: categories.get(cost.account),
            forJob: `invoice:${invoice.id}`,
          }),
      });
    }
  }

  // 3. Shaloop's 1,500 into the bank.
  const shaloop = await prisma.payment.findFirst({
    where: {
      organizationId: ORG,
      invoice: { invoiceNumber: 'INV-000008' },
      amount: 1500,
      method: 'CARD',
      status: 'COMPLETED',
      reversalOfPaymentId: null,
    },
    select: { id: true, paymentNumber: true, accountId: true },
  });
  if (!shaloop) {
    console.log('3. Shaloop’s 1,500 card receipt on INV-000008 not found — refused');
    problems += 1;
  } else if (shaloop.accountId === bank) {
    console.log(`3. ${shaloop.paymentNumber} already booked to the bank — skipped`);
  } else if (shaloop.accountId && shaloop.accountId !== card) {
    console.log(`3. ${shaloop.paymentNumber} is booked to an unexpected account — refused`);
    problems += 1;
  } else {
    console.log(
      `3. ${shaloop.paymentNumber} (1,500.00, 2 Oct) → into Bank — current account; its entry corrected in place`,
    );
    steps.push({
      label: `${shaloop.paymentNumber} into the bank`,
      run: () =>
        prisma.$transaction(async (tx) => {
          await tx.payment.update({ where: { id: shaloop.id }, data: { accountId: bank } });
          await writeAuditLog(tx, {
            organizationId: ORG,
            actorUserId: user.id,
            action: 'payment.account_corrected',
            entityType: 'Payment',
            entityId: shaloop.id,
            beforeData: { accountId: shaloop.accountId },
            afterData: { accountId: bank },
            metadata: { reason: 'The card payment was credited straight to RAK Bank on 2 Oct.' },
          });
          await syncPosting(tx, ORG, 'PAYMENT', shaloop.id, user.id);
        }),
    });
  }

  // 4. The upholstery money, as the card collection it was.
  const voucher = await prisma.paymentVoucher.findFirst({
    where: { organizationId: ORG, voucherNumber: 'PV-000002' },
    select: {
      id: true,
      kind: true,
      status: true,
      amount: true,
      payeeName: true,
      expenseId: true,
      paymentMethod: true,
      paidOn: true,
    },
  });
  const upholsteryEntry = await prisma.journalEntry.findFirst({
    where: {
      organizationId: ORG,
      sourceType: 'MANUAL',
      entryDate: day('2026-09-23'),
      description: { startsWith: 'Upholstery team received' },
    },
    select: { id: true, entryNumber: true },
  });
  if (
    !voucher ||
    voucher.payeeName !== 'Imran Upholstery Works' ||
    String(voucher.amount) !== '416'
  ) {
    console.log('4. PV-000002 (416 to Imran Upholstery Works) not as expected — refused');
    problems += 1;
  } else if (voucher.kind === 'CARD_COLLECTION') {
    console.log('4. PV-000002 is already the card collection — skipped');
  } else if (
    voucher.kind !== 'WORK' ||
    voucher.status !== 'PAID' ||
    !voucher.expenseId ||
    // Without them the pay-over would not be booked.
    !voucher.paymentMethod ||
    !voucher.paidOn
  ) {
    console.log(
      '4. PV-000002 is not a paid outside-work voucher with its payment day and method — refused',
    );
    problems += 1;
  } else {
    const expense = await prisma.expense.findFirst({
      where: { id: voucher.expenseId, organizationId: ORG },
      select: { id: true, expenseNumber: true, status: true },
    });
    console.log(
      `4. PV-000002 → card collection for Imran Upholstery Works: 450.00 into the bank on 23 Sep, 416.00 paid over in cash on 10 Oct, 34.00 kept for the card charges; ${expense?.expenseNumber} voided, its entry removed`,
    );
    steps.push({
      label: 'PV-000002 as the card collection',
      run: () =>
        prisma.$transaction(async (tx) => {
          await tx.paymentVoucher.update({
            where: { id: voucher.id },
            data: {
              kind: 'CARD_COLLECTION',
              expenseId: null,
              description:
                'Card payment of AED 450 taken on our machine on 23 Sep for Imran Upholstery Works (they have none), Auth 198308. Paid over less 34.00 kept for the card charges.',
              collectedOn: day('2026-09-23'),
              collectedAmount: '450',
              cardAccountId: bank,
              cardReference: 'Auth 198308',
              feeAmount: '34',
              feeVatAmount: '0',
            },
          });
          if (expense && expense.status === 'RECORDED') {
            await tx.expense.update({ where: { id: expense.id }, data: { status: 'VOID' } });
            await writeAuditLog(tx, {
              organizationId: ORG,
              actorUserId: user.id,
              action: 'expense.voided',
              entityType: 'Expense',
              entityId: expense.id,
              beforeData: { status: 'RECORDED' },
              afterData: { status: 'VOID' },
              metadata: {
                reason: 'Not an expense: the upholsterer’s own card money, paid over (PV-000002).',
              },
            });
            await syncPosting(tx, ORG, 'EXPENSE', expense.id, user.id);
          }
          await writeAuditLog(tx, {
            organizationId: ORG,
            actorUserId: user.id,
            action: 'payment_voucher.corrected',
            entityType: 'PaymentVoucher',
            entityId: voucher.id,
            beforeData: { kind: 'WORK', expenseId: voucher.expenseId },
            afterData: {
              kind: 'CARD_COLLECTION',
              collectedOn: '2026-09-23',
              collectedAmount: '450.00',
              feeAmount: '34.00',
            },
            metadata: {
              reason:
                'Card money collected for Imran Upholstery Works and paid over — not our sale or expense.',
            },
          });
          await syncPosting(tx, ORG, 'CARD_COLLECTION', voucher.id, user.id);
          await syncPosting(tx, ORG, 'PAYMENT_VOUCHER', voucher.id, user.id);
        }),
    });
  }
  if (!upholsteryEntry) {
    console.log('4. The hand-made upholstery entry of 23 Sep is already gone — skipped');
  } else {
    console.log(
      `4. ${upholsteryEntry.entryNumber} (the hand-made 450 of 23 Sep) → deleted: the card collection books it`,
    );
    steps.push({
      label: `${upholsteryEntry.entryNumber} deleted`,
      run: () =>
        deleteManualEntry(user, upholsteryEntry.id, {
          reason: 'Replaced by the card collection on PV-000002, which books the same 450.',
        }),
    });
  }

  // 5. The roof liner, as the sublet cost it is.
  const roofLiner = await prisma.expense.findFirst({
    where: { organizationId: ORG, expenseNumber: 'EXP-000018', status: 'RECORDED' },
    select: { id: true, chartOfAccountId: true, description: true },
  });
  if (!roofLiner || !/roof liner/i.test(roofLiner.description)) {
    console.log('5. EXP-000018 (roof liner) not found — refused');
    problems += 1;
  } else if (roofLiner.chartOfAccountId === sublet) {
    console.log('5. EXP-000018 already under Cost of sales — sublet repairs — skipped');
  } else {
    console.log('5. EXP-000018 (350.00, Audi A3 roof liner) → Cost of sales — sublet repairs');
    steps.push({
      label: 'EXP-000018 to sublet repairs',
      run: () =>
        prisma.$transaction(async (tx) => {
          await tx.expense.update({
            where: { id: roofLiner.id },
            data: { chartOfAccountId: sublet },
          });
          await writeAuditLog(tx, {
            organizationId: ORG,
            actorUserId: user.id,
            action: 'expense.category_corrected',
            entityType: 'Expense',
            entityId: roofLiner.id,
            beforeData: { chartOfAccountId: roofLiner.chartOfAccountId },
            afterData: { chartOfAccountId: sublet },
            metadata: {
              reason: 'The roof liner Imran fitted on the Audi A3 is the job’s outside work.',
            },
          });
          await syncPosting(tx, ORG, 'EXPENSE', roofLiner.id, user.id);
        }),
    });
  }

  console.log(`\n${steps.length} correction(s) to make, ${problems} refused.`);
  if (!APPLY) {
    console.log('Check only. Run again with --apply to make them.');
    return;
  }
  for (const step of steps) {
    await step.run();
    console.log(`  done: ${step.label}`);
  }

  const after = await balances();
  console.log('\nAccount                                   before        after');
  for (const row of after) {
    const was = before.find((b) => b.code === row.code)?.balance ?? '0';
    console.log(
      `${`${row.code} ${row.name}`.padEnd(40)} ${Number(was).toFixed(2).padStart(10)}   ${Number(row.balance).toFixed(2).padStart(10)}`,
    );
  }
  const reversals = await prisma.journalEntry.count({
    where: {
      organizationId: ORG,
      reversalOfJournalEntryId: { not: null },
      createdAt: { gte: new Date(Date.now() - 10 * 60_000) },
    },
  });
  console.log(`\nReversing entries made just now: ${reversals} (expected 0).`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
