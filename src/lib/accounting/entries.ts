import { z } from 'zod';
import { purchaseBillDifferenceFils } from '@/lib/finance/supplier-balance';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput, ValidationError } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { filsToString, toFils } from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { addStandardAccounts, ensureChart } from '@/lib/accounting/chart';
import {
  amendEntry,
  bookEntry,
  deleteEntry,
  postingPending,
  renumberJournal,
  reverseEntry,
  syncPosting,
  whyNotCorrectable,
  type PostedSource,
} from '@/lib/accounting/journal';
import { subLedgerOf } from '@/lib/accounting/sub-ledger';

/*
 * Entries made by hand, and bringing existing records into the books.
 *
 * MANUAL ENTRIES are the accountant's: opening balances, owner's capital and
 * drawings, bank charges, depreciation, moving card takings to the bank, a
 * correction between accounts. Each must balance, use active accounts and
 * fall in an open period. While that period is open an entry can be edited
 * or deleted (the audit log keeps what it said); once it is closed, a
 * mistake is reversed. Narration — the description and line notes — can be
 * corrected on any entry at any time: it moves no figure.
 *
 * BOOKING EXISTING RECORDS runs syncPosting over everything recorded before
 * the books existed, oldest first. It is safe to run any number of times:
 * a record already booked as it stands is left alone.
 */

const MAX_LINES = 50;

const amountText = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || /^\d+(\.\d{1,2})?$/.test(value),
    'Enter an amount like 250 or 250.50.',
  );

const lineSchema = z.object({
  accountId: z.uuid({ error: 'Choose an account for every line.' }),
  debit: amountText.optional(),
  credit: amountText.optional(),
  memo: z.string().trim().max(200).optional(),
  /** On an account kept per customer or supplier: who the line is for. */
  partyId: z.union([z.literal(''), z.uuid()]).optional(),
});

const manualSchema = z.object({
  date: z.string({ error: 'Choose the date.' }).min(1, 'Choose the date.'),
  description: z
    .string({ error: 'Describe the entry.' })
    .trim()
    .min(3, 'Describe the entry.')
    .max(300, 'Keep the description under 300 characters.'),
  lines: z
    .array(lineSchema)
    .min(2, 'An entry needs at least two lines.')
    .max(MAX_LINES, `An entry can have at most ${MAX_LINES} lines.`),
  requestKey: z.string().optional(),
});

type ManualLine = {
  accountId: string;
  debit: number;
  credit: number;
  memo: string | null;
  partyId: string | null;
};

/** A hand-made entry as typed: a valid date, and lines that balance. */
function readManual(rawInput: unknown) {
  const input = parseInput(manualSchema, rawInput);
  const date = parseCalendarDate(input.date);
  if (!date) throw new DomainError('Choose a valid date.', 'date');
  if (input.date > localDateString()) {
    throw new DomainError('An entry can’t be dated in the future.', 'date');
  }

  const errors: Record<string, string> = {};
  const lines: ManualLine[] = input.lines.map((line, index) => {
    const debit = line.debit ? toFils(line.debit) : 0;
    const credit = line.credit ? toFils(line.credit) : 0;
    if ((debit === 0) === (credit === 0)) {
      errors[`lines.${index}`] = `Line ${index + 1}: enter a debit or a credit — one, not both.`;
    }
    return {
      accountId: line.accountId,
      debit,
      credit,
      memo: line.memo || null,
      partyId: line.partyId || null,
    };
  });
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const debits = lines.reduce((sum, line) => sum + line.debit, 0);
  const credits = lines.reduce((sum, line) => sum + line.credit, 0);
  if (debits !== credits) {
    throw new DomainError(
      `The entry does not balance: debits ${filsToString(debits)}, credits ${filsToString(credits)} (difference ${filsToString(Math.abs(debits - credits))}).`,
      'lines',
    );
  }
  return { input, date, lines, debits };
}

/**
 * The lines checked against the chart and the parties: every account this
 * workshop's and active, and a customer or supplier named exactly where the
 * account is kept per party.
 */
