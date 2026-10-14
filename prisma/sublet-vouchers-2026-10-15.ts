/*
 * ONE-OFF — do not commit. The sublet work entered as plain expenses was
 * outside work, paid in cash from Cash on hand (owners, 15 Oct 2026). Each
 * becomes what entering it as outside work would have made: the same
 * expense — same number, same journal entry — with its outside-work payment
 * voucher, filed to its job. Nothing is deleted, reversed or entered twice.
 *
 *   npx tsx prisma/sublet-vouchers-2026-10-15.ts           check only: reads, changes nothing
 *   npx tsx prisma/sublet-vouchers-2026-10-15.ts --apply   makes the changes
 *
 * 1. EXP-000013 (Tyre Point, wheel alignment of the Kicks 97180, 4 Oct)
 *    filed to its job, JC-000015 (INV-000013). Filing moves no figure.
 * 2. EXP-000022 (Harikrishnan, 30, 13 Oct) paid from Cash on hand, not Petty
 *    cash: its journal entry corrected in place.
 * 3. An outside-work voucher for every sublet expense that has none, in date
 *    order, for what was paid (with the VAT, where the bill carried some),
 *    in cash from Cash on hand.
 *
 * EXP-000025 (Patrol, 120) and EXP-000026 (Audi, 100) were entered without
 * the name of whoever was paid; a voucher names its payee, so they wait for
 * the names (add them to PAYEES below).
 *
 * Safe to run again: whatever is already done is skipped.
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma';
import { allocateDocumentNumber } from '@/lib/numbering';
import { syncPosting } from '@/lib/accounting/journal';
import { booksClosedThrough } from '@/lib/accounting/periods';
import { writeAuditLog } from '@/lib/audit';
import { filsToString, toFils } from '@/lib/money';

const ORG = '01a0d2e0-cc97-700a-9f8a-6b9834e20c27';
const ACTOR = '01a0d2e1-5041-7561-ba63-05efe9cf5421';
const APPLY = process.argv.includes('--apply');

/** Who was paid, for the sublet expenses entered without a name. */
const PAYEES: Record<string, string> = {
  // The owners' sale report has them under "Sublet repairs", no one named.
  'EXP-000025': 'Sublet repairs (outside workshop)',
  'EXP-000026': 'Sublet repairs (outside workshop)',
};
const NO_NAME = 'Cash — no bill';

