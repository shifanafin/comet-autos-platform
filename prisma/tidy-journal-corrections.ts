/*
 * ONE-OFF — do not commit. Tidies the journal of MOHAMMED MOWLA AUTO GARAGE LLC.
 *
 * Before migration 20261103090000, every change to a booked record — an
 * expense re-filed to "Cost of sales — sublet repairs", an invoice whose
 * old part lines were costed — left three entries: the original, its
 * reversal, and the corrected entry. Under the new rule a correction in an
 * open period changes the entry where it stands. This brings the existing
 * book into line with that rule: each pair of "original + its reversal"
 * that a record correction left behind is removed, leaving only the
 * corrected entry — exactly what the book would hold had it been entered
 * right first time. Then the book is renumbered JV-000001, 2, 3… in date
 * order, with no gaps.
 *
 * Every balance stays exactly as it is: an entry and its reversal cancel
 * out. The script checks that, per account and per customer/supplier, and
 * rolls back on any difference. What each removed entry said is kept in the
 * audit log (journal.deleted), as an auditor would expect.
 *
 * Only pairs that are safe are touched: booked from a record (never one you
 * entered by hand), both dated in an open period, nothing ticked off on a
 * bank reconciliation, and no record still pointing at either.
 *
 *   npx tsx prisma/tidy-journal-corrections.ts           dry run: shows, then rolls back
 *   npx tsx prisma/tidy-journal-corrections.ts --apply   removes them and renumbers
 *
 * Needs migration 20261103090000_journal_corrections_in_place applied first.
 */
import 'dotenv/config';
import { prisma } from '@/lib/prisma';
import { writeAuditLog } from '@/lib/audit';

const ORG = '01a0d2e0-cc97-700a-9f8a-6b9834e20c27';
const ORG_NAME = 'MOHAMMED MOWLA AUTO GARAGE LLC';
/** afin (garage@gmail.com), the workshop's owner login: named in the audit log. */
const ACTOR = '01a0d2e1-5041-7561-ba63-05efe9cf5421';
const APPLY = process.argv.includes('--apply');
const REASON =
  'Journal tidy: a correction in an open period had been booked as a reversal plus a new entry. The entry and its reversal cancel out and were removed; the corrected entry stands.';

class DryRun extends Error {}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/** Net debit per account and party, in fils, as text keys. */
async function balances(tx: Tx) {
  const rows = await tx.$queryRaw<{ key: string; net: string }[]>`
    SELECT l.chart_of_account_id::text || '|' || coalesce(l.customer_id::text, '') || '|' ||
           coalesce(l.supplier_id::text, '') AS key,
           sum(l.debit_amount - l.credit_amount)::text AS net
    FROM journal_entry_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    WHERE e.organization_id = ${ORG}::uuid
    GROUP BY 1`;
  return new Map(rows.filter((r) => Number(r.net) !== 0).map((r) => [r.key, r.net]));
}

interface Pair {
  reversal_id: string;
  reversal_no: string;
  original_id: string;
  original_no: string;
  source_type: string;
  entry_date: string;
  description: string;
  standing_no: string | null;
}

