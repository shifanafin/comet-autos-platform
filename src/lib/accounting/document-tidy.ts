import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { booksClosedThrough } from '@/lib/accounting/periods';

/*
 * Removing voided internal records, so the internal series run 1, 2, 3…
 * (the owners' rule, 21 Oct 2026; migration 20261107090000).
 *
 * Only the workshop's own paperwork — payment vouchers, expenses, money
 * transfers, owner's money — never what a customer or the FTA holds:
 * invoices, receipts, credit notes and advances are never removed.
 *
 * A record goes only when it is void, nothing is booked from it any more,
 * nothing is attached to it, its month is open, and anything pointing at it
 * goes with it (a voucher's expense). A full copy of each is written to the
 * audit log first; the audit log itself is never touched. Then each series
 * it leaves a gap in is renumbered in its order (close_document_number_gaps),
 * the journal's narrations and the records' notes following the new numbers.
 */

type Tx = Prisma.TransactionClient;

/** In removal order: a voucher before the expense it pays. */
const KINDS = [
  {
    type: 'PAYMENT_VOUCHER',
    table: 'payment_vouchers',
    number: 'voucher_number',
    date: 'COALESCE(paid_on, collected_on, created_at::date)',
    entity: 'PaymentVoucher',
  },
  {
    type: 'EXPENSE_VOUCHER',
    table: 'expenses',
    number: 'expense_number',
    date: 'expense_date',
    entity: 'Expense',
  },
  {
    type: 'MONEY_TRANSFER',
    table: 'money_transfers',
    number: 'transfer_number',
    date: 'transferred_on',
    entity: 'MoneyTransfer',
  },
  {
    type: 'OWNER_MONEY',
    table: 'owner_money',
    number: 'entry_number',
    date: 'moved_on',
    entity: 'OwnerMoney',
  },
] as const;

/** Where a record's number may be quoted in words, besides the journal. */
const NOTE_COLUMNS = [
  ['expenses', 'notes'],
  ['payment_vouchers', 'notes'],
  ['money_transfers', 'notes'],
  ['owner_money', 'notes'],
  ['purchases', 'notes'],
] as const;

interface Found {
  kind: (typeof KINDS)[number];
  id: string;
  number: string;
  day: string;
  row: Prisma.JsonValue;
  why: string | null;
}

/** Every voided internal record, and why any of them can't go. */
async function findVoided(client: Tx | typeof prisma, organizationId: string): Promise<Found[]> {
  const closed = await booksClosedThrough(client, organizationId);
  const found: Found[] = [];
  for (const kind of KINDS) {
    const rows = await client.$queryRaw<
      {
        id: string;
        number: string;
        day: string;
        row: Prisma.JsonValue;
        entries: number;
        documents: number;
        kept_by: number;
      }[]
    >`
      SELECT t.id, t.${Prisma.raw(kind.number)} AS number,
             to_char(${Prisma.raw(kind.date)}, 'YYYY-MM-DD') AS day,
             row_to_json(t) AS row,
             (SELECT COUNT(*)::int FROM journal_entries j
               WHERE j.organization_id = t.organization_id AND j.source_id = t.id) AS entries,
             (SELECT COUNT(*)::int FROM documents d WHERE d.entity_id = t.id) AS documents,
             ${
               kind.table === 'expenses'
                 ? Prisma.sql`(SELECT COUNT(*)::int FROM payment_vouchers v
                     WHERE v.expense_id = t.id AND v.status <> 'VOID')`
                 : Prisma.sql`0`
             } AS kept_by
      FROM ${Prisma.raw(kind.table)} t
      WHERE t.organization_id = ${organizationId}::uuid AND t.status = 'VOID'
      ORDER BY t.${Prisma.raw(kind.number)}`;
    for (const row of rows) {
      const why =
        row.entries > 0
          ? 'still has a journal entry'
          : row.documents > 0
            ? 'has a document attached'
            : row.kept_by > 0
              ? 'is paid on a voucher that stands'
              : closed && row.day <= closed.toISOString().slice(0, 10)
                ? 'is in a closed month'
                : null;
      found.push({ kind, id: row.id, number: row.number, day: row.day, row: row.row, why });
    }
  }
  return found;
}

