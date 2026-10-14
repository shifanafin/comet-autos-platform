import type { Prisma } from '@/generated/prisma/client';
import type { JournalSource } from '@/generated/prisma/enums';
import { allocateDocumentNumber } from '@/lib/numbering';
import { filsToString, toFils } from '@/lib/money';
import { ensureChart, readChart, type RoleAccounts } from '@/lib/accounting/chart';
import { txMemo } from '@/lib/tx-memo';
import { writeAuditLog } from '@/lib/audit';
import { assertBooksOpen, booksClosedThrough } from '@/lib/accounting/periods';
import { POSTING_RULES, type Posting, type PostingLine } from '@/lib/accounting/postings';

/*
 * Booking to the general ledger.
 *
 * Corrections follow the accountant's rule. While an entry's period is open
 * it is corrected where it stands — same number, its lines replaced — and
 * the audit log keeps what it said before. Once the period is closed (a VAT
 * return filed, the year signed off) it can only be reversed: an equal and
 * opposite entry cancels it and a new one books it right. An entry whose
 * lines are ticked off on a bank reconciliation is reversed too, so the
 * reconciliation never loses its lines. The database enforces all of this:
 * it refuses any change made outside this path, any change in a closed
 * period, and any entry whose debits and credits differ.
 *
 * Entry numbers run in date order without gaps: the database renumbers the
 * book as each transaction that adds, removes or re-dates an entry commits
 * (migration 20261103090000).
 *
 * syncPosting() is how every record reaches the books. Called in the same
 * transaction as any change to an invoice, payment, expense, stock movement
 * or supplier payment, it works out the entry the record now calls for
 * (lib/accounting/postings.ts), compares it with what is booked, and — only
 * if they differ — corrects the booked entry (or, in a closed period,
 * reverses it and books the new one). Because it compares rather than
 * assumes, calling it again changes nothing, and it can be run over every
 * record to book what was recorded before the books existed.
 */

type Tx = Prisma.TransactionClient;

/**
 * Sources booked from a record through its posting rule. Manual, opening
 * balance and year-end closing entries are booked directly instead.
 */
export type PostedSource = Exclude<JournalSource, 'MANUAL' | 'OPENING_BALANCE' | 'YEAR_END_CLOSE'>;

interface EntryInput {
  organizationId: string;
  branchId: string | null;
  date: Date;
  description: string;
  lines: PostingLine[];
  sourceType: JournalSource;
  sourceId: string | null;
  reversalOfId?: string;
  actorUserId: string;
  /**
   * Book into a closed period. Only a year-end closing entry (and its
   * reversal) may: it is dated on the last day of the year it closes, which
   * is normally already closed by then.
   */
  allowClosedPeriod?: boolean;
}

/**
 * The next free JV- number. Every booking in the app — an invoice, a
 * receipt, an expense, a stock movement — needs one, so a counter that has
 * fallen behind numbers already in the books (written by an import or a
 * repair outside the normal path) would stop all of them with a duplicate
 * error. If the number handed out is already used, the counter is moved past
 * the highest number in the books and the next one is taken instead.
 */
async function nextEntryNumber(tx: Tx, organizationId: string): Promise<string> {
  const entryNumber = await allocateDocumentNumber(tx, organizationId, null, 'JOURNAL_ENTRY');
  const taken = await tx.journalEntry.findFirst({
    where: { organizationId, entryNumber },
    select: { id: true },
  });
  if (!taken) return entryNumber;

  const prefix = entryNumber.replace(/\d+$/, '');
  const [{ highest }] = await tx.$queryRaw<{ highest: number | null }[]>`
    SELECT max(substring(entry_number FROM ${prefix.length + 1})::int) AS highest
    FROM journal_entries
    WHERE organization_id = ${organizationId}::uuid
      AND entry_number LIKE ${`${prefix}%`}
      AND substring(entry_number FROM ${prefix.length + 1}) ~ '^[0-9]+$'`;
  await tx.$executeRaw`
    UPDATE document_number_sequences
    SET next_number = GREATEST(next_number, ${Number(highest ?? 0) + 1}), updated_at = now()
    WHERE organization_id = ${organizationId}::uuid
      AND document_type = 'JOURNAL_ENTRY'::"DocumentType"
      AND branch_id IS NULL`;
  console.warn(
    `Journal numbering was behind (${entryNumber} already used); moved past ${prefix}${highest}.`,
  );
  return allocateDocumentNumber(tx, organizationId, null, 'JOURNAL_ENTRY');
}