async function main() {
  const actor = await prisma.user.findFirstOrThrow({
    where: { id: ACTOR, organizationId: ORG },
    select: { id: true, fullName: true },
  });
  console.log(
    `As ${actor.fullName}. ${APPLY ? 'APPLYING.' : 'Check only — nothing will change.'}\n`,
  );

  const closed = await booksClosedThrough(prisma, ORG);
  if (closed && closed >= new Date('2026-09-16T00:00:00Z')) {
    console.log(`The books are closed through ${closed.toISOString().slice(0, 10)}: stopped.`);
    return;
  }

  const account = async (code: string) =>
    (
      await prisma.chartOfAccount.findFirstOrThrow({
        where: { organizationId: ORG, accountCode: code },
        select: { id: true },
      })
    ).id;
  const [cashOnHand, sublet] = await Promise.all([account('1000'), account('5020')]);
  let problems = 0;
  const steps: { label: string; run: () => Promise<unknown> }[] = [];

  // 1. The Kicks alignment, filed to its job.
  const kicksJob = await prisma.jobCard.findFirst({
    where: { organizationId: ORG, jobNumber: 'JC-000015' },
    select: { id: true, invoices: { select: { invoiceNumber: true } } },
  });
  const alignment = await prisma.expense.findFirst({
    where: { organizationId: ORG, expenseNumber: 'EXP-000013', status: 'RECORDED' },
    select: { id: true, jobCardId: true, invoiceId: true, vendorName: true },
  });
  if (!kicksJob || !kicksJob.invoices.some((invoice) => invoice.invoiceNumber === 'INV-000013')) {
    console.log('1. JC-000015 is not the Kicks job of INV-000013 — refused');
    problems += 1;
  } else if (!alignment || !/tyre point/i.test(alignment.vendorName ?? '')) {
    console.log('1. EXP-000013 (Tyre Point) not found — refused');
    problems += 1;
  } else if (alignment.jobCardId === kicksJob.id) {
    console.log('1. EXP-000013 already filed to JC-000015 — skipped');
  } else {
    console.log(
      '1. EXP-000013 (Tyre Point, Kicks alignment, 4 Oct) → filed to JC-000015 (INV-000013)',
    );
    steps.push({
      label: 'EXP-000013 filed to JC-000015',
      run: () =>
        prisma.$transaction(async (tx) => {
          await tx.expense.update({
            where: { id: alignment.id },
            data: { jobCardId: kicksJob.id, invoiceId: null },
          });
          await writeAuditLog(tx, {
            organizationId: ORG,
            actorUserId: actor.id,
            action: 'expense.job_corrected',
            entityType: 'Expense',
            entityId: alignment.id,
            beforeData: { jobCardId: alignment.jobCardId, invoiceId: alignment.invoiceId },
            afterData: { jobCardId: kicksJob.id },
            metadata: { reason: 'The wheel alignment of the Kicks 97180 (INV-000013).' },
          });
        }),
    });
  }

  // 2. Harikrishnan's 30, paid from Cash on hand.
  const trial = await prisma.expense.findFirst({
    where: { organizationId: ORG, expenseNumber: 'EXP-000022', status: 'RECORDED' },
    select: { id: true, paidFromAccountId: true, paymentMethod: true },
  });
  if (!trial) {
    console.log('2. EXP-000022 not found — refused');
    problems += 1;
  } else if (trial.paidFromAccountId === cashOnHand) {
    console.log('2. EXP-000022 already paid from Cash on hand — skipped');
  } else {
    console.log(
      '2. EXP-000022 (Harikrishnan, 30, 13 Oct) → paid from Cash on hand; its entry corrected in place',
    );
    steps.push({
      label: 'EXP-000022 from Cash on hand',
      run: () =>
        prisma.$transaction(async (tx) => {
          await tx.expense.update({
            where: { id: trial.id },
            data: { paidFromAccountId: cashOnHand, paymentMethod: 'CASH' },
          });
          await tx.paymentVoucher.updateMany({
            where: { organizationId: ORG, expenseId: trial.id },
            data: { paidFromAccountId: cashOnHand, paymentMethod: 'CASH' },
          });
          await writeAuditLog(tx, {
            organizationId: ORG,
            actorUserId: actor.id,
            action: 'expense.paid_from_corrected',
            entityType: 'Expense',
            entityId: trial.id,
            beforeData: { paidFromAccountId: trial.paidFromAccountId },
            afterData: { paidFromAccountId: cashOnHand },
            metadata: { reason: 'Paid in cash from Cash on hand.' },
          });
          await syncPosting(tx, ORG, 'EXPENSE', trial.id, actor.id);
        }),
    });
  }

  // 3. A voucher for every sublet expense without one, oldest first.
  const withoutVoucher = await prisma.expense.findMany({
    where: {
      organizationId: ORG,
      status: 'RECORDED',
      chartOfAccountId: sublet,
      paymentVoucher: null,
    },
    orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      expenseNumber: true,
      branchId: true,
      description: true,
      vendorName: true,
      amount: true,
      taxAmount: true,
      expenseDate: true,
      paymentMethod: true,
      paidFromAccountId: true,
      paymentReference: true,
      jobCardId: true,
      invoiceId: true,
    },
  });
  for (const expense of withoutVoucher) {
    const number = expense.expenseNumber ?? '';
    const payee =
      PAYEES[number] ??
      (expense.vendorName && expense.vendorName !== NO_NAME ? expense.vendorName : null);
    const paid = filsToString(
      toFils(expense.amount.toString()) + toFils(expense.taxAmount?.toString() ?? '0'),
    );
    const date = expense.expenseDate.toISOString().slice(0, 10);
    if (!payee) {
      console.log(
        `3. ${number} (${paid}, ${date}) — no name for who was paid: waits (add it to PAYEES)`,
      );
      continue;
    }
    if (expense.paidFromAccountId && expense.paidFromAccountId !== cashOnHand) {
      console.log(`3. ${number} is paid from another account — refused`);
      problems += 1;
      continue;
    }
    // Step 1 files the Kicks alignment before this voucher is made.
    const filedInStep1 = Boolean(kicksJob && alignment && expense.id === alignment.id);
    if (!expense.jobCardId && !expense.invoiceId && !filedInStep1) {
      console.log(`3. ${number} (${payee}) is filed to no job — waits until it is`);
      continue;
    }
    console.log(`3. ${number} ${date} ${payee}: ${paid} in cash → outside-work voucher`);
    steps.push({
      label: `${number} voucher`,
      run: () =>
        prisma.$transaction(async (tx) => {
          if (!expense.paymentMethod || !expense.paidFromAccountId) {
            await tx.expense.update({
              where: { id: expense.id },
              data: { paymentMethod: 'CASH', paidFromAccountId: cashOnHand },
            });
            // The default cash account was already Cash on hand: no figure moves.
            await syncPosting(tx, ORG, 'EXPENSE', expense.id, actor.id);
          }
          const voucherNumber = await allocateDocumentNumber(
            tx,
            ORG,
            expense.branchId,
            'PAYMENT_VOUCHER',
          );
          const voucher = await tx.paymentVoucher.create({
            data: {
              organizationId: ORG,
              branchId: expense.branchId,
              voucherNumber,
              kind: 'WORK',
              status: 'PAID',
              payeeName: payee.replace(/\s+/g, ' '),
              description: expense.description,
              amount: paid,
              paidOn: expense.expenseDate,
              paymentMethod: 'CASH',
              paidFromAccountId: cashOnHand,
              paymentReference: expense.paymentReference,
              expenseId: expense.id,
              createdByUserId: actor.id,
            },
            select: { id: true },
          });
          await writeAuditLog(tx, {
            organizationId: ORG,
            branchId: expense.branchId,
            actorUserId: actor.id,
            action: 'payment_voucher.recorded',
            entityType: 'PaymentVoucher',
            entityId: voucher.id,
            afterData: {
              voucherNumber,
              kind: 'WORK',
              payeeName: payee,
              amount: paid,
              paidOn: date,
              expense: number,
            },
            metadata: { reason: 'Outside work entered as an expense: its voucher added.' },
          });
          console.log(`     ${voucherNumber}`);
        }),
    });
  }

  console.log(`\n${steps.length} change(s) to make, ${problems} refused.`);
  if (!APPLY) {
    console.log('Check only. Run again with --apply to make them.');
    return;
  }
  for (const step of steps) {
    await step.run();
    console.log(`  done: ${step.label}`);
  }
  const reversals = await prisma.journalEntry.count({
    where: { organizationId: ORG, reversalOfJournalEntryId: { not: null } },
  });
  console.log(`\nReversing entries in the books: ${reversals} (expected 0).`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
