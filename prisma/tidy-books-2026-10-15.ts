/*
 * ONE-OFF — do not commit. The last tidying found auditing the whole books
 * (15 Oct 2026), so every record stands on its real date and nothing is in
 * twice. Corrections in place, through the app's own rules — no reversals.
 *
 *   npx tsx prisma/tidy-books-2026-10-15.ts           check only: reads, changes nothing
 *   npx tsx prisma/tidy-books-2026-10-15.ts --apply   makes the changes
 *
 * 1. Six receipts dated on the day they were typed, not the day the money
 *    came in (the owners' cash sheet and RAK Bank page): each is moved to its
 *    real day and its journal entry with it; the journal renumbers itself in
 *    date order.
 * 2. Two records entered twice: the customer "ANEEM KP" (same phone as
 *    "Aneem KP", never used) is merged into "Aneem KP"; the supplier "Nahar
 *    Al Madina Auto Spare Parts" (PO-000007) is merged into its full legal
 *    name, "NAHAR AL MADINA AUTO SPARE PARTS TRADING L.L.C", as on its tax
 *    invoice.
 *
 * Safe to run again: whatever is already done is skipped.
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { PERMISSION_CODES } from '@/lib/auth/permission-catalog';
import { syncPosting } from '@/lib/accounting/journal';
import { booksClosedThrough } from '@/lib/accounting/periods';
import { writeAuditLog } from '@/lib/audit';
import { mergeCustomers } from '@/lib/customers/merge';
import { mergeSuppliers } from '@/lib/inventory/supplier-merge';

const ORG = '01a0d2e0-cc97-700a-9f8a-6b9834e20c27';
const ACTOR = '01a0d2e1-5041-7561-ba63-05efe9cf5421';
const APPLY = process.argv.includes('--apply');

/** The day each receipt's money really came in, and where that is written. */
const RECEIPTS = [
  {
    number: 'RCT-000008',
    invoice: 'INV-000012',
    day: '2026-09-19',
    source: 'cash sheet 19/09: Avanza service, payment from Fahim 150',
  },
  {
    number: 'RCT-000001',
    invoice: 'INV-000009',
    day: '2026-09-21',
    source: 'cash sheet 21/09: Ertiga, payment from Rasik TP 900',
  },
  {
    number: 'RCT-000010',
    invoice: 'INV-000003',
    day: '2026-09-28',
    source: 'RAK Bank page 28/09: Jamsheer paid 550 (card)',
  },
  {
    number: 'RCT-000003',
    invoice: 'INV-000005',
    day: '2026-09-30',
    source: 'cash sheet 30/09: Sunny, payment from Bemil 2,705',
  },
  {
    number: 'RCT-000004',
    invoice: 'INV-000006',
    day: '2026-09-30',
    source: 'cash sheet 30/09: Sunny, payment from Bemil 2,705',
  },
  {
    number: 'RCT-000009',
    invoice: 'INV-000011',
    day: '2026-10-04',
    source: 'cash sheet 04/10: KIA, payment from Firoz Ikka',
  },
];