/** What would be removed, and what stays and why — reads only. */
export async function previewVoidedRemoval(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.approve');
  const found = await findVoided(prisma, user.organizationId);
  return {
    removable: found.filter((row) => !row.why).map(({ number, day }) => ({ number, day })),
    kept: found.filter((row) => row.why).map(({ number, why }) => ({ number, why: why! })),
  };
}

/**
 * Removes every voided internal record that may go, then closes the gaps in
 * their series. One transaction: all of it, or none.
 */
export async function removeVoidedInternalRecords(user: AuthenticatedUser, reason: string) {
  requirePermission(user, 'accounting.approve');
  if (reason.trim().length < 3) throw new Error('Say why, in a few words.');
  return prisma.$transaction(
    async (tx) => {
      const found = (await findVoided(tx, user.organizationId)).filter((row) => !row.why);
      if (found.length === 0) return { removed: [], renumbered: [] };

      // The delete locks let these rows go for this transaction only.
      await tx.$executeRaw`SELECT set_config('app.document_tidy', 'on', true)`;
      for (const record of found) {
        await writeAuditLog(tx, {
          organizationId: user.organizationId,
          actorUserId: user.id,
          action: 'document.removed',
          entityType: record.kind.entity,
          entityId: record.id,
          beforeData: record.row,
          metadata: { number: record.number, reason },
        });
        const removed = await tx.$executeRaw`
          DELETE FROM ${Prisma.raw(record.kind.table)}
          WHERE id = ${record.id}::uuid AND organization_id = ${user.organizationId}::uuid AND status = 'VOID'`;
        if (removed !== 1) throw new Error(`${record.number} changed meanwhile — nothing removed.`);
      }
      await tx.$executeRaw`SELECT set_config('app.document_tidy', 'off', true)`;

      // A note that named a removed record no longer points at a number another will take.
      for (const record of found) {
        for (const [table, column] of NOTE_COLUMNS) {
          await tx.$executeRaw`
            UPDATE ${Prisma.raw(table)}
            SET ${Prisma.raw(column)} = replace(${Prisma.raw(column)}, ${record.number}, 'a voided entry since removed')
            WHERE organization_id = ${user.organizationId}::uuid AND ${Prisma.raw(column)} LIKE ${`%${record.number}%`}`;
        }
      }

      const renumbered: { old: string; new: string }[] = [];
      for (const type of [...new Set(found.map((record) => record.kind.type))]) {
        renumbered.push(...(await closeSeries(tx, user, type, reason)));
      }
      return { removed: found.map((record) => record.number), renumbered };
    },
    { timeout: 120_000 },
  );
}

/** Renumbered 1, 2, 3… in their order: the workshop's own paperwork. */
const INTERNAL_SERIES = [
  'EXPENSE_VOUCHER',
  'PAYMENT_VOUCHER',
  'MONEY_TRANSFER',
  'OWNER_MONEY',
  'PURCHASE_ORDER',
  'SUPPLIER_PAYMENT',
] as const;

/** Never renumbered — customers hold them — only the next number kept right after the last. */
const CUSTOMER_SERIES = [
  'TAX_INVOICE',
  'PAYMENT_RECEIPT',
  'CREDIT_NOTE',
  'CUSTOMER_ADVANCE',
  'ESTIMATE',
  'JOB_CARD',
] as const;

/**
 * Closes one series (close_document_number_gaps): an internal one renumbered
 * in its order, a customer one only its counter set. Notes quoting an old
 * number follow it, lowest first, as the journal's narrations do.
 */