async function checkManualLines(
  tx: Prisma.TransactionClient,
  organizationId: string,
  lines: ManualLine[],
) {
  const accounts = await tx.chartOfAccount.findMany({
    where: { organizationId, id: { in: lines.map((line) => line.accountId) } },
    select: { id: true, isActive: true, accountName: true, role: true, subLedger: true },
  });
  const known = new Map(accounts.map((account) => [account.id, account]));
  // The parties named, checked to be this workshop's and still in use.
  const partyIds = [...new Set(lines.map((line) => line.partyId).filter(Boolean))] as string[];
  const [customers, suppliers] = await Promise.all([
    tx.customer.findMany({
      where: { organizationId, id: { in: partyIds }, isActive: true },
      select: { id: true },
    }),
    tx.supplier.findMany({
      where: { organizationId, id: { in: partyIds }, isActive: true },
      select: { id: true },
    }),
  ]);
  const isCustomer = new Set(customers.map((c) => c.id));
  const isSupplier = new Set(suppliers.map((s) => s.id));
  return lines.map((line, index) => {
    const account = known.get(line.accountId);
    if (!account)
      throw new DomainError(`Line ${index + 1}: that account was not found.`, `lines.${index}`);
    if (!account.isActive) {
      throw new DomainError(
        `Line ${index + 1}: “${account.accountName}” is retired. Choose an active account.`,
        `lines.${index}`,
      );
    }
    // An account kept per party names the party; any other names none.
    const kept = subLedgerOf(account);
    const { partyId, ...rest } = line;
    if (kept === 'CUSTOMER') {
      if (!partyId || !isCustomer.has(partyId)) {
        throw new DomainError(
          `Line ${index + 1}: “${account.accountName}” is kept per customer — choose the customer.`,
          `lines.${index}`,
        );
      }
      return { ...rest, customerId: partyId };
    }
    if (kept === 'SUPPLIER') {
      if (!partyId || !isSupplier.has(partyId)) {
        throw new DomainError(
          `Line ${index + 1}: “${account.accountName}” is kept per supplier — choose the supplier.`,
          `lines.${index}`,
        );
      }
      return { ...rest, supplierId: partyId };
    }
    if (partyId) {
      throw new DomainError(
        `Line ${index + 1}: “${account.accountName}” isn't kept per customer or supplier, so no one can be named on it.`,
        `lines.${index}`,
      );
    }
    return rest;
  });
}

type CheckedLine = Awaited<ReturnType<typeof checkManualLines>>[number];

function linesForLog(lines: CheckedLine[]) {
  return lines.map((line) => ({
    accountId: line.accountId,
    debit: filsToString(line.debit),
    credit: filsToString(line.credit),
    customerId: 'customerId' in line ? line.customerId : undefined,
    supplierId: 'supplierId' in line ? line.supplierId : undefined,
  }));
}

/** Books an entry made by hand. */
export async function createManualEntry(user: AuthenticatedUser, rawInput: unknown) {
  requirePermission(user, 'accounting.create');
  const { input, date, lines, debits } = readManual(rawInput);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'journal.create');
    await ensureChart(tx, user.organizationId);
    const booked = await checkManualLines(tx, user.organizationId, lines);

    const created = await bookEntry(tx, {
      organizationId: user.organizationId,
      branchId: null,
      date,
      description: input.description,
      lines: booked,
      sourceType: 'MANUAL',
      sourceId: null,
      actorUserId: user.id,
    });
    // A back-dated entry takes its place in date order: report the number it ends with.
    await renumberJournal(tx, user.organizationId);
    const entry = await tx.journalEntry.findUniqueOrThrow({ where: { id: created.id } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'journal.created',
      entityType: 'JournalEntry',
      entityId: entry.id,
      afterData: {
        entryNumber: entry.entryNumber,
        date: input.date,
        description: input.description,
        total: filsToString(debits),
        lines: linesForLog(booked),
      },
    });
    await settleRequestKey(tx, user, rawInput, entry.id);
    return entry;
  });
}