/** An entry's lines, written under it. */
async function writeLines(tx: Tx, organizationId: string, entryId: string, lines: PostingLine[]) {
  await tx.journalEntryLine.createMany({
    data: lines.map((line) => ({
      organizationId,
      journalEntryId: entryId,
      chartOfAccountId: line.accountId,
      debitAmount: filsToString(line.debit),
      creditAmount: filsToString(line.credit),
      description: line.memo ?? null,
      customerId: line.customerId ?? null,
      supplierId: line.supplierId ?? null,
    })),
  });
}

/** Books one entry, numbered JV-…, inside the caller's transaction. */
export async function bookEntry(tx: Tx, input: EntryInput) {
  if (!input.allowClosedPeriod) await assertBooksOpen(tx, input.organizationId, input.date);
  const entryNumber = await nextEntryNumber(tx, input.organizationId);
  const now = new Date();
  const entry = await tx.journalEntry.create({
    data: {
      organizationId: input.organizationId,
      branchId: input.branchId,
      entryNumber,
      entryDate: input.date,
      description: input.description.slice(0, 500),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      reversalOfJournalEntryId: input.reversalOfId ?? null,
      isPosted: true,
      postedAt: now,
      postedByUserId: input.actorUserId,
      createdByUserId: input.actorUserId,
    },
  });
  await writeLines(tx, input.organizationId, entry.id, input.lines);
  return entry;
}

// ─── Corrections in an open period ──────────────────────────────────────────

/**
 * Whether this database corrects entries in place (migration
 * 20261103090000 applied). Until it is, every correction is a reversal, as
 * before — the app never depends on a change the database would refuse.
 */
