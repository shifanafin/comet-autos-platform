import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { formatCalendarDate, localDateString, parseCalendarDate } from '@/lib/format';
import { toFils } from '@/lib/money';
import { booksClosedThrough } from '@/lib/accounting/periods';
import {
  amendEntry,
  renumberJournal,
  syncPosting,
  whyNotCorrectable,
  type PostedSource,
} from '@/lib/accounting/journal';

/*
 * Changing the date of a journal entry.
 *
 * An entry booked from a record (an invoice, a payment, an expense…) is
 * dated by that record: change only the entry and the next booking of the
 * record would put it back. So its date is changed ON THE RECORD — the
 * invoice's issue date, the payment's date — and the entry follows by the
 * record's own rule (corrected where it stands). An entry made by hand is
 * re-dated directly. Either way the audit log keeps the old date and why.
 *
 * Refused, whichever kind:
 *   - a closed period, before or after the change (books closed through);
 *   - a period whose VAT return is filed — the return was made from these
 *     dates (a filed return is corrected by a credit note or the next
 *     return's adjustment, never by moving documents under it);
 *   - before the books began (the opening balance date), or in the future;
 *   - an entry ticked off on a bank reconciliation;
 *   - an entry that reverses another, or has been reversed.
 */

type Tx = Prisma.TransactionClient;

interface Redatable {
  /** What the record is, for messages: "invoice INV-000012". */
  load: (tx: Tx, organizationId: string, id: string) => Promise<{ what: string; date: Date } | null>;
  /** Writes the new date; may refuse with a reason. */
  write: (tx: Tx, organizationId: string, id: string, day: string, date: Date) => Promise<void>;
}

/** A timestamp record (a payment) moved to a day: midday in Dubai, so the day never slips. */
const midday = (day: string) => new Date(`${day}T12:00:00+04:00`);
const dayOf = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai' }).format(date);