/** Original + reversal pairs a record correction left, safe to remove. */
async function findPairs(tx: Tx) {
  return tx.$queryRaw<Pair[]>`
    SELECT r.id::text AS reversal_id, r.entry_number AS reversal_no,
           o.id::text AS original_id, o.entry_number AS original_no,
           o.source_type::text AS source_type, o.entry_date::text AS entry_date,
           coalesce(o.description, '') AS description,
           (SELECT n.entry_number FROM journal_entries n
             WHERE n.organization_id = o.organization_id AND n.source_type = o.source_type
               AND n.source_id = o.source_id AND n.reversal_of_journal_entry_id IS NULL
               AND n.id <> o.id AND NOT EXISTS (
                 SELECT 1 FROM journal_entries x WHERE x.reversal_of_journal_entry_id = n.id)
             ORDER BY n.created_at DESC LIMIT 1) AS standing_no
    FROM journal_entries r
    JOIN journal_entries o ON o.id = r.reversal_of_journal_entry_id
    JOIN organizations org ON org.id = r.organization_id
    WHERE r.organization_id = ${ORG}::uuid
      AND o.source_type <> 'MANUAL'
      AND r.source_type = o.source_type AND r.source_id IS NOT DISTINCT FROM o.source_id
      AND (org.books_closed_through IS NULL
           OR (o.entry_date > org.books_closed_through AND r.entry_date > org.books_closed_through))
      -- the reversal is the original's only one, and is itself never reversed
      AND NOT EXISTS (SELECT 1 FROM journal_entries x
                       WHERE x.reversal_of_journal_entry_id = o.id AND x.id <> r.id)
      AND NOT EXISTS (SELECT 1 FROM journal_entries x WHERE x.reversal_of_journal_entry_id = r.id)
      -- nothing reconciled
      AND NOT EXISTS (SELECT 1 FROM reconciled_lines rl
                        JOIN journal_entry_lines l ON l.id = rl.journal_entry_line_id
                       WHERE l.journal_entry_id IN (o.id, r.id))
      -- no record points at either
      AND NOT EXISTS (SELECT 1 FROM invoices d WHERE d.journal_entry_id IN (o.id, r.id))
      AND NOT EXISTS (SELECT 1 FROM payments d WHERE d.journal_entry_id IN (o.id, r.id))
      AND NOT EXISTS (SELECT 1 FROM expenses d WHERE d.journal_entry_id IN (o.id, r.id))
      AND NOT EXISTS (SELECT 1 FROM supplier_payments d WHERE d.journal_entry_id IN (o.id, r.id))
      AND NOT EXISTS (SELECT 1 FROM payrolls d WHERE d.journal_entry_id IN (o.id, r.id))
      AND NOT EXISTS (SELECT 1 FROM purchases d WHERE d.journal_entry_id IN (o.id, r.id))
      AND NOT EXISTS (SELECT 1 FROM owner_reimbursements d WHERE d.journal_entry_id IN (o.id, r.id))
    ORDER BY o.entry_date, o.created_at`;
}

/** What an entry said, for the audit log. */
async function snapshot(tx: Tx, id: string) {
  const entry = await tx.journalEntry.findUniqueOrThrow({
    where: { id },
    include: { lines: { include: { chartOfAccount: true } } },
  });
  return {
    entryNumber: entry.entryNumber,
    date: entry.entryDate.toISOString().slice(0, 10),
    description: entry.description,
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    reversalOf: entry.reversalOfJournalEntryId,
    lines: entry.lines.map((line) => ({
      account: `${line.chartOfAccount.accountCode} ${line.chartOfAccount.accountName}`,
      debit: line.debitAmount.toFixed(2),
      credit: line.creditAmount.toFixed(2),
      customerId: line.customerId ?? undefined,
      supplierId: line.supplierId ?? undefined,
      memo: line.description ?? undefined,
    })),
  };
}