let amendSupported: boolean | null = null;
async function amendingSupported(tx: Tx): Promise<boolean> {
  if (amendSupported) return true;
  const [row] = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT to_regprocedure('renumber_journal_entries(uuid)') IS NOT NULL AS ok`;
  amendSupported = Boolean(row?.ok);
  return amendSupported;
}

/**
 * Opens this transaction to correcting and deleting entries (the database
 * refuses both otherwise), and takes the numbering lock first — the lock
 * every booking takes — so a correction and a booking never wait on each
 * other's rows.
 */
async function openForCorrection(tx: Tx, organizationId: string) {
  await tx.$queryRaw`
    SELECT id FROM document_number_sequences
    WHERE organization_id = ${organizationId}::uuid
      AND document_type = 'JOURNAL_ENTRY'::"DocumentType"
      AND branch_id IS NULL
    FOR UPDATE`;
  await tx.$queryRaw`SELECT set_config('app.journal_amend', 'on', true)`;
}

/**
 * Numbers the open period in date order now, rather than as the
 * transaction commits — for a screen that shows the number it booked.
 */
export async function renumberJournal(tx: Tx, organizationId: string) {
  if (!(await amendingSupported(tx))) return;
  await tx.$executeRaw`SELECT renumber_journal_entries(${organizationId}::uuid)`;
}

/**
 * Why an entry can no longer be corrected in place, or null when it can:
 * its period (before or after the change) is closed, or a bank
 * reconciliation has ticked off one of its lines.
 */
export async function whyNotCorrectable(
  tx: Tx,
  entry: { id: string; organizationId: string; entryDate: Date },
  newDate: Date = entry.entryDate,
): Promise<string | null> {
  if (!(await amendingSupported(tx))) {
    return 'the database is not yet set up for corrections (migration 20261103090000)';
  }
  const closed = await booksClosedThrough(tx, entry.organizationId);
  if (closed && Math.min(entry.entryDate.getTime(), newDate.getTime()) <= closed.getTime()) {
    return 'its period is closed';
  }
  const reconciled = await tx.reconciledLine.count({
    where: { organizationId: entry.organizationId, line: { journalEntryId: entry.id } },
  });
  if (reconciled > 0) return 'it is ticked off on a bank reconciliation';
  return null;
}

/** An entry's lines in the audit log's words. */
function linesForAudit(
  lines: {
    accountId: string;
    debit: number;
    credit: number;
    customerId?: string | null;
    supplierId?: string | null;
    memo?: string | null;
  }[],
) {
  return lines.map((line) => ({
    accountId: line.accountId,
    debit: filsToString(line.debit),
    credit: filsToString(line.credit),
    customerId: line.customerId ?? undefined,
    supplierId: line.supplierId ?? undefined,
    memo: line.memo ?? undefined,
  }));
}

/** What an entry says now, read for the audit log. */
async function snapshot(tx: Tx, entryId: string) {
  const entry = await tx.journalEntry.findUniqueOrThrow({
    where: { id: entryId },
    include: { lines: true },
  });
  return {
    entryNumber: entry.entryNumber,
    date: entry.entryDate.toISOString().slice(0, 10),
    description: entry.description,
    lines: linesForAudit(
      entry.lines.map((line) => ({
        accountId: line.chartOfAccountId,
        debit: toFils(line.debitAmount.toString()),
        credit: toFils(line.creditAmount.toString()),
        customerId: line.customerId,
        supplierId: line.supplierId,
        memo: line.description,
      })),
    ),
  };
}

/**
 * Corrects an entry where it stands: same entry, same place in the order,
 * its date, description and lines replaced. The caller has checked
 * whyNotCorrectable(); the database checks again. The audit log keeps both
 * versions.
 */
export async function amendEntry(
  tx: Tx,
  entry: { id: string; organizationId: string },
  input: {
    date: Date;
    description: string;
    branchId?: string | null;
    lines: PostingLine[];
    actorUserId: string;
    reason?: string;
  },
) {
  await openForCorrection(tx, entry.organizationId);
  const before = await snapshot(tx, entry.id);
  await tx.journalEntryLine.deleteMany({ where: { journalEntryId: entry.id } });
  const updated = await tx.journalEntry.update({
    where: { id: entry.id },
    data: {
      entryDate: input.date,
      description: input.description.slice(0, 500),
      ...(input.branchId !== undefined ? { branchId: input.branchId } : {}),
      postedAt: new Date(),
      postedByUserId: input.actorUserId,
    },
  });
  await writeLines(tx, entry.organizationId, entry.id, input.lines);
  await writeAuditLog(tx, {
    organizationId: entry.organizationId,
    actorUserId: input.actorUserId,
    action: 'journal.corrected',
    entityType: 'JournalEntry',
    entityId: entry.id,
    beforeData: before,
    afterData: {
      date: input.date.toISOString().slice(0, 10),
      description: input.description,
      lines: linesForAudit(input.lines),
    },
    metadata: input.reason ? { reason: input.reason } : undefined,
  });
  return updated;
}

/** Records still pointing at an entry, other than the one booking it. */
async function stillReferenced(tx: Tx, entryId: string): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT (
      (SELECT count(*) FROM invoices WHERE journal_entry_id = ${entryId}::uuid) +
      (SELECT count(*) FROM payments WHERE journal_entry_id = ${entryId}::uuid) +
      (SELECT count(*) FROM expenses WHERE journal_entry_id = ${entryId}::uuid) +
      (SELECT count(*) FROM supplier_payments WHERE journal_entry_id = ${entryId}::uuid) +
      (SELECT count(*) FROM payrolls WHERE journal_entry_id = ${entryId}::uuid) +
      (SELECT count(*) FROM purchases WHERE journal_entry_id = ${entryId}::uuid) +
      (SELECT count(*) FROM owner_reimbursements WHERE journal_entry_id = ${entryId}::uuid) +
      (SELECT count(*) FROM journal_entries WHERE reversal_of_journal_entry_id = ${entryId}::uuid)
    ) AS n`;
  return Number(row?.n ?? 0) > 0;
}