const RECORDS: Partial<Record<PostedSource, Redatable>> = {
  INVOICE: {
    load: async (tx, organizationId, id) => {
      const row = await tx.invoice.findFirst({
        where: { id, organizationId },
        select: { invoiceNumber: true, issueDate: true, invoiceType: true },
      });
      if (!row) return null;
      if (row.invoiceType === 'OPENING_BALANCE') {
        throw new DomainError('An opening balance is dated on the Opening balances screen.');
      }
      return { what: `invoice ${row.invoiceNumber}`, date: row.issueDate };
    },
    write: async (tx, organizationId, id, day, date) => {
      const row = await tx.invoice.findFirstOrThrow({
        where: { id, organizationId },
        select: { dueDate: true, creditNotes: { where: { status: 'ISSUED' }, select: { issueDate: true } } },
      });
      if (row.creditNotes.some((note) => note.issueDate.getTime() < date.getTime())) {
        throw new DomainError('A credit note against this invoice is dated before that day.');
      }
      await tx.invoice.update({
        where: { id },
        // Due no earlier than issued.
        data: { issueDate: date, ...(row.dueDate && dayOf(row.dueDate) < day ? { dueDate: date } : {}) },
      });
    },
  },
  CREDIT_NOTE: {
    load: async (tx, organizationId, id) => {
      const row = await tx.creditNote.findFirst({
        where: { id, organizationId },
        select: { creditNoteNumber: true, issueDate: true },
      });
      return row ? { what: `credit note ${row.creditNoteNumber}`, date: row.issueDate } : null;
    },
    write: async (tx, organizationId, id, _day, date) => {
      const row = await tx.creditNote.findFirstOrThrow({
        where: { id, organizationId },
        select: { invoice: { select: { invoiceNumber: true, issueDate: true } } },
      });
      if (date.getTime() < row.invoice.issueDate.getTime()) {
        throw new DomainError(`A credit note can’t be dated before its invoice, ${row.invoice.invoiceNumber}.`);
      }
      await tx.creditNote.update({ where: { id }, data: { issueDate: date } });
    },
  },
  PAYMENT: {
    load: async (tx, organizationId, id) => {
      const row = await tx.payment.findFirst({
        where: { id, organizationId },
        select: { paymentNumber: true, receivedAt: true },
      });
      return row
        ? { what: `payment ${row.paymentNumber ?? ''}`.trim(), date: parseCalendarDate(dayOf(row.receivedAt))! }
        : null;
    },
    write: async (tx, _organizationId, id, day) => {
      await tx.payment.update({ where: { id }, data: { receivedAt: midday(day) } });
    },
  },
  SUPPLIER_PAYMENT: {
    load: async (tx, organizationId, id) => {
      const row = await tx.supplierPayment.findFirst({
        where: { id, organizationId },
        select: { supplierPaymentNumber: true, paidAt: true },
      });
      return row
        ? { what: `supplier payment ${row.supplierPaymentNumber ?? ''}`.trim(), date: parseCalendarDate(dayOf(row.paidAt))! }
        : null;
    },
    write: async (tx, _organizationId, id, day) => {
      await tx.supplierPayment.update({ where: { id }, data: { paidAt: midday(day) } });
    },
  },
  EXPENSE: {
    load: async (tx, organizationId, id) => {
      const row = await tx.expense.findFirst({
        where: { id, organizationId },
        select: { expenseNumber: true, expenseDate: true },
      });
      return row ? { what: `expense ${row.expenseNumber ?? ''}`.trim(), date: row.expenseDate } : null;
    },
    write: async (tx, _organizationId, id, _day, date) => {
      await tx.expense.update({ where: { id }, data: { expenseDate: date } });
    },
  },
  MONEY_TRANSFER: {
    load: async (tx, organizationId, id) => {
      const row = await tx.moneyTransfer.findFirst({
        where: { id, organizationId },
        select: { transferNumber: true, transferredOn: true },
      });
      return row ? { what: `transfer ${row.transferNumber}`, date: row.transferredOn } : null;
    },
    write: async (tx, _organizationId, id, _day, date) => {
      await tx.moneyTransfer.update({ where: { id }, data: { transferredOn: date } });
    },
  },
  OWNER_MONEY: {
    load: async (tx, organizationId, id) => {
      const row = await tx.ownerMoney.findFirst({
        where: { id, organizationId },
        select: { entryNumber: true, movedOn: true },
      });
      return row ? { what: `owner's money ${row.entryNumber}`, date: row.movedOn } : null;
    },
    write: async (tx, _organizationId, id, _day, date) => {
      await tx.ownerMoney.update({ where: { id }, data: { movedOn: date } });
    },
  },
  OTHER_INCOME: {
    load: async (tx, organizationId, id) => {
      const row = await tx.otherIncome.findFirst({
        where: { id, organizationId },
        select: { incomeNumber: true, receivedOn: true },
      });
      return row ? { what: `income receipt ${row.incomeNumber}`, date: row.receivedOn } : null;
    },
    write: async (tx, _organizationId, id, _day, date) => {
      await tx.otherIncome.update({ where: { id }, data: { receivedOn: date } });
    },
  },
  CUSTOMER_ADVANCE: {
    load: async (tx, organizationId, id) => {
      const row = await tx.customerAdvance.findFirst({
        where: { id, organizationId },
        select: { advanceNumber: true, receivedOn: true },
      });
      return row ? { what: `advance ${row.advanceNumber}`, date: row.receivedOn } : null;
    },
    write: async (tx, organizationId, id, _day, date) => {
      const used = await tx.customerAdvanceAllocation.findFirst({
        where: { organizationId, advanceId: id, reversedAt: null, allocatedOn: { lt: date } },
        select: { id: true },
      });
      const refunded = await tx.customerAdvanceRefund.findFirst({
        where: { organizationId, advanceId: id, reversedAt: null, refundedOn: { lt: date } },
        select: { id: true },
      });
      if (used || refunded) {
        throw new DomainError('The advance was already applied or refunded before that day.');
      }
      await tx.customerAdvance.update({ where: { id }, data: { receivedOn: date } });
    },
  },
};

const schema = z.object({
  date: z.string({ error: 'Choose the new date.' }).trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the new date.'),
  reason: z
    .string({ error: 'Say why the date changes.' })
    .trim()
    .min(3, 'Say why the date changes, in a few words.')
    .max(300, 'Keep the reason under 300 characters.'),
  requestKey: z.string().optional(),
});

/** Whether an entry's date can be changed here, and if not, why — for the screen. */
export async function entryDateChange(user: AuthenticatedUser, entryId: string) {
  requirePermission(user, 'accounting.view');
  return prisma.$transaction(async (tx) => {
    const entry = await loadEntry(tx, user.organizationId, entryId);
    try {
      const record = await recordOf(tx, entry);
      const why = await refusal(tx, user.organizationId, entry, record.date);
      return { possible: !why, why, what: record.what };
    } catch (error) {
      if (error instanceof DomainError) return { possible: false, why: error.message, what: null };
      throw error;
    }
  });
}

async function loadEntry(tx: Tx, organizationId: string, entryId: string) {
  const entry = await tx.journalEntry.findFirst({
    where: { id: entryId, organizationId },
    include: {
      lines: true,
      reversals: { select: { id: true } },
    },
  });
  if (!entry) throw new NotFoundError('journal entry');
  return entry;
}

type LoadedEntry = Awaited<ReturnType<typeof loadEntry>>;