async function main() {
  console.log(APPLY ? 'APPLYING' : 'DRY RUN — nothing will be saved');
  await prisma.$transaction(
    async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({ where: { id: ORG } });
      if (org.name !== ORG_NAME) throw new Error(`Unexpected organization: ${org.name}`);
      const [ready] = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT to_regprocedure('renumber_journal_entries(uuid)') IS NOT NULL AS ok`;
      if (!ready?.ok) {
        throw new Error('Apply migration 20261103090000_journal_corrections_in_place first.');
      }

      // The numbering lock every booking takes, then the deliberate path.
      await tx.$queryRaw`
        SELECT id FROM document_number_sequences
        WHERE organization_id = ${ORG}::uuid AND document_type = 'JOURNAL_ENTRY'::"DocumentType"
          AND branch_id IS NULL
        FOR UPDATE`;
      await tx.$queryRaw`SELECT set_config('app.journal_amend', 'on', true)`;

      const before = await balances(tx);
      const countBefore = await tx.journalEntry.count({ where: { organizationId: ORG } });
      const pairs = await findPairs(tx);

      console.log(
        `\n${countBefore} entries in the book. ${pairs.length} correction pair(s) to remove:\n`,
      );
      for (const pair of pairs) {
        console.log(
          `  ${pair.original_no} (${pair.entry_date}, ${pair.source_type}) + its reversal ${pair.reversal_no}` +
            ` — the corrected entry ${pair.standing_no ?? '(none: the record no longer counts)'} stands` +
            `\n      ${pair.description}`,
        );
      }
      if (pairs.length === 0) {
        console.log('  Nothing to remove.');
      }

      for (const pair of pairs) {
        for (const id of [pair.reversal_id, pair.original_id]) {
          const said = await snapshot(tx, id);
          await tx.journalEntry.delete({ where: { id } });
          await writeAuditLog(tx, {
            organizationId: ORG,
            actorUserId: ACTOR,
            action: 'journal.deleted',
            entityType: 'JournalEntry',
            entityId: id,
            beforeData: said,
            metadata: { reason: REASON, script: 'prisma/tidy-journal-corrections.ts' },
          });
        }
      }

      // Numbered 1, 2, 3… in date order, no gaps.
      const numbersBefore = new Map(
        (
          await tx.journalEntry.findMany({
            where: { organizationId: ORG },
            select: { id: true, entryNumber: true },
          })
        ).map((entry) => [entry.id, entry.entryNumber]),
      );
      await tx.$executeRaw`SELECT renumber_journal_entries(${ORG}::uuid)`;
      const ordered = await tx.journalEntry.findMany({
        where: { organizationId: ORG },
        orderBy: [{ entryDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, entryNumber: true, entryDate: true, description: true },
      });
      ordered.forEach((entry, index) => {
        const wanted = `JV-${String(index + 1).padStart(6, '0')}`;
        if (entry.entryNumber !== wanted) {
          throw new Error(`Numbering check failed: ${entry.entryNumber} should be ${wanted}.`);
        }
      });

      // Nothing moved.
      const after = await balances(tx);
      const keys = new Set([...before.keys(), ...after.keys()]);
      for (const key of keys) {
        if (before.get(key) !== after.get(key)) {
          throw new Error(`Balance changed for ${key}: ${before.get(key)} → ${after.get(key)}`);
        }
      }
      if (ordered.length !== countBefore - pairs.length * 2) {
        throw new Error(
          `Expected ${countBefore - pairs.length * 2} entries, found ${ordered.length}.`,
        );
      }
      const [counter] = await tx.$queryRaw<{ next_number: number }[]>`
        SELECT next_number FROM document_number_sequences
        WHERE organization_id = ${ORG}::uuid AND document_type = 'JOURNAL_ENTRY'::"DocumentType"
          AND branch_id IS NULL`;

      const moved = ordered.filter((entry) => numbersBefore.get(entry.id) !== entry.entryNumber);
      console.log(
        `\nAfter: ${ordered.length} entries, JV-000001 to ${ordered.at(-1)?.entryNumber}, in date order, no gaps.`,
      );
      console.log(`Next number: JV-${String(counter.next_number).padStart(6, '0')}.`);
      console.log(`${moved.length} entries take a new number. The first and last ten:`);
      for (const entry of [...ordered.slice(0, 10), ...ordered.slice(-10)]) {
        console.log(
          `  ${entry.entryNumber}  ${entry.entryDate.toISOString().slice(0, 10)}  (was ${numbersBefore.get(entry.id)})  ${entry.description?.slice(0, 60) ?? ''}`,
        );
      }
      console.log('\nEvery balance, per account and per customer/supplier: unchanged.');

      if (!APPLY) throw new DryRun();
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  console.log('\nDone: saved.');
}

main()
  .catch((error) => {
    if (error instanceof DryRun) {
      console.log('\nDry run: rolled back. Run again with --apply to save.');
      return;
    }
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