/** An entry of this workshop's, with what decides whether it may change. */
async function findEntry(tx: Prisma.TransactionClient, user: AuthenticatedUser, entryId: string) {
  const entry = await tx.journalEntry.findFirst({
    where: { id: entryId, organizationId: user.organizationId },
    include: {
      reversals: {
        select: { id: true, organizationId: true, entryDate: true, entryNumber: true },
      },
    },
  });
  if (!entry) throw new NotFoundError('journal entry');
  return entry;
}

/**
 * One entry for its edit screen: its lines, and how far it may change —
 * `figuresLocked` says why its accounts and amounts can't be edited (null
 * when they can); `deletable` whether it can be deleted.
 */
export async function getEntryForEdit(user: AuthenticatedUser, entryId: string) {
  requirePermission(user, 'accounting.edit');
  return prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.findFirst({
      where: { id: entryId, organizationId: user.organizationId },
      include: {
        lines: {
          orderBy: { id: 'asc' },
          include: {
            chartOfAccount: { select: { accountCode: true, accountName: true } },
            customer: { select: { name: true } },
            supplier: { select: { name: true } },
          },
        },
        reversalOf: { select: { entryNumber: true } },
        reversals: {
          select: { id: true, organizationId: true, entryDate: true, entryNumber: true },
        },
      },
    });
    if (!entry) throw new NotFoundError('journal entry');

    const openReason = await whyNotCorrectable(tx, entry);
    let figuresLocked: string | null = openReason;
    if (entry.sourceType !== 'MANUAL') {
      figuresLocked = 'it was booked from a record — change the record and its entry follows';
    } else if (entry.reversalOf) {
      figuresLocked = `it reverses ${entry.reversalOf.entryNumber ?? 'another entry'} — delete it to bring the original back`;
    } else if (entry.reversals.length > 0) {
      figuresLocked = `it has been reversed by ${entry.reversals[0].entryNumber ?? 'another entry'} — delete that reversal first`;
    }
    let deletable = entry.sourceType === 'MANUAL' && openReason === null;
    for (const reversal of entry.reversals) {
      if (deletable && (await whyNotCorrectable(tx, reversal))) deletable = false;
    }
    return { entry, figuresLocked, deletable };
  });
}

const BOOKED_FROM_RECORD =
  'This entry was booked from a record. Change the record itself and its entry follows; its description and line notes can be edited here.';

const correctionSchema = z.object({
  reason: z.string().trim().max(300).optional(),
});

/**
 * Corrects an entry made by hand where it stands — date, description,
 * accounts, amounts, parties — while its period is open. The audit log
 * keeps what it said before. In a closed period it must be reversed instead.
 */
export async function updateManualEntry(
  user: AuthenticatedUser,
  entryId: string,
  rawInput: unknown,
) {
  requirePermission(user, 'accounting.edit');
  const { input, date, lines } = readManual(rawInput);
  const { reason } = parseInput(correctionSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    const entry = await findEntry(tx, user, entryId);
    if (entry.sourceType !== 'MANUAL') throw new DomainError(BOOKED_FROM_RECORD);
    if (entry.reversalOfJournalEntryId) {
      throw new DomainError(
        'This entry reverses another. Delete it to bring the original back, then edit the original.',
      );
    }
    if (entry.reversals.length > 0) {
      throw new DomainError(
        `This entry has been reversed by ${entry.reversals[0].entryNumber ?? 'another entry'}. Delete that reversal first, then edit this entry.`,
      );
    }
    const why = await whyNotCorrectable(tx, entry, date);
    if (why) {
      throw new DomainError(
        `This entry can’t be changed: ${why}. Reverse it and book it again instead.`,
      );
    }
    const booked = await checkManualLines(tx, user.organizationId, lines);
    await amendEntry(tx, entry, {
      date,
      description: input.description,
      lines: booked,
      actorUserId: user.id,
      reason,
    });
    await renumberJournal(tx, user.organizationId);
    return tx.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
  });
}

const deleteSchema = z.object({
  reason: z.string({ error: 'Say why.' }).trim().min(3, 'Say why, in a few words.').max(300),
});