/** The record an entry follows, with its date — or the entry itself when made by hand. */
async function recordOf(tx: Tx, entry: LoadedEntry) {
  if (entry.reversalOfJournalEntryId) {
    throw new DomainError('This entry reverses another, so it keeps that entry’s date. Change the original instead.');
  }
  if (entry.reversals.length) {
    throw new DomainError('This entry has been reversed, so its date stays. Book a new entry if needed.');
  }
  if (entry.sourceType === 'MANUAL') return { what: `entry ${entry.entryNumber ?? ''}`.trim(), date: entry.entryDate };
  if (entry.sourceType === 'OPENING_BALANCE') {
    throw new DomainError('The opening balances are dated on the day the books begin — set on the Opening balances screen.');
  }
  if (entry.sourceType === 'YEAR_END_CLOSE') {
    throw new DomainError('The year-end close is dated on the last day of the year it closes.');
  }
  const handler = RECORDS[entry.sourceType as PostedSource];
  if (!handler || !entry.sourceId) {
    throw new DomainError(
      entry.sourceType === 'STOCK_MOVEMENT'
        ? 'A stock movement is dated the day the stock moved. Correct the purchase, the job or the stock count it came from.'
        : 'This entry follows its record’s own dates (payroll, depreciation, a VAT return and the like). Change it on its record.',
    );
  }
  const record = await handler.load(tx, entry.organizationId, entry.sourceId);
  if (!record) throw new DomainError('The record this entry was booked from is no longer there.');
  return record;
}

/** Why moving from `from` (and, when given, to `to`) is refused, or null. */
async function refusal(tx: Tx, organizationId: string, entry: LoadedEntry, from: Date, to?: Date) {
  const days = to ? [from, to] : [from];
  const closed = await booksClosedThrough(tx, organizationId);
  if (closed && days.some((date) => date.getTime() <= closed.getTime())) {
    return `the books are closed through ${formatCalendarDate(closed)}`;
  }
  const filed = await tx.vatFiling.findFirst({
    where: {
      organizationId,
      OR: days.map((date) => ({ periodFrom: { lte: date }, periodTo: { gte: date } })),
    },
    select: { periodFrom: true, periodTo: true },
  });
  if (filed) {
    return `the VAT return for ${formatCalendarDate(filed.periodFrom)} – ${formatCalendarDate(filed.periodTo)} is filed`;
  }
  const why = await whyNotCorrectable(tx, entry, to ?? from);
  return why;
}

/**
 * Changes the date of a journal entry — through its record when it was
 * booked from one — within the rules above. Returns the record's
 * description and the old and new dates.
 */
export async function changeEntryDate(user: AuthenticatedUser, entryId: string, rawInput: unknown) {
  requirePermission(user, 'accounting.edit');
  const input = parseInput(schema, rawInput);
  const date = parseCalendarDate(input.date);
  if (!date) throw new DomainError('Choose the new date.', 'date');
  if (input.date > localDateString()) throw new DomainError('The date can’t be in the future.', 'date');

  return prisma.$transaction(
    async (tx) => {
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: user.organizationId },
        select: { openingBalanceDate: true },
      });
      if (organization.openingBalanceDate && date.getTime() < organization.openingBalanceDate.getTime()) {
        throw new DomainError(
          `The books begin on ${formatCalendarDate(organization.openingBalanceDate)}: nothing can be dated before.`,
          'date',
        );
      }
      const entry = await loadEntry(tx, user.organizationId, entryId);
      const record = await recordOf(tx, entry);
      if (dayOf(record.date) === input.date && dayOf(entry.entryDate) === input.date) {
        throw new DomainError('It is already dated that day.', 'date');
      }
      const why = await refusal(tx, user.organizationId, entry, record.date, date);
      if (why) throw new DomainError(`The date can’t be changed: ${why}.`, 'date');

      if (entry.sourceType === 'MANUAL') {
        await amendEntry(tx, entry, {
          date,
          description: entry.description ?? '',
          lines: entry.lines.map((line) => ({
            accountId: line.chartOfAccountId,
            debit: toFils(line.debitAmount.toString()),
            credit: toFils(line.creditAmount.toString()),
            customerId: line.customerId,
            supplierId: line.supplierId,
            memo: line.description,
          })),
          actorUserId: user.id,
          reason: input.reason,
        });
      } else {
        const source = entry.sourceType as PostedSource;
        await RECORDS[source]!.write(tx, user.organizationId, entry.sourceId!, input.date, date);
        // The entry follows its record, by the record's own rule.
        await syncPosting(tx, user.organizationId, source, entry.sourceId!, user.id);
      }
      await renumberJournal(tx, user.organizationId);
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'journal.date_changed',
        entityType: 'JournalEntry',
        entityId: entry.id,
        beforeData: { date: dayOf(record.date), entryDate: dayOf(entry.entryDate) },
        afterData: { date: input.date },
        metadata: { record: record.what, source: entry.sourceType, reason: input.reason },
      });
      return { what: record.what, from: dayOf(record.date), to: input.date };
    },
    { timeout: 30_000 },
  );
}