/**
 * Deletes an entry from an open period, keeping what it said in the audit
 * log; the entries after it move up a number. Returns false (deleting
 * nothing) when a record still points at it.
 */
export async function deleteEntry(
  tx: Tx,
  entry: { id: string; organizationId: string },
  actorUserId: string,
  reason: string,
): Promise<boolean> {
  await openForCorrection(tx, entry.organizationId);
  if (await stillReferenced(tx, entry.id)) return false;
  const before = await snapshot(tx, entry.id);
  await tx.journalEntry.delete({ where: { id: entry.id } });
  await writeAuditLog(tx, {
    organizationId: entry.organizationId,
    actorUserId,
    action: 'journal.deleted',
    entityType: 'JournalEntry',
    entityId: entry.id,
    beforeData: before,
    metadata: { reason },
  });
  return true;
}

/** The entry currently standing for a record: booked, and not since reversed. */
async function standingEntry(
  tx: Tx,
  organizationId: string,
  source: JournalSource,
  sourceId: string,
) {
  return tx.journalEntry.findFirst({
    where: {
      organizationId,
      sourceType: source,
      sourceId,
      reversalOfJournalEntryId: null,
      reversals: { none: {} },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      lines: {
        select: {
          chartOfAccountId: true,
          debitAmount: true,
          creditAmount: true,
          customerId: true,
          supplierId: true,
        },
      },
    },
  });
}

/**
 * Cancels an entry with an equal and opposite one, dated `date`. The original
 * stays on record, linked to its reversal.
 */
export async function reverseEntry(
  tx: Tx,
  entry: {
    id: string;
    organizationId: string;
    branchId: string | null;
    entryNumber: string | null;
    description: string | null;
    sourceType: JournalSource;
    sourceId: string | null;
    lines: {
      chartOfAccountId: string;
      debitAmount: { toString(): string };
      creditAmount: { toString(): string };
      customerId?: string | null;
      supplierId?: string | null;
    }[];
  },
  date: Date,
  actorUserId: string,
  reason: string,
  options: { allowClosedPeriod?: boolean } = {},
) {
  return bookEntry(tx, {
    allowClosedPeriod: options.allowClosedPeriod,
    organizationId: entry.organizationId,
    branchId: entry.branchId,
    date,
    // Not the entry's number: numbers move as the open period is renumbered.
    // The link to the original (reversalOfId) is what names it.
    description: `Reversal — ${reason}: ${entry.description ?? 'entry'}`,
    lines: entry.lines.map((line) => ({
      accountId: line.chartOfAccountId,
      debit: toFils(line.creditAmount.toString()),
      credit: toFils(line.debitAmount.toString()),
      // The same customer or supplier, so their balance is put back too.
      customerId: line.customerId ?? null,
      supplierId: line.supplierId ?? null,
    })),
    sourceType: entry.sourceType,
    sourceId: entry.sourceId,
    reversalOfId: entry.id,
    actorUserId,
  });
}

/** Lines in one comparable form: sorted, as text. */
function signature(date: Date, lines: { accountId: string; debit: number; credit: number }[]) {
  const sorted = [...lines]
    .map((line) => `${line.accountId}:${line.debit}:${line.credit}`)
    .sort()
    .join('|');
  return `${date.toISOString().slice(0, 10)}#${sorted}`;
}

/** Records that point at the entry currently booking them. */
const DOCUMENT_LINK: Partial<
  Record<PostedSource, (tx: Tx, id: string, journalEntryId: string | null) => Promise<unknown>>
> = {
  INVOICE: (tx, id, journalEntryId) =>
    tx.invoice.update({ where: { id }, data: { journalEntryId } }),
  PAYMENT: (tx, id, journalEntryId) =>
    tx.payment.update({ where: { id }, data: { journalEntryId } }),
  EXPENSE: (tx, id, journalEntryId) =>
    tx.expense.update({ where: { id }, data: { journalEntryId } }),
  SUPPLIER_PAYMENT: (tx, id, journalEntryId) =>
    tx.supplierPayment.update({ where: { id }, data: { journalEntryId } }),
  PAYROLL: (tx, id, journalEntryId) =>
    tx.payroll.update({ where: { id }, data: { journalEntryId } }),
  OWNER_REIMBURSEMENT: (tx, id, journalEntryId) =>
    tx.ownerReimbursement.update({ where: { id }, data: { journalEntryId } }),
};