/**
 * Deletes an entry made by hand from an open period; the entries after it
 * move up a number, so the journal has no gap. An entry and its reversal
 * cancel out, so deleting a reversed entry deletes its reversal too, and
 * deleting a reversal alone brings the original back. Each is kept in the
 * audit log.
 */
export async function deleteManualEntry(
  user: AuthenticatedUser,
  entryId: string,
  rawInput: unknown,
) {
  requirePermission(user, 'accounting.delete');
  const { reason } = parseInput(deleteSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    const entry = await findEntry(tx, user, entryId);
    if (entry.sourceType !== 'MANUAL') {
      throw new DomainError(
        'This entry was booked from a record. Void or delete the record itself and its entry goes with it.',
      );
    }
    // The reversals first: each points at the entry it reverses.
    const targets = [...entry.reversals, entry];
    for (const target of targets) {
      const why = await whyNotCorrectable(tx, target);
      if (why) {
        throw new DomainError(
          `${target.entryNumber ?? 'This entry'} can’t be deleted: ${why}. Reverse it instead.`,
        );
      }
    }
    for (const target of targets) {
      if (!(await deleteEntry(tx, target, user.id, reason))) {
        throw new DomainError(
          `${target.entryNumber ?? 'This entry'} is still linked to a record, so it can’t be deleted.`,
        );
      }
    }
    await renumberJournal(tx, user.organizationId);
    return { deleted: targets.length };
  });
}

const narrationSchema = z.object({
  description: z
    .string({ error: 'Describe the entry.' })
    .trim()
    .min(3, 'Describe the entry.')
    .max(300, 'Keep the description under 300 characters.'),
  notes: z
    .array(z.object({ lineId: z.uuid(), memo: z.string().trim().max(200) }))
    .max(MAX_LINES)
    .optional(),
});

/**
 * Corrects an entry's narration — its description and its lines' notes —
 * on any entry, in any period: narration moves no figure. The audit log
 * keeps the old wording.
 */
export async function updateEntryNarration(
  user: AuthenticatedUser,
  entryId: string,
  rawInput: unknown,
) {
  requirePermission(user, 'accounting.edit');
  const input = parseInput(narrationSchema, rawInput);

  return prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.findFirst({
      where: { id: entryId, organizationId: user.organizationId },
      include: { lines: { select: { id: true, description: true } } },
    });
    if (!entry) throw new NotFoundError('journal entry');
    const lineNotes = new Map(entry.lines.map((line) => [line.id, line.description ?? '']));
    const changedNotes = (input.notes ?? []).filter(
      (note) => lineNotes.has(note.lineId) && lineNotes.get(note.lineId) !== note.memo,
    );
    if (entry.description === input.description && changedNotes.length === 0) return entry;

    const updated = await tx.journalEntry.update({
      where: { id: entry.id },
      data: { description: input.description },
    });
    for (const note of changedNotes) {
      await tx.journalEntryLine.update({
        where: { id: note.lineId },
        data: { description: note.memo || null },
      });
    }
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'journal.narration_changed',
      entityType: 'JournalEntry',
      entityId: entry.id,
      beforeData: {
        entryNumber: entry.entryNumber,
        description: entry.description,
        notes: changedNotes.map((note) => ({
          lineId: note.lineId,
          memo: lineNotes.get(note.lineId) || null,
        })),
      },
      afterData: {
        description: input.description,
        notes: changedNotes.map((note) => ({ lineId: note.lineId, memo: note.memo || null })),
      },
    });
    return updated;
  });
}

const reverseSchema = z.object({
  date: z.string({ error: 'Choose the date.' }).min(1, 'Choose the date.'),
  reason: z.string({ error: 'Say why.' }).trim().min(3, 'Say why, in a few words.').max(300),
});

/**
 * Reverses an entry made by hand. Entries booked from a record (an invoice,
 * a payment…) are corrected through that record instead, so the two can
 * never disagree.
 */
