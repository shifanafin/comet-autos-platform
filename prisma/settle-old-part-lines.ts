/*
 * ONE-OFF — do not commit. Settles the old Parts lines (typed before parts
 * were tied to stock) of Mohammed Mowla's workshop, as decided on 13 Oct 2026
 * from the suppliers' bills, the purchase notes and the job cards. Each line
 * goes through the app's own rule (lib/inventory/old-part-lines.ts) — the
 * same as the Old parts lines screen.
 *
 *   npx tsx prisma/settle-old-part-lines.ts           dry run: checks and shows, changes nothing
 *   npx tsx prisma/settle-old-part-lines.ts --apply   settles them
 *
 * Already written off (cost already in the books; only job profit changes):
 *   INV-000009 Link Rod, Axle Boot, Cut Bush   the write-offs name INV-000009
 *                                              (bill PO-000009, 21 Sep — the invoice's day)
 *   INV-000003 RR RH Shockabsorber KYB         SHOCK LEXUS RR IS250, the car a Lexus IS300
 *   INV-000006 Engine Mount Nissan Sunny       ENG MOUN TOYOTO JAPAN, bill 28 Sep (PO-000008)
 *   INV-000001 FR Brake pads - Genuine         BRAKE PAD RR 460, on the 17 Sep bill (PO-000013)
 *                                              with the rear brake shoe fitted on the same job
 *   INV-000011 Rear arm bushes                 Bush R Trailing, bill 3 Oct (PO-000015)
 *   INV-000008 RR LOWER ARM BOOTS              Boot Ball Joint, bill 1 Oct (PO-000002)
 *
 * Work, not a part (moves to labour sales; total and VAT unchanged):
 *   INV-000010 Roof liner installation         upholstery work (its cost: EXP-000018)
 *   INV-000011 Injector cleaning               a cleaning service
 *   INV-000013 Steering rack repair            a repair; the used steering assy
 *                                              (PO-000016) was for a Suzuki Ertiga
 *
 * And an outside cost filed against its job (job profit only, books unchanged):
 *   EXP-000010 Gear box repair — Nissan Sunny  → JC-000010, Nissan Sunny transmission
 *                                              overhaul (INV-000005)
 *
 * Left for the workshop — no purchase of their parts is recorded anywhere:
 *   INV-000001 Periodic service, genuine oil & Filter
 *   INV-000011 Periodic Service 5k lube, Spark Plugs, LH Rear Axle seal
 *   INV-000008 FR UPPER AND LOWER BOOTS (4 boots, written off in two lots of 2)
 *
 * Refuses a line that is no longer as found. Safe to run again: a line
 * already settled is skipped.
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit';
import {
  costFromWriteOff,
  getOldPartLines,
  markAsWork,
} from '@/lib/inventory/old-part-lines';
import { toFils } from '@/lib/money';

const ORG = '01a0d2e0-cc97-700a-9f8a-6b9834e20c27';
const ACTOR = '01a0d2e1-5041-7561-ba63-05efe9cf5421';
const APPLY = process.argv.includes('--apply');

type Step =
  | { invoice: string; line: string; how: 'WRITE_OFF'; movementId: string; why: string }
  | { invoice: string; line: string; how: 'WORK'; why: string };

const PLAN: Step[] = [
  { invoice: 'INV-000009', line: 'Link Rod', how: 'WRITE_OFF', movementId: 'ab908abf-b1b5-48ca-b77c-b5a14283f411', why: 'ST LINK — write-off names INV-000009' },
  { invoice: 'INV-000009', line: 'Axle Boot', how: 'WRITE_OFF', movementId: '30b62dfe-d42c-4e1f-ae0b-e3b5411124db', why: 'BOOT — write-off names INV-000009' },
  { invoice: 'INV-000009', line: 'Cut Bush', how: 'WRITE_OFF', movementId: 'e9bdb4fc-dfaf-4343-9d16-793c2237a0df', why: 'CUT BUSH — write-off names INV-000009' },
  { invoice: 'INV-000003', line: 'RR RH Shockabsorber KYB', how: 'WRITE_OFF', movementId: '98829f6d-4d63-41e7-aad6-52c875ea87c2', why: 'SHOCK LEXUS RR IS250 — Lexus IS300' },
  { invoice: 'INV-000006', line: 'Engine Mount Nissan Sunny', how: 'WRITE_OFF', movementId: '876fba0f-54f5-4d72-8b61-c493b1abdf12', why: 'ENG MOUN TOYOTO JAPAN — bill 28 Sep' },
  { invoice: 'INV-000001', line: 'FR Brake pads - Genuine', how: 'WRITE_OFF', movementId: '73476a6d-3adc-4ceb-9cff-05c04e028536', why: 'BRAKE PAD RR 460 — 17 Sep bill with this job’s brake shoe' },
  { invoice: 'INV-000011', line: 'Rear arm bushes', how: 'WRITE_OFF', movementId: '73c171ae-6cf4-4cfe-b2d1-2490c3991792', why: 'Bush R Trailing — bill 3 Oct' },
  { invoice: 'INV-000008', line: 'RR LOWER ARM BOOTS', how: 'WRITE_OFF', movementId: '222fa37e-1df7-454d-a518-a22f18c352fe', why: 'Boot Ball Joint — bill 1 Oct' },
  { invoice: 'INV-000010', line: 'Roof liner installation', how: 'WORK', why: 'upholstery work' },
  { invoice: 'INV-000011', line: 'Injector cleaning', how: 'WORK', why: 'a cleaning service' },
  { invoice: 'INV-000013', line: 'Steering rack repair', how: 'WORK', why: 'a repair' },
];

const EXPENSE = { number: 'EXP-000010', job: 'JC-000010' };

async function balances() {
  const rows = await prisma.$queryRaw<{ role: string; balance: string }[]>`
    SELECT a.role::text AS role, SUM(l.debit_amount - l.credit_amount)::text AS balance
    FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.chart_of_account_id
    WHERE l.organization_id = ${ORG}::uuid
      AND a.role IN ('INVENTORY', 'COST_OF_PARTS', 'STOCK_ADJUSTMENTS', 'SALES_PARTS', 'SALES_LABOUR', 'ACCOUNTS_RECEIVABLE', 'VAT_OUTPUT')
    GROUP BY a.role`;
  const out: Record<string, number> = {};
  for (const row of rows) {
    const text = row.balance ?? '0';
    out[row.role] = text.startsWith('-') ? -toFils(text.slice(1)) : toFils(text);
  }
  return out;
}

async function main() {
  const actor = await prisma.user.findFirstOrThrow({
    where: { id: ACTOR, organizationId: ORG },
    select: { id: true, organizationId: true, fullName: true, primaryBranchId: true, email: true },
  });
  const user: AuthenticatedUser = {
    ...actor,
    roleNames: ['Owner'],
    orgWidePermissions: new Set(['accounting.view', 'invoice.edit']),
    branchPermissions: new Map(),
  };
  console.log(`As ${actor.fullName}. ${APPLY ? 'APPLYING.' : 'Dry run — nothing will change.'}\n`);

  const { open } = await getOldPartLines(user);
  const before = await balances();
  let problems = 0;
  const todo: { step: Step; itemId: string }[] = [];

  for (const step of PLAN) {
    const label = `${step.invoice}  ${step.line}`.padEnd(48);
    const done = await prisma.invoiceItem.findFirst({
      where: {
        organizationId: ORG,
        invoice: { invoiceNumber: step.invoice },
        description: step.line,
        OR: [{ costMovementId: { not: null } }, { itemType: 'LABOUR' }],
      },
      select: { id: true },
    });
    const line = open.find((entry) => entry.invoiceNumber === step.invoice && entry.description === step.line);
    if (!line) {
      if (done) console.log(`${label} already settled — skipped`);
      else {
        console.log(`${label} NOT FOUND as an open line — refused`);
        problems += 1;
      }
      continue;
    }
    if (step.how === 'WRITE_OFF' && ![...line.likely, ...line.others].includes(step.movementId)) {
      console.log(`${label} its write-off is no longer available for it — refused`);
      problems += 1;
      continue;
    }
    if (step.how === 'WORK' && line.rebookBlocker) {
      console.log(`${label} ${line.rebookBlocker} — refused`);
      problems += 1;
      continue;
    }
    console.log(
      `${label} ${step.how === 'WORK' ? 'work, not a part' : 'already written off'}: ${step.why}`,
    );
    todo.push({ step, itemId: line.id });
  }

  const expense = await prisma.expense.findFirst({
    where: { organizationId: ORG, expenseNumber: EXPENSE.number },
    select: { id: true, branchId: true, jobCardId: true, invoiceId: true, description: true },
  });
  const job = await prisma.jobCard.findFirst({
    where: { organizationId: ORG, jobNumber: EXPENSE.job },
    select: { id: true },
  });
  const fileExpense = Boolean(expense && job && !expense.jobCardId && !expense.invoiceId);
  if (!expense || !job) {
    console.log(`\n${EXPENSE.number} or ${EXPENSE.job} NOT FOUND — refused`);
    problems += 1;
  } else if (expense.jobCardId === job.id) {
    console.log(`\n${EXPENSE.number} already filed against ${EXPENSE.job} — skipped`);
  } else if (!fileExpense) {
    console.log(`\n${EXPENSE.number} is already filed against another job — refused`);
    problems += 1;
  } else {
    console.log(`\n${EXPENSE.number} “${expense.description}” → filed against ${EXPENSE.job}`);
  }

  if (problems) {
    console.log(`\n${problems} problem(s). Nothing changed — send me this output.`);
    return;
  }
  if (!APPLY) {
    console.log(`\n${todo.length} line(s) to settle. Run again with --apply to settle them.`);
    return;
  }

  for (const { step, itemId } of todo) {
    if (step.how === 'WRITE_OFF') await costFromWriteOff(user, { itemId, movementId: step.movementId });
    else await markAsWork(user, { itemId });
    console.log(`  settled: ${step.invoice} ${step.line}`);
  }
  if (fileExpense && expense && job) {
    await prisma.$transaction(async (tx) => {
      await tx.expense.update({ where: { id: expense.id }, data: { jobCardId: job.id } });
      await writeAuditLog(tx, {
        organizationId: ORG,
        branchId: expense.branchId,
        actorUserId: ACTOR,
        action: 'expense.filed_to_job',
        entityType: 'Expense',
        entityId: expense.id,
        beforeData: { jobCardId: null },
        afterData: { jobCardId: job.id },
        metadata: { reason: 'Outside gearbox repair for the Nissan Sunny transmission overhaul (JC-000010, INV-000005).' },
      });
    });
    console.log(`  filed: ${EXPENSE.number} → ${EXPENSE.job}`);
  }

  // The write-offs and the expense change nothing in the books; the work
  // lines only move income from parts sales to labour sales.
  const after = await balances();
  const moved = (role: string) => (after[role] ?? 0) - (before[role] ?? 0);
  const unchanged = ['INVENTORY', 'COST_OF_PARTS', 'STOCK_ADJUSTMENTS', 'ACCOUNTS_RECEIVABLE', 'VAT_OUTPUT'];
  console.log('\nBooks after:');
  for (const role of unchanged) console.log(`  ${role.padEnd(20)} moved ${moved(role) / 100}`);
  console.log(`  ${'SALES_PARTS'.padEnd(20)} moved ${moved('SALES_PARTS') / 100} (less parts income)`);
  console.log(`  ${'SALES_LABOUR'.padEnd(20)} moved ${moved('SALES_LABOUR') / 100} (more labour income)`);
  const wrong = unchanged.filter((role) => moved(role) !== 0);
  if (wrong.length || moved('SALES_PARTS') + moved('SALES_LABOUR') !== 0) {
    console.log('\nSOMETHING MOVED THAT SHOULD NOT HAVE — send me this output.');
  } else {
    console.log('\nDone. Stock, cost of sales, VAT and what customers owe are unchanged.');
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