/** Midday in Dubai on that day: the accounting day is the same everywhere. */
const middayDubai = (day: string) => new Date(`${day}T12:00:00+04:00`);
const dubaiDay = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(date);

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
  if (closed && closed >= new Date('2026-09-16T00:00:00Z')) {
    console.log(`The books are closed through ${closed.toISOString().slice(0, 10)}: stopped.`);
    return;
  }
  let problems = 0;
  const steps: { label: string; run: () => Promise<unknown> }[] = [];

  // 1. Receipts on the day the money came in.
  for (const receipt of RECEIPTS) {
    const payment = await prisma.payment.findFirst({
      where: {
        organizationId: ORG,
        paymentNumber: receipt.number,
        status: 'COMPLETED',
        reversalOfPaymentId: null,
      },
      select: {
        id: true,
        receivedAt: true,
        method: true,
        invoice: { select: { invoiceNumber: true, issueDate: true } },
        journalEntry: { select: { id: true } },
      },
    });
    if (!payment || payment.invoice.invoiceNumber !== receipt.invoice) {
      console.log(`1. ${receipt.number} on ${receipt.invoice} not found — refused`);
      problems += 1;
      continue;
    }
    const was = dubaiDay(payment.receivedAt);
    if (was === receipt.day) {
      console.log(`1. ${receipt.number} already dated ${receipt.day} — skipped`);
      continue;
    }
    if (receipt.day < payment.invoice.issueDate.toISOString().slice(0, 10)) {
      console.log(`1. ${receipt.number}: ${receipt.day} is before its invoice — refused`);
      problems += 1;
      continue;
    }
    const reconciled = await prisma.reconciledLine.count({
      where: {
        organizationId: ORG,
        line: { journalEntry: { sourceType: 'PAYMENT', sourceId: payment.id } },
      },
    });
    if (reconciled > 0) {
      console.log(
        `1. ${receipt.number} is ticked on a bank reconciliation — refused (it would be reversed)`,
      );
      problems += 1;
      continue;
    }
    // Jamsheer paid by card, which went straight into the bank.
    const method = receipt.number === 'RCT-000010' ? 'CARD' : payment.method;
    console.log(
      `1. ${receipt.number} (${receipt.invoice}) ${was} → ${receipt.day}${method !== payment.method ? `, by ${method}` : ''}  [${receipt.source}]`,
    );
    steps.push({
      label: `${receipt.number} to ${receipt.day}`,
      run: () =>
        prisma.$transaction(async (tx) => {
          await tx.payment.update({
            where: { id: payment.id },
            data: { receivedAt: middayDubai(receipt.day), method },
          });
          await writeAuditLog(tx, {
            organizationId: ORG,
            actorUserId: user.id,
            action: 'payment.date_corrected',
            entityType: 'Payment',
            entityId: payment.id,
            beforeData: { receivedOn: was, method: payment.method },
            afterData: { receivedOn: receipt.day, method },
            metadata: { reason: `The day the money came in: ${receipt.source}.` },
          });
          await syncPosting(tx, ORG, 'PAYMENT', payment.id, user.id);
        }),
    });
  }

  // 2. Records entered twice.
  const customers = await prisma.customer.findMany({
    where: { organizationId: ORG, phone: '0505633442' },
    select: { id: true, name: true, _count: { select: { invoices: true, jobCards: true } } },
  });
  const keepCustomer = customers.find((c) => c.name === 'Aneem KP');
  const dupCustomer = customers.find((c) => c.name === 'ANEEM KP');
  if (!dupCustomer) {
    console.log('2. Customer "ANEEM KP" already merged — skipped');
  } else if (!keepCustomer) {
    console.log('2. Customer "Aneem KP" not found — refused');
    problems += 1;
  } else {
    console.log(
      `2. Customer "ANEEM KP" (${dupCustomer._count.invoices} invoices, ${dupCustomer._count.jobCards} jobs) → merged into "Aneem KP"`,
    );
    steps.push({
      label: 'ANEEM KP merged',
      run: () =>
        mergeCustomers(user, dupCustomer.id, {
          targetId: keepCustomer.id,
          reason: 'Entered twice: the same customer and phone.',
        }),
    });
  }
  const suppliers = await prisma.supplier.findMany({
    where: { organizationId: ORG, name: { contains: 'nahar', mode: 'insensitive' } },
    select: { id: true, name: true, _count: { select: { purchases: true } } },
  });
  const legal = suppliers.find((s) => s.name === 'NAHAR AL MADINA AUTO SPARE PARTS TRADING L.L.C');
  const shortName = suppliers.find((s) => s.name === 'Nahar Al Madina Auto Spare Parts');
  if (!shortName) {
    console.log('2. Supplier "Nahar Al Madina Auto Spare Parts" already merged — skipped');
  } else if (!legal) {
    console.log('2. Supplier "NAHAR AL MADINA AUTO SPARE PARTS TRADING L.L.C" not found — refused');
    problems += 1;
  } else {
    console.log(
      `2. Supplier "Nahar Al Madina Auto Spare Parts" (${shortName._count.purchases} purchase) → merged into "NAHAR AL MADINA AUTO SPARE PARTS TRADING L.L.C"`,
    );
    steps.push({
      label: 'Nahar merged',
      run: () =>
        mergeSuppliers(user, shortName.id, {
          targetId: legal.id,
          reason: 'Entered twice: the legal name is the one on its tax invoice.',
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
  const entries = await prisma.journalEntry.count({ where: { organizationId: ORG } });
  console.log(
    `\nReversing entries in the books: ${reversals} (expected 0). Journal: JV-000001 to JV-${String(entries).padStart(6, '0')}.`,
  );
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