export async function reverseManualEntry(
  user: AuthenticatedUser,
  entryId: string,
  rawInput: unknown,
) {
  requirePermission(user, 'accounting.delete');
  const input = parseInput(reverseSchema, rawInput);
  const date = parseCalendarDate(input.date);
  if (!date) throw new DomainError('Choose a valid date.', 'date');

  return prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.findFirst({
      where: { id: entryId, organizationId: user.organizationId },
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
        reversals: { select: { entryNumber: true } },
      },
    });
    if (!entry) throw new NotFoundError('journal entry');
    if (entry.sourceType !== 'MANUAL') {
      throw new DomainError(
        'This entry was booked from a record. Correct or void the record itself and the books follow.',
      );
    }
    if (entry.reversalOfJournalEntryId) throw new DomainError('This entry is itself a reversal.');
    if (entry.reversals.length > 0) {
      throw new DomainError(
        `Already reversed by ${entry.reversals[0].entryNumber ?? 'another entry'}.`,
      );
    }
    if (date.getTime() < entry.entryDate.getTime()) {
      throw new DomainError('A reversal can’t be dated before the entry it reverses.', 'date');
    }
    const reversal = await reverseEntry(tx, entry, date, user.id, input.reason);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'journal.reversed',
      entityType: 'JournalEntry',
      entityId: entry.id,
      afterData: { reversedBy: reversal.entryNumber, date: input.date },
      metadata: { reason: input.reason },
    });
    return reversal;
  });
}

// ─── The standard chart ─────────────────────────────────────────────────────

/**
 * Adds every standard account the workshop doesn't have yet (by code and by
 * name), and the system accounts if any are missing. Never renames or
 * removes an account.
 */
export async function completeStandardChart(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.create');
  return prisma.$transaction(async (tx) => {
    await ensureChart(tx, user.organizationId);
    const added = await addStandardAccounts(tx, user.organizationId);
    if (added > 0) {
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: 'accounts.standard_added',
        entityType: 'Organization',
        entityId: user.organizationId,
        afterData: { added },
      });
    }
    return { added };
  });
}

// ─── Records not yet in the books ───────────────────────────────────────────

/** Stock movements that change the value of stock, and so are booked. */
const VALUED_MOVEMENTS = [
  'PURCHASE_RECEIPT',
  'RETURN_TO_SUPPLIER',
  'OPENING_STOCK',
  'ADJUSTMENT',
  // Cancels an adjustment or opening stock: booked the other way round.
  'REVERSAL',
] as const;

/** Records whose postings are found by source rather than a link on the record. */
const LATER_SOURCES = [
  'CREDIT_NOTE',
  'CREDIT_NOTE_REFUND',
  'FIXED_ASSET',
  'DEPRECIATION',
  'ASSET_DISPOSAL',
  'MONEY_TRANSFER',
  'CUSTOMER_ADVANCE',
  'CUSTOMER_ADVANCE_ALLOCATION',
  'CUSTOMER_ADVANCE_REFUND',
  'INVOICE_DISCOUNT',
  'PURCHASE_ROUNDING',
  'OWNER_MONEY',
  'PURCHASE_BILL',
  'CARD_COLLECTION',
  'PAYMENT_VOUCHER',
  'PRIOR_PERIOD',
  'FINAL_SETTLEMENT',
  'FINAL_SETTLEMENT_PAYMENT',
  'OTHER_INCOME',
] as const;

