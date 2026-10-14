/*
 * ONE-OFF — do not commit. Records the job costs on the owners' sale report
 * (15 Sep – 14 Oct 2026) that were missing from the books, as decided on
 * 14 Oct 2026. Each goes through the app's own rules.
 *
 *   npx tsx prisma/record-job-costs.ts           check only: reads, changes nothing
 *   npx tsx prisma/record-job-costs.ts --apply   records them
 *
 * 1. INV-000001 (Mitsubishi Mirage, 17 Sep) — oil & filter. Bought on Al
 *    Amani's tax invoice GHCA26-19276 of 16 Sep (PO-000022, 95.00 + VAT
 *    4.75 — the VAT is already claimed on the purchase), entered on 13 Oct,
 *    so both parts still show on the shelf. NOT a new expense (that would
 *    count it twice): they leave stock for the car they went into —
 *      the oil (80.00) on the invoice's Parts line, costed on its entry;
 *      the filter (15.00) as stock used, with a note naming the invoice
 *      (one invoice line can carry one part).
 * 2. INV-000012 (Toyota Avanza, 19 Sep) — oil & filter, 125.00, cash, no
 *    supplier bill in the app: the whole amount is the cost (no VAT claimed
 *    without a tax invoice). Cost of sales — spare parts, filed to the job.
 * 3. INV-000008 (Nissan Patrol, 2 Oct) — outside work, 120.00, cash.
 * 4. INV-000010 (Audi A3, 4 Oct) — outside work, 100.00, cash.
 *    Both: Cost of sales — sublet repairs, no VAT, filed to the job.
 *
 * Safe to run again: anything already recorded is skipped.
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { PERMISSION_CODES } from '@/lib/auth/permission-catalog';
import { recordExpense } from '@/lib/finance/expenses';
import { getJobCost } from '@/lib/finance/job-costing';
import { adjustStock } from '@/lib/inventory/parts';
import { getStockOnHand } from '@/lib/inventory/stock';
import { takeFromStockNow } from '@/lib/inventory/old-part-lines';
import { toFils } from '@/lib/money';

const ORG = '01a0d2e0-cc97-700a-9f8a-6b9834e20c27';
const ACTOR = '01a0d2e1-5041-7561-ba63-05efe9cf5421';
const APPLY = process.argv.includes('--apply');

const MIRAGE = {
  invoice: 'INV-000001',
  line: 'Periodic service, genuine oil & Filter',
  oilPartId: '01a13798-213a-75eb-894f-7f36b284b818',
  filterPartId: '01a13798-9b48-748f-ad2d-98febe02ae05',
  filterNote:
    'Used on INV-000001 (Mitsubishi Mirage, 17 Sep) — the filter of its oil & filter service; Al Amani bill GHCA26-19276 (PO-000022)',
};

const EXPENSES = [
  {
    invoice: 'INV-000012',
    description: 'Engine oil & filter — Toyota Avanza (INV-000012)',
    amount: '125.00',
    date: '2026-09-19',
    account: '5000',
  },
  {
    invoice: 'INV-000008',
    description: 'Outside work (sublet) — Nissan Patrol (INV-000008)',
    amount: '120.00',
    date: '2026-10-02',
    account: '5020',
  },
  {
    invoice: 'INV-000010',
    description: 'Outside work (sublet) — Audi A3 (INV-000010)',
    amount: '100.00',
    date: '2026-10-04',
    account: '5020',
  },
];

async function balances() {
  const rows = await prisma.$queryRaw<{ code: string; balance: string | null }[]>`
    SELECT a.account_code AS code, SUM(l.debit_amount - l.credit_amount)::text AS balance
    FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.chart_of_account_id
    WHERE l.organization_id = ${ORG}::uuid AND a.account_code IN ('1000', '1200', '1300', '5000', '5010', '5020')
    GROUP BY a.account_code`;
  return Object.fromEntries(
    rows.map((row) => {
      const text = row.balance ?? '0';
      return [row.code, text.startsWith('-') ? -toFils(text.slice(1)) : toFils(text)];
    }),
  ) as Record<string, number>;
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
  console.log(`As ${actor.fullName}. ${APPLY ? 'APPLYING.' : 'Check only — nothing will change.'}\n`);
  let problems = 0;
  const invoiceIds = new Map<string, { id: string; branchId: string }>();
  for (const number of [MIRAGE.invoice, ...EXPENSES.map((entry) => entry.invoice)]) {
    const invoice = await prisma.invoice.findFirst({
      where: { organizationId: ORG, invoiceNumber: number, status: { notIn: ['VOID', 'CANCELLED', 'DRAFT'] } },
      select: { id: true, branchId: true },
    });
    if (!invoice) {
      console.log(`${number} NOT FOUND — refused`);
      problems += 1;
    } else invoiceIds.set(number, invoice);
  }

  // 1. The Mirage's oil & filter, out of stock.
  const mirage = invoiceIds.get(MIRAGE.invoice);
  const line = mirage
    ? await prisma.invoiceItem.findFirst({
        where: { organizationId: ORG, invoiceId: mirage.id, description: MIRAGE.line },
        select: { id: true, partId: true, partUsageId: true, itemType: true },
      })
    : null;
  const lineDone = line?.partId === MIRAGE.oilPartId;
  const lineOpen = line && line.itemType === 'PART' && !line.partId && !line.partUsageId;
  const filterDone = await prisma.inventoryTransaction.count({
    where: { organizationId: ORG, partId: MIRAGE.filterPartId, transactionType: 'ADJUSTMENT', note: { contains: 'Used on INV-000001' } },
  });
  if (mirage) {
    const oil = await getStockOnHand(prisma, ORG, mirage.branchId, MIRAGE.oilPartId);
    const filter = await getStockOnHand(prisma, ORG, mirage.branchId, MIRAGE.filterPartId);
    if (lineDone) console.log(`${MIRAGE.invoice} oil: already taken out of stock — skipped`);
    else if (!lineOpen) {
      console.log(`${MIRAGE.invoice} “${MIRAGE.line}” is not an open Parts line — refused`);
      problems += 1;
    } else if (oil < 1000) {
      console.log(`${MIRAGE.invoice} oil: not on the shelf any more (${oil / 1000}) — refused`);
      problems += 1;
    } else console.log(`${MIRAGE.invoice} oil (80.00) → out of stock on the invoice's Parts line`);
    if (filterDone) console.log(`${MIRAGE.invoice} filter: already taken out — skipped`);
    else if (filter < 1000) {
      console.log(`${MIRAGE.invoice} filter: not on the shelf any more (${filter / 1000}) — refused`);
      problems += 1;
    } else console.log(`${MIRAGE.invoice} filter (15.00) → out of stock as used on that job`);
  }

  // 2–4. The costs paid in cash, as expenses filed to their jobs.
  const accounts = new Map(
    (
      await prisma.chartOfAccount.findMany({
        where: { organizationId: ORG, accountCode: { in: ['5000', '5020'] }, isActive: true },
        select: { id: true, accountCode: true },
      })
    ).map((account) => [account.accountCode, account.id]),
  );
  const toRecord: (typeof EXPENSES)[number][] = [];
  for (const entry of EXPENSES) {
    const already = await prisma.expense.count({
      where: { organizationId: ORG, description: entry.description, status: 'RECORDED' },
    });
    if (already) console.log(`${entry.invoice} ${entry.amount}: already recorded — skipped`);
    else if (!accounts.has(entry.account)) {
      console.log(`${entry.invoice}: account ${entry.account} not found — refused`);
      problems += 1;
    } else {
      console.log(`${entry.invoice} ${entry.amount} cash on ${entry.date} → ${entry.account}, filed to the job`);
      toRecord.push(entry);
    }
  }

  if (problems) {
    console.log(`\n${problems} problem(s). Nothing changed — send me this output.`);
    return;
  }
  if (!APPLY) {
    console.log('\nAll checks passed. Run again with --apply to record them.');
    return;
  }

  const before = await balances();
  if (mirage && line && !lineDone) {
    await takeFromStockNow(user, { itemId: line.id, partId: MIRAGE.oilPartId });
    console.log('  done: Mirage oil out of stock');
  }
  if (!filterDone) {
    await adjustStock(user, MIRAGE.filterPartId, {
      direction: 'OUT',
      quantity: '1',
      reason: 'OTHER',
      note: MIRAGE.filterNote,
    });
    console.log('  done: Mirage filter out of stock');
  }
  for (const entry of toRecord) {
    await recordExpense(user, {
      description: entry.description,
      amount: entry.amount,
      taxRate: '',
      expenseDate: entry.date,
      vendorName: 'Cash — no bill',
      paymentMethod: 'CASH',
      categoryId: accounts.get(entry.account),
      forJob: `invoice:${invoiceIds.get(entry.invoice)!.id}`,
      notes: 'From the owners’ sale report (15 Sep – 14 Oct 2026). No tax invoice: no VAT claimed.',
    });
    console.log(`  done: ${entry.invoice} ${entry.amount}`);
  }

  const after = await balances();
  const moved = (code: string) => ((after[code] ?? 0) - (before[code] ?? 0)) / 100;
  console.log('\nBooks moved:');
  console.log(`  1000 Cash on hand            ${moved('1000')}   (expected −345.00 if any cash was recorded)`);
  console.log(`  1200 Inventory               ${moved('1200')}   (expected −95.00)`);
  console.log(`  1300 VAT reclaimable          ${moved('1300')}   (expected 0)`);
  console.log(`  5000 Cost of sales — parts   ${moved('5000')}   (expected +205.00)`);
  console.log(`  5010 Inventory adjustments   ${moved('5010')}   (expected +15.00)`);
  console.log(`  5020 Cost of sales — sublet  ${moved('5020')}   (expected +220.00)`);
  console.log('\nJob profit now:');
  for (const number of [MIRAGE.invoice, ...EXPENSES.map((entry) => entry.invoice)]) {
    const cost = await getJobCost(user, invoiceIds.get(number)!.id);
    if (cost) {
      console.log(
        `  ${number}  sales ${cost.salesFils / 100}  parts ${cost.partsFils / 100}  other ${cost.otherFils / 100}  profit ${cost.profitFils / 100}`,
      );
    }
  }
  console.log('\nDone.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