/** The entry a record now calls for, beside the one booked for it. */
async function comparePosting(
  tx: Tx,
  organizationId: string,
  source: PostedSource,
  sourceId: string,
  accounts: RoleAccounts,
) {
  const wanted: Posting | null = await POSTING_RULES[source](
    tx,
    organizationId,
    sourceId,
    accounts,
  );
  const standing = await standingEntry(tx, organizationId, source, sourceId);

  const standingSignature = standing
    ? signature(
        standing.entryDate,
        standing.lines.map((line) => ({
          accountId: line.chartOfAccountId,
          debit: toFils(line.debitAmount.toString()),
          credit: toFils(line.creditAmount.toString()),
        })),
      )
    : null;
  const wantedSignature =
    wanted && wanted.lines.length > 0 ? signature(wanted.date, wanted.lines) : null;
  return { wanted, standing, wantedSignature, changed: standingSignature !== wantedSignature };
}

/**
 * Whether syncPosting would book anything for this record — the same rules,
 * without writing. A record with nothing to book (a zero amount, a movement
 * costed on its job) is not waiting.
 */
export async function postingPending(
  tx: Tx,
  organizationId: string,
  source: PostedSource,
  sourceId: string,
): Promise<boolean> {
  const accounts = await txMemo(tx, `chart-read:${organizationId}`, () =>
    readChart(tx, organizationId),
  );
  // No chart yet: booking sets it up, so everything is waiting.
  if (!accounts) return true;
  return (await comparePosting(tx, organizationId, source, sourceId, accounts)).changed;
}

/**
 * Brings one record's booking up to date: books it if it isn't, corrects it
 * if it changed, removes it if it no longer counts (a void invoice). In a
 * closed period, or once reconciled, the correction or removal is a
 * reversal instead. Returns whether anything was booked.
 */
export async function syncPosting(
  tx: Tx,
  organizationId: string,
  source: PostedSource,
  sourceId: string,
  actorUserId: string,
): Promise<boolean> {
  // One delivery books an entry per line: the chart is read once for them all.
  const accounts = await txMemo(tx, `chart:${organizationId}`, () =>
    ensureChart(tx, organizationId),
  );
  const { wanted, standing, wantedSignature, changed } = await comparePosting(
    tx,
    organizationId,
    source,
    sourceId,
    accounts,
  );
  if (!changed) return false;

  // Open period: correct the entry where it stands, or remove it.
  if (standing && !(await whyNotCorrectable(tx, standing, wanted?.date ?? standing.entryDate))) {
    if (wanted && wantedSignature) {
      await amendEntry(tx, standing, {
        date: wanted.date,
        description: wanted.description,
        branchId: wanted.branchId,
        lines: wanted.lines,
        actorUserId,
      });
      await DOCUMENT_LINK[source]?.(tx, sourceId, standing.id);
      return true;
    }
    await DOCUMENT_LINK[source]?.(tx, sourceId, null);
    if (await deleteEntry(tx, standing, actorUserId, 'The record no longer counts.')) return true;
  }

  if (standing) {
    await reverseEntry(
      tx,
      standing,
      standing.entryDate,
      actorUserId,
      wantedSignature ? 'corrected' : 'no longer counts',
    );
  }
  let booked: { id: string } | null = null;
  if (wanted && wantedSignature) {
    booked = await bookEntry(tx, {
      organizationId,
      branchId: wanted.branchId,
      date: wanted.date,
      description: wanted.description,
      lines: wanted.lines,
      sourceType: source,
      sourceId,
      actorUserId,
    });
  }
  await DOCUMENT_LINK[source]?.(tx, sourceId, booked?.id ?? null);
  return true;
}
