/*
 * ONE-OFF — do not commit. Re-books INV-000007 (Manzoor) by the app's own rule.
 *
 * Its parts (engine oil, oil filter, A/C filter: 130.00 at cost) were taken
 * out of stock on 6 Oct 2026 as "historical job consumption", each with its
 * own entry crediting Inventory (JV-000216/217/218). The invoice's entry,
 * JV-000269, was later re-booked and costed the same parts again
 * (Dr Cost of sales 130.00 / Cr Inventory 130.00). So the parts are costed
 * twice: Inventory reads −130.01 while nothing is in stock.
 *
 * The invoice rule now skips parts whose fitting carries its own entry. This
 * runs syncPosting for the invoice — the same call every invoice change
 * makes — which REVERSES JV-000269 (nothing is edited or deleted) and books
 * it again without the second cost: receivables 195.00, VAT 9.25, sales
 * 185.00, round-off 0.75, dated 1 Oct 2026.
 *
 *   npx tsx prisma/fix-inv-000007.ts           dry run: shows, then rolls back
 *   npx tsx prisma/fix-inv-000007.ts --apply   books it
 *
 * Refuses unless the invoice's entry is as found on 11 Oct 2026, and rolls
 * back unless the Inventory account then agrees with the stock ledger (to
 * the 0.01 of rounding already there).
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma';
import { syncPosting } from '@/lib/accounting/journal';
import { writeAuditLog } from '@/lib/audit';

const ORG = '01a0d2e0-cc97-700a-9f8a-6b9834e20c27';
const INVOICE = '01a0f6b9-92ab-73c0-b42b-25bd58032f9c';
const ACTOR = '01a0d2e1-5041-7561-ba63-05efe9cf5421';
const APPLY = process.argv.includes('--apply');

class DryRun extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const fils = (value: { toString(): string } | null) =>
  Math.round(Number(value?.toString() ?? 0) * 100);

/** The Inventory account (debit − credit) and the stock ledger's value, in fils. */
async function inventory(tx: Tx) {
  const [account] = await tx.$queryRaw<{ balance: string | null }[]>`
    SELECT SUM(l.debit_amount - l.credit_amount)::text AS balance
    FROM journal_entry_lines l JOIN chart_of_accounts a ON a.id = l.chart_of_account_id
    WHERE l.organization_id = ${ORG}::uuid AND a.role = 'INVENTORY'`;
  const [stock] = await tx.$queryRaw<{ value: string | null }[]>`
    SELECT ROUND(SUM(quantity * unit_cost), 2)::text AS value
    FROM inventory_transactions WHERE organization_id = ${ORG}::uuid`;
  return { account: fils(account.balance), stock: fils(stock.value) };
}

async function invoiceEntries(tx: Tx) {
  const rows = await tx.journalEntry.findMany({
    where: { organizationId: ORG, sourceType: 'INVOICE', sourceId: INVOICE },
    orderBy: { createdAt: 'asc' },
    include: { lines: { include: { chartOfAccount: true } } },
  });
  return rows.map((entry) => ({
    number: entry.entryNumber,
    date: entry.entryDate.toISOString().slice(0, 10),
    reversalOf: entry.reversalOfJournalEntryId,
    lines: entry.lines.map((line) => ({
      account: `${line.chartOfAccount.accountCode} ${line.chartOfAccount.accountName}`,
      role: line.chartOfAccount.role,
      debit: line.debitAmount.toFixed(2),
      credit: line.creditAmount.toFixed(2),
    })),
  }));
}

function show(title: string, list: Awaited<ReturnType<typeof invoiceEntries>>) {
  console.log(`\n${title}`);
  for (const entry of list) {
    console.log(`  ${entry.number} ${entry.date}${entry.reversalOf ? ' (reversal)' : ''}`);
    for (const line of entry.lines) {
      console.log(
        `    ${line.account.padEnd(40)} ${line.debit.padStart(10)} ${line.credit.padStart(10)}`,
      );
    }
  }
}

async function main() {
  try {
    await prisma.$transaction(
      async (tx) => {
        const before = await invoiceEntries(tx);
        show('INV-000007 entries now', before);
        const standing = before.filter((entry) => !entry.reversalOf);
        const inventoryCredit = standing
          .flatMap((entry) => entry.lines)
          .filter((line) => line.role === 'INVENTORY')
          .reduce((sum, line) => sum + fils(line.credit) - fils(line.debit), 0);
        if (standing.length !== 1 || inventoryCredit !== 13000) {
          throw new Error(
            `Not as found on 11 Oct 2026 (standing entries ${standing.length}, inventory credit ${inventoryCredit / 100}). Nothing changed.`,
          );
        }
        const was = await inventory(tx);
        console.log(`\nInventory account ${was.account / 100} · stock ledger ${was.stock / 100}`);

        await syncPosting(tx, ORG, 'INVOICE', INVOICE, ACTOR);

        const after = await invoiceEntries(tx);
        show('INV-000007 entries after', after);
        const now = await inventory(tx);
        console.log(`\nInventory account ${now.account / 100} · stock ledger ${now.stock / 100}`);
        if (Math.abs(now.account - now.stock) > 1) {
          throw new Error(
            'The Inventory account still disagrees with the stock ledger. Rolled back.',
          );
        }
        await writeAuditLog(tx, {
          organizationId: ORG,
          actorUserId: ACTOR,
          action: 'invoice.rebooked',
          entityType: 'Invoice',
          entityId: INVOICE,
          beforeData: { inventoryCredit: '130.00' },
          afterData: { inventoryCredit: '0.00' },
          metadata: {
            reason:
              'Parts already costed by their own historical job consumption entries (JV-000216/217/218); the invoice costed them a second time.',
          },
        });
        if (!APPLY) throw new DryRun();
      },
      { timeout: 60_000 },
    );
    console.log('\nBooked.');
  } catch (error) {
    if (error instanceof DryRun)
      console.log('\nDry run — rolled back. Run with --apply to book it.');
    else throw error;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