/** What is waiting to be booked, oldest first, by kind of record. */
async function unbooked(organizationId: string) {
  const [
    invoices,
    payments,
    expenses,
    supplierPayments,
    movements,
    bookedMovements,
    payrolls,
    bookedPayrollPayments,
    vatFilings,
    bookedVat,
    creditNotes,
    assets,
    depreciations,
    bookedOther,
    reimbursements,
    transfers,
    advances,
    allocations,
    advanceRefunds,
    discountedInvoices,
    roundedPurchases,
    ownerMoney,
    billedLater,
    cardCollections,
    priorPeriods,
    settlements,
    otherIncome,
  ] = await Promise.all([
    prisma.invoice.findMany({
      where: {
        organizationId,
        invoiceType: { in: ['TAX_INVOICE', 'OPENING_BALANCE'] },
        status: { notIn: ['DRAFT', 'VOID', 'CANCELLED'] },
        journalEntryId: null,
      },
      orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.payment.findMany({
      where: { organizationId, journalEntryId: null },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.expense.findMany({
      where: { organizationId, status: 'RECORDED', journalEntryId: null },
      orderBy: [{ expenseDate: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.supplierPayment.findMany({
      where: { organizationId, journalEntryId: null },
      orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.inventoryTransaction.findMany({
      where: {
        organizationId,
        transactionType: { in: [...VALUED_MOVEMENTS] },
        unitCost: { not: null },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true },
    }),
    prisma.journalEntry.findMany({
      where: { organizationId, sourceType: 'STOCK_MOVEMENT' },
      select: { sourceId: true },
    }),
    prisma.payroll.findMany({
      where: { organizationId, status: { in: ['APPROVED', 'PAID'] } },
      orderBy: [{ periodEnd: 'asc' }],
      select: { id: true, status: true, journalEntryId: true },
    }),
    prisma.journalEntry.findMany({
      where: { organizationId, sourceType: 'PAYROLL_PAYMENT' },
      select: { sourceId: true },
    }),
    prisma.vatFiling.findMany({
      // Returns filed before these books began are never booked (their VAT
      // is in the opening balances); a later payment is booked when recorded.
      where: { organizationId, outsideBooks: false },
      orderBy: [{ periodTo: 'asc' }],
      select: { id: true, settledOn: true },
    }),
    prisma.journalEntry.findMany({
      where: { organizationId, sourceType: { in: ['VAT_FILING', 'VAT_PAYMENT'] } },
      select: { sourceType: true, sourceId: true },
    }),
    prisma.creditNote.findMany({
      where: { organizationId, status: 'ISSUED' },
      orderBy: [{ issueDate: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, refundedOn: true },
    }),
    prisma.fixedAsset.findMany({
      where: { organizationId },
      orderBy: [{ acquiredOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, status: true },
    }),
    prisma.assetDepreciation.findMany({
      where: { organizationId },
      orderBy: [{ periodEnd: 'asc' }],
      select: { id: true },
    }),
    prisma.journalEntry.findMany({
      where: { organizationId, sourceType: { in: [...LATER_SOURCES] } },
      select: { sourceType: true, sourceId: true },
    }),
    prisma.ownerReimbursement.findMany({
      where: { organizationId, journalEntryId: null },
      orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.moneyTransfer.findMany({
      where: { organizationId, status: 'POSTED' },
      orderBy: [{ transferredOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.customerAdvance.findMany({
      where: { organizationId, status: { not: 'CANCELLED' } },
      orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.customerAdvanceAllocation.findMany({
      where: { organizationId, reversedAt: null },
      orderBy: [{ allocatedOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.customerAdvanceRefund.findMany({
      where: { organizationId, reversedAt: null },
      orderBy: [{ refundedOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.invoice.findMany({
      where: {
        organizationId,
        settlementDiscountOn: { not: null },
        status: { notIn: ['DRAFT', 'VOID', 'CANCELLED'] },
      },
      orderBy: [{ settlementDiscountOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.purchase.findMany({
      where: { organizationId, status: 'RECEIVED', roundingAdjustment: { not: 0 } },
      orderBy: [{ receivedAt: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    prisma.ownerMoney.findMany({
      where: { organizationId, status: 'POSTED' },
      orderBy: [{ movedOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
    // Tax invoices matched after the parts, with VAT to move off "awaiting"
    // or a difference from what was recorded to book.
    prisma.purchase
      .findMany({
        where: {
          organizationId,
          billMatchedByUserId: { not: null },
          billStatus: { in: ['RECEIVED', 'NO_TAX_INVOICE'] },
        },
        orderBy: [{ billReceivedOn: 'asc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          taxAmount: true,
          status: true,
          billStatus: true,
          billMatchedByUserId: true,
          billTotalAmount: true,
          totalAmount: true,
        },
      })
      .then((rows) =>
        rows.filter(
          (row) =>
            (row.taxAmount !== null && row.taxAmount.gt(0)) ||
            purchaseBillDifferenceFils(row) !== 0,
        ),
      ),
    // Card money collected for others on payment vouchers, and paid over.
    prisma.paymentVoucher.findMany({
      where: { organizationId, kind: 'CARD_COLLECTION', status: { not: 'VOID' } },
      orderBy: [{ collectedOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, status: true },
    }),
    // Months' totals from before the books.
    prisma.priorPeriodSummary.findMany({
      where: { organizationId },
      orderBy: [{ periodFrom: 'asc' }],
      select: { id: true },
    }),
    // Final settlements approved or paid.
    prisma.finalSettlement.findMany({
      where: { organizationId, status: { in: ['APPROVED', 'PAID'] } },
      orderBy: [{ terminationDate: 'asc' }],
      select: { id: true, status: true },
    }),
    prisma.otherIncome.findMany({
      where: { organizationId, status: 'POSTED' },
      orderBy: [{ receivedOn: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    }),
  ]);
  const booked = new Set(bookedMovements.map((entry) => entry.sourceId));
  const paidBooked = new Set(bookedPayrollPayments.map((entry) => entry.sourceId));
  const vatBooked = (source: string) =>
    new Set(
      bookedVat.filter((entry) => entry.sourceType === source).map((entry) => entry.sourceId),
    );
  const notBooked = (rows: { id: string }[], source: (typeof LATER_SOURCES)[number]) => {
    const done = new Set(
      bookedOther.filter((entry) => entry.sourceType === source).map((entry) => entry.sourceId),
    );
    return rows.filter((row) => !done.has(row.id)).map((row) => row.id);
  };
  const filedBooked = vatBooked('VAT_FILING');
  const settledBooked = vatBooked('VAT_PAYMENT');
  return {
    INVOICE: invoices.map((row) => row.id),
    PAYMENT: payments.map((row) => row.id),
    EXPENSE: expenses.map((row) => row.id),
    SUPPLIER_PAYMENT: supplierPayments.map((row) => row.id),
    STOCK_MOVEMENT: movements.filter((row) => !booked.has(row.id)).map((row) => row.id),
    PAYROLL: payrolls.filter((run) => !run.journalEntryId).map((run) => run.id),
    PAYROLL_PAYMENT: payrolls
      .filter((run) => run.status === 'PAID' && !paidBooked.has(run.id))
      .map((run) => run.id),
    VAT_FILING: vatFilings.filter((f) => !filedBooked.has(f.id)).map((f) => f.id),
    VAT_PAYMENT: vatFilings.filter((f) => f.settledOn && !settledBooked.has(f.id)).map((f) => f.id),
    CREDIT_NOTE: notBooked(creditNotes, 'CREDIT_NOTE'),
    CREDIT_NOTE_REFUND: notBooked(
      creditNotes.filter((note) => note.refundedOn),
      'CREDIT_NOTE_REFUND',
    ),
    FIXED_ASSET: notBooked(assets, 'FIXED_ASSET'),
    DEPRECIATION: notBooked(depreciations, 'DEPRECIATION'),
    ASSET_DISPOSAL: notBooked(
      assets.filter((asset) => asset.status === 'DISPOSED'),
      'ASSET_DISPOSAL',
    ),
    OWNER_REIMBURSEMENT: reimbursements.map((row) => row.id),
    MONEY_TRANSFER: notBooked(transfers, 'MONEY_TRANSFER'),
    CUSTOMER_ADVANCE: notBooked(advances, 'CUSTOMER_ADVANCE'),
    CUSTOMER_ADVANCE_ALLOCATION: notBooked(allocations, 'CUSTOMER_ADVANCE_ALLOCATION'),
    CUSTOMER_ADVANCE_REFUND: notBooked(advanceRefunds, 'CUSTOMER_ADVANCE_REFUND'),
    INVOICE_DISCOUNT: notBooked(discountedInvoices, 'INVOICE_DISCOUNT'),
    PURCHASE_ROUNDING: notBooked(roundedPurchases, 'PURCHASE_ROUNDING'),
    OWNER_MONEY: notBooked(ownerMoney, 'OWNER_MONEY'),
    PURCHASE_BILL: notBooked(billedLater, 'PURCHASE_BILL'),
    CARD_COLLECTION: notBooked(cardCollections, 'CARD_COLLECTION'),
    PAYMENT_VOUCHER: notBooked(
      cardCollections.filter((voucher) => voucher.status === 'PAID'),
      'PAYMENT_VOUCHER',
    ),
    PRIOR_PERIOD: notBooked(priorPeriods, 'PRIOR_PERIOD'),
    FINAL_SETTLEMENT: notBooked(settlements, 'FINAL_SETTLEMENT'),
    FINAL_SETTLEMENT_PAYMENT: notBooked(
      settlements.filter((row) => row.status === 'PAID'),
      'FINAL_SETTLEMENT_PAYMENT',
    ),
    OTHER_INCOME: notBooked(otherIncome, 'OTHER_INCOME'),
  } satisfies Record<PostedSource, string[]>;
}

/** Past this many, every one is counted as waiting rather than checked. */
const CHECK_LIMIT = 50;

/**
 * How many records are not yet in the books, for the accounting screen.
 * Each is put through the posting rules, so a record with nothing to book
 * (which booking would leave as it is) is never counted. Many waiting is
 * a workshop's first booking: those are counted without the check.
 */
export async function countUnbooked(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  const waiting = Object.entries(await unbooked(user.organizationId)).flatMap(([source, ids]) =>
    ids.map((id) => ({ source: source as PostedSource, id })),
  );
  if (waiting.length === 0 || waiting.length > CHECK_LIMIT) return waiting.length;
  return prisma.$transaction(async (tx) => {
    let count = 0;
    for (const { source, id } of waiting) {
      if (await postingPending(tx, user.organizationId, source, id)) count += 1;
    }
    return count;
  });
}

/**
 * Books everything recorded before the books existed (or missed since),
 * oldest first — stock and invoices before the payments against them. One
 * transaction per record, so a record that can't be booked (dated in a
 * closed period) is reported without undoing the rest.
 */
export async function bookExistingRecords(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.approve');
  const waiting = await unbooked(user.organizationId);
  const order: PostedSource[] = [
    'STOCK_MOVEMENT',
    'INVOICE',
    'PAYMENT',
    'EXPENSE',
    'SUPPLIER_PAYMENT',
    'PAYROLL',
    'PAYROLL_PAYMENT',
    'CREDIT_NOTE',
    'CREDIT_NOTE_REFUND',
    'FIXED_ASSET',
    'DEPRECIATION',
    'ASSET_DISPOSAL',
    'VAT_FILING',
    'VAT_PAYMENT',
    'OWNER_REIMBURSEMENT',
    'MONEY_TRANSFER',
    'CUSTOMER_ADVANCE',
    'CUSTOMER_ADVANCE_ALLOCATION',
    'CUSTOMER_ADVANCE_REFUND',
    'INVOICE_DISCOUNT',
    'PURCHASE_ROUNDING',
    'OWNER_MONEY',
    'PURCHASE_BILL',
    'CARD_COLLECTION',
    'PAYMENT_VOUCHER',
    'PRIOR_PERIOD',
    'FINAL_SETTLEMENT',
    'FINAL_SETTLEMENT_PAYMENT',
    'OTHER_INCOME',
  ];
  let booked = 0;
  const failed: string[] = [];
  for (const source of order) {
    for (const id of waiting[source]) {
      try {
        const changed = await prisma.$transaction((tx) =>
          syncPosting(tx, user.organizationId, source, id, user.id),
        );
        if (changed) booked += 1;
      } catch (error) {
        failed.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  await writeAuditLog(prisma, {
    organizationId: user.organizationId,
    actorUserId: user.id,
    action: 'books.backfilled',
    entityType: 'Organization',
    entityId: user.organizationId,
    afterData: { booked, failed: failed.length },
  });
  return { booked, failed };
}