async function closeSeries(tx: Tx, user: AuthenticatedUser, type: string, reason: string) {
  const [{ changes }] = await tx.$queryRaw<{ changes: { old: string; new: string }[] }[]>`
    SELECT close_document_number_gaps(${user.organizationId}::uuid, ${type}::"DocumentType") AS changes`;
  for (const change of changes) {
    for (const [table, column] of NOTE_COLUMNS) {
      await tx.$executeRaw`
        UPDATE ${Prisma.raw(table)}
        SET ${Prisma.raw(column)} = replace(${Prisma.raw(column)}, ${change.old}, ${change.new})
        WHERE organization_id = ${user.organizationId}::uuid AND ${Prisma.raw(column)} LIKE ${`%${change.old}%`}`;
    }
  }
  if (changes.length) {
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'document.numbers_closed',
      entityType: 'DocumentNumberSequence',
      entityId: user.organizationId,
      metadata: { series: type, changes, reason },
    });
  }
  return changes;
}

/** The numbers missing from each series, and whether its next number is right — reads only. */
export async function numberGaps(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.approve');
  return prisma.$queryRaw<
    {
      series: string;
      prefix: string;
      next_number: number;
      records: number;
      highest: number | null;
    }[]
  >`
    SELECT s.document_type::text AS series, s.prefix, s.next_number,
           COUNT(DISTINCT n.num)::int AS records, MAX(n.num)::int AS highest
    FROM document_number_sequences s
    LEFT JOIN LATERAL (
      SELECT substring(x.number FROM '^[^0-9]*([0-9]+)')::int AS num FROM (
        SELECT expense_number AS number FROM expenses WHERE organization_id = s.organization_id AND s.document_type = 'EXPENSE_VOUCHER'
        UNION ALL SELECT voucher_number FROM payment_vouchers WHERE organization_id = s.organization_id AND s.document_type = 'PAYMENT_VOUCHER'
        UNION ALL SELECT transfer_number FROM money_transfers WHERE organization_id = s.organization_id AND s.document_type = 'MONEY_TRANSFER'
        UNION ALL SELECT entry_number FROM owner_money WHERE organization_id = s.organization_id AND s.document_type = 'OWNER_MONEY'
        UNION ALL SELECT purchase_number FROM purchases WHERE organization_id = s.organization_id AND s.document_type = 'PURCHASE_ORDER'
        UNION ALL SELECT supplier_payment_number FROM supplier_payments WHERE organization_id = s.organization_id AND s.document_type = 'SUPPLIER_PAYMENT'
        UNION ALL SELECT invoice_number FROM invoices WHERE organization_id = s.organization_id AND s.document_type = 'TAX_INVOICE'
        UNION ALL SELECT payment_number FROM payments WHERE organization_id = s.organization_id AND s.document_type = 'PAYMENT_RECEIPT'
        UNION ALL SELECT credit_note_number FROM credit_notes WHERE organization_id = s.organization_id AND s.document_type = 'CREDIT_NOTE'
        UNION ALL SELECT advance_number FROM customer_advances WHERE organization_id = s.organization_id AND s.document_type = 'CUSTOMER_ADVANCE'
        UNION ALL SELECT job_number FROM job_cards WHERE organization_id = s.organization_id AND s.document_type = 'JOB_CARD'
        UNION ALL SELECT estimate_number FROM estimates WHERE organization_id = s.organization_id AND s.document_type = 'ESTIMATE'
      ) x WHERE x.number IS NOT NULL
    ) n ON true
    WHERE s.organization_id = ${user.organizationId}::uuid
      AND s.document_type::text IN (${Prisma.join([...INTERNAL_SERIES, ...CUSTOMER_SERIES])})
    GROUP BY s.document_type, s.prefix, s.next_number
    ORDER BY 1`;
}

/**
 * Closes every gap: the internal series renumbered 1, 2, 3…, every series'
 * next number set right after its last. One transaction: all of it, or none.
 */
export async function closeNumberGaps(user: AuthenticatedUser, reason: string) {
  requirePermission(user, 'accounting.approve');
  if (reason.trim().length < 3) throw new Error('Say why, in a few words.');
  return prisma.$transaction(
    async (tx) => {
      const renumbered: { old: string; new: string }[] = [];
      for (const type of [...INTERNAL_SERIES, ...CUSTOMER_SERIES]) {
        renumbered.push(...(await closeSeries(tx, user, type, reason)));
      }
      return { renumbered };
    },
    { timeout: 120_000 },
  );
}
