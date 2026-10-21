import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { filsToString, toFils } from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { lineText } from '@/lib/accounting/reports';

/*
 * Bank reconciliation — proving the books' cash, bank and card accounts
 * against the bank's own statement.
 *
 * A reconciliation is for one money account and one statement: its closing
 * date and closing balance. Every booked line on that account up to the
 * statement date that no earlier reconciliation has cleared is listed, and
 * the ones that appear on the statement are ticked:
 *
 *   cleared balance = the previous reconciled statement balance
 *                   + the lines ticked now (debits in, credits out)
 *   difference      = statement balance − cleared balance
 *
 * It can be completed only when the difference is nil. What is left
 * unticked is the timing difference — cheques not yet presented, deposits in
 * transit — and carries to the next reconciliation. Anything on the
 * statement that is not in the books (bank charges, interest) is recorded
 * first, as an expense or a journal entry, and then ticked.
 *
 * Reconciliations follow one another: one in progress per account at a
 * time, each dated after the last completed one, and only the latest
 * completed one can be reopened.
 */

const AMOUNT = /^-?\d+(\.\d{1,2})?$/;

const startSchema = z.object({
  accountId: z.uuid({ error: 'Choose the bank or cash account.' }),
  statementDate: z
    .string({ error: 'Enter the statement date.' })
    .trim()
    .min(1, 'Enter the statement date.'),
  statementBalance: z
    .string({ error: 'Enter the closing balance on the statement.' })
    .trim()
    .regex(AMOUNT, 'Enter the balance like 12500.00, or -250.00 if overdrawn.'),
});

type Tx = Prisma.TransactionClient;

const signedFils = (value: string) =>
  value.startsWith('-') ? -toFils(value.slice(1)) : toFils(value);

const signedString = (fils: number) => (fils < 0 ? `-${filsToString(-fils)}` : filsToString(fils));

/** The statement balance the next reconciliation starts from, and from when. */
export async function lastCompleted(
  tx: Tx | typeof prisma,
  organizationId: string,
  accountId: string,
) {
  return tx.bankReconciliation.findFirst({
    where: { organizationId, accountId, status: 'COMPLETED' },
    orderBy: [{ statementDate: 'desc' }, { completedAt: 'desc' }],
    select: { id: true, statementDate: true, statementBalance: true },
  });
}

/** The money accounts, each with its last reconciliation and any in progress. */
export async function listReconciliationAccounts(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  const accounts = await prisma.chartOfAccount.findMany({
    where: { organizationId: user.organizationId, isPaymentAccount: true },
    orderBy: { accountCode: 'asc' },
    select: {
      id: true,
      accountCode: true,
      accountName: true,
      isActive: true,
      statementColumns: true,
      bankReconciliations: {
        orderBy: [{ statementDate: 'desc' }, { createdAt: 'desc' }],
        take: 12,
        select: {
          id: true,
          statementDate: true,
          statementBalance: true,
          status: true,
          completedAt: true,
        },
      },
    },
  });
  const balances = await prisma.journalEntryLine.groupBy({
    by: ['chartOfAccountId'],
    where: {
      organizationId: user.organizationId,
      chartOfAccountId: { in: accounts.map((account) => account.id) },
    },
    _sum: { debitAmount: true, creditAmount: true },
  });
  const bookBalance = new Map(
    balances.map((row) => [
      row.chartOfAccountId,
      toFils(row._sum.debitAmount?.toString() ?? '0') -
        toFils(row._sum.creditAmount?.toString() ?? '0'),
    ]),
  );
  return accounts.map((account) => ({
    ...account,
    bookBalance: signedString(bookBalance.get(account.id) ?? 0),
    inProgress: account.bankReconciliations.find((r) => r.status === 'IN_PROGRESS') ?? null,
    lastCompleted: account.bankReconciliations.find((r) => r.status === 'COMPLETED') ?? null,
  }));
}

/** Starts reconciling a money account against a statement. */
export async function startReconciliation(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(startSchema, rawInput);
  requirePermission(user, 'accounting.create');
  const statementDate = parseCalendarDate(input.statementDate);
  if (!statementDate) throw new DomainError('Enter the statement date.', 'statementDate');
  if (input.statementDate > localDateString()) {
    throw new DomainError('A statement cannot be dated in the future.', 'statementDate');
  }

  return prisma.$transaction(async (tx) => {
    const account = await lockReconcilableAccount(tx, user.organizationId, input.accountId);
    const previous = await lastCompleted(tx, user.organizationId, account.id);
    if (previous && statementDate <= previous.statementDate) {
      throw new DomainError(
        `${account.accountName} is already reconciled to ${previous.statementDate.toISOString().slice(0, 10)}. Enter a later statement.`,
        'statementDate',
      );
    }
    const reconciliation = await tx.bankReconciliation.create({
      data: {
        organizationId: user.organizationId,
        accountId: account.id,
        statementDate,
        statementBalance: input.statementBalance,
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'bank_reconciliation.started',
      entityType: 'BankReconciliation',
      entityId: reconciliation.id,
      afterData: {
        accountId: account.id,
        statementDate: input.statementDate,
        statementBalance: input.statementBalance,
      },
    });
    return { reconciliationId: reconciliation.id };
  });
}

/**
 * The money account a new reconciliation is for, locked so only one starts
 * at a time, and refused if one is already in progress.
 */
export async function lockReconcilableAccount(tx: Tx, organizationId: string, accountId: string) {
  await tx.$executeRaw`SELECT id FROM chart_of_accounts WHERE id = ${accountId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const account = await tx.chartOfAccount.findFirst({
    where: { id: accountId, organizationId },
    select: { id: true, accountName: true, isPaymentAccount: true },
  });
  if (!account?.isPaymentAccount) {
    throw new DomainError('Choose a cash, bank or card account.', 'accountId');
  }
  const open = await tx.bankReconciliation.findFirst({
    where: { organizationId, accountId: account.id, status: 'IN_PROGRESS' },
    select: { id: true },
  });
  if (open) {
    throw new DomainError(
      `A reconciliation of ${account.accountName} is already in progress. Finish or discard it first.`,
    );
  }
  return account;
}

/**
 * A reconciliation with its lines: everything on the account up to the
 * statement date not cleared by an earlier one, marked if ticked here.
 */
export async function getReconciliation(user: AuthenticatedUser, reconciliationId: string) {
  requirePermission(user, 'accounting.view');
  const organizationId = user.organizationId;
  const reconciliation = await prisma.bankReconciliation.findFirst({
    where: { id: reconciliationId, organizationId },
    include: {
      account: { select: { id: true, accountCode: true, accountName: true } },
      createdBy: { select: { fullName: true } },
      completedBy: { select: { fullName: true } },
      lines: { select: { journalEntryLineId: true } },
    },
  });
  if (!reconciliation) throw new NotFoundError('reconciliation');
  const previous = await prisma.bankReconciliation.findFirst({
    where: {
      organizationId,
      accountId: reconciliation.accountId,
      status: 'COMPLETED',
      statementDate: { lt: reconciliation.statementDate },
    },
    orderBy: [{ statementDate: 'desc' }],
    select: { statementDate: true, statementBalance: true },
  });

  const lines = await prisma.journalEntryLine.findMany({
    where: {
      organizationId,
      chartOfAccountId: reconciliation.accountId,
      journalEntry: { entryDate: { lte: reconciliation.statementDate } },
      OR: [{ reconciled: null }, { reconciled: { reconciliationId: reconciliation.id } }],
    },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }],
    select: {
      id: true,
      debitAmount: true,
      creditAmount: true,
      description: true,
      journalEntry: {
        select: {
          id: true,
          entryNumber: true,
          entryDate: true,
          description: true,
          sourceType: true,
          reversalOfJournalEntryId: true,
          _count: { select: { reversals: true } },
        },
      },
    },
  });
  const ticked = new Set(reconciliation.lines.map((line) => line.journalEntryLineId));
  const openingFils = previous ? signedFils(previous.statementBalance.toString()) : 0;
  let clearedFils = openingFils;
  let unclearedIn = 0;
  let unclearedOut = 0;
  const rows = lines.map((line) => {
    const amount = toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString());
    const isTicked = ticked.has(line.id);
    if (isTicked) clearedFils += amount;
    else if (amount > 0) unclearedIn += amount;
    else unclearedOut -= amount;
    return {
      id: line.id,
      date: line.journalEntry.entryDate.toISOString().slice(0, 10),
      entryNumber: line.journalEntry.entryNumber,
      description: lineText(line.description, line.journalEntry.description),
      sourceType: line.journalEntry.sourceType,
      /** Money in (a debit to the account) or out. */
      moneyIn: amount > 0 ? filsToString(amount) : '',
      moneyOut: amount < 0 ? filsToString(-amount) : '',
      /** A reversed entry and its reversal cancel out: tick both, or neither. */
      reversed:
        Boolean(line.journalEntry.reversalOfJournalEntryId) ||
        line.journalEntry._count.reversals > 0,
      ticked: isTicked,
    };
  });
  const statementFils = signedFils(reconciliation.statementBalance.toString());
  const bookFils = await prisma.journalEntryLine
    .aggregate({
      where: {
        organizationId,
        chartOfAccountId: reconciliation.accountId,
        journalEntry: { entryDate: { lte: reconciliation.statementDate } },
      },
      _sum: { debitAmount: true, creditAmount: true },
    })
    .then(
      (sum) =>
        toFils(sum._sum.debitAmount?.toString() ?? '0') -
        toFils(sum._sum.creditAmount?.toString() ?? '0'),
    );

  return {
    id: reconciliation.id,
    status: reconciliation.status,
    account: reconciliation.account,
    statementDate: reconciliation.statementDate.toISOString().slice(0, 10),
    statementBalance: signedString(statementFils),
    previousDate: previous?.statementDate.toISOString().slice(0, 10) ?? null,
    openingBalance: signedString(openingFils),
    clearedBalance: signedString(clearedFils),
    difference: signedString(statementFils - clearedFils),
    differenceFils: statementFils - clearedFils,
    /** The books' balance on the statement date, and what explains the gap to the statement. */
    bookBalance: signedString(bookFils),
    depositsInTransit: filsToString(unclearedIn),
    outstandingPayments: filsToString(unclearedOut),
    createdBy: reconciliation.createdBy.fullName,
    completedBy: reconciliation.completedBy?.fullName ?? null,
    completedAt: reconciliation.completedAt,
    /** The uploaded statement's file, when one was uploaded. */
    statementFileName: reconciliation.statementFileName,
    statementOpening:
      reconciliation.statementOpening === null
        ? null
        : signedString(signedFils(reconciliation.statementOpening.toString())),
    /** Changes whenever the ticks do, so the sheet starts again from them. */
    tickVersion: `${ticked.size}:${checksum([...ticked].sort().join(','))}`,
    rows,
  };
}

/** A short fingerprint of a string. */
function checksum(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export type ReconciliationDetail = Awaited<ReturnType<typeof getReconciliation>>;

export async function lockOpen(tx: Tx, organizationId: string, reconciliationId: string) {
  await tx.$executeRaw`SELECT id FROM bank_reconciliations WHERE id = ${reconciliationId}::uuid AND organization_id = ${organizationId}::uuid FOR UPDATE`;
  const reconciliation = await tx.bankReconciliation.findFirst({
    where: { id: reconciliationId, organizationId },
    select: { id: true, accountId: true, statementDate: true, status: true },
  });
  if (!reconciliation) throw new NotFoundError('reconciliation');
  if (reconciliation.status !== 'IN_PROGRESS') {
    throw new DomainError('This reconciliation is completed. Reopen it to change it.');
  }
  return reconciliation;
}

const tickSchema = z.object({
  lineIds: z.array(z.uuid()).max(2000),
  ticked: z.boolean(),
});

/** Ticks (or unticks) lines as appearing on the statement. */
export async function setReconciledLines(
  user: AuthenticatedUser,
  reconciliationId: string,
  rawInput: unknown,
) {
  const input = parseInput(tickSchema, rawInput);
  requirePermission(user, 'accounting.edit');
  return prisma.$transaction(async (tx) => {
    const reconciliation = await lockOpen(tx, user.organizationId, reconciliationId);
    if (!input.ticked) {
      await tx.reconciledLine.deleteMany({
        where: {
          organizationId: user.organizationId,
          reconciliationId: reconciliation.id,
          journalEntryLineId: { in: input.lineIds },
        },
      });
      return { changed: input.lineIds.length };
    }
    const lines = await tx.journalEntryLine.findMany({
      where: {
        id: { in: input.lineIds },
        organizationId: user.organizationId,
        chartOfAccountId: reconciliation.accountId,
        journalEntry: { entryDate: { lte: reconciliation.statementDate } },
        reconciled: null,
      },
      select: { id: true },
    });
    await tx.reconciledLine.createMany({
      data: lines.map((line) => ({
        organizationId: user.organizationId,
        reconciliationId: reconciliation.id,
        journalEntryLineId: line.id,
      })),
      skipDuplicates: true,
    });
    return { changed: lines.length };
  });
}

/** Completes a reconciliation whose cleared balance agrees with the statement. */
export async function completeReconciliation(user: AuthenticatedUser, reconciliationId: string) {
  requirePermission(user, 'accounting.approve');
  const detail = await getReconciliation(user, reconciliationId);
  if (detail.status !== 'IN_PROGRESS') throw new DomainError('This reconciliation is completed.');
  if (detail.differenceFils !== 0) {
    throw new DomainError(
      `The ticked lines leave a difference of ${detail.difference} against the statement. Tick what is on the statement, or record what is missing from the books first.`,
    );
  }
  return prisma.$transaction(async (tx) => {
    await lockOpen(tx, user.organizationId, reconciliationId);
    await tx.bankReconciliation.update({
      where: { id: reconciliationId },
      data: { status: 'COMPLETED', completedAt: new Date(), completedByUserId: user.id },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'bank_reconciliation.completed',
      entityType: 'BankReconciliation',
      entityId: reconciliationId,
      afterData: {
        statementDate: detail.statementDate,
        statementBalance: detail.statementBalance,
        linesCleared: detail.rows.filter((row) => row.ticked).length,
      },
    });
    return { reconciliationId };
  });
}

/** Reopens the latest completed reconciliation of an account, to correct it. */
export async function reopenReconciliation(user: AuthenticatedUser, reconciliationId: string) {
  requirePermission(user, 'accounting.approve');
  return prisma.$transaction(async (tx) => {
    const reconciliation = await tx.bankReconciliation.findFirst({
      where: { id: reconciliationId, organizationId: user.organizationId },
      select: { id: true, accountId: true, status: true },
    });
    if (!reconciliation) throw new NotFoundError('reconciliation');
    if (reconciliation.status !== 'COMPLETED') throw new DomainError('It is still in progress.');
    const latest = await lastCompleted(tx, user.organizationId, reconciliation.accountId);
    if (latest?.id !== reconciliation.id) {
      throw new DomainError(
        'Only the latest completed reconciliation of an account can be reopened.',
      );
    }
    const open = await tx.bankReconciliation.findFirst({
      where: {
        organizationId: user.organizationId,
        accountId: reconciliation.accountId,
        status: 'IN_PROGRESS',
      },
      select: { id: true },
    });
    if (open) throw new DomainError('Discard the reconciliation in progress first.');
    await tx.bankReconciliation.update({
      where: { id: reconciliation.id },
      data: { status: 'IN_PROGRESS', completedAt: null, completedByUserId: null },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'bank_reconciliation.reopened',
      entityType: 'BankReconciliation',
      entityId: reconciliation.id,
    });
    return { reconciliationId: reconciliation.id };
  });
}

/** Discards a reconciliation in progress, ticks and all. The books are untouched. */
export async function discardReconciliation(user: AuthenticatedUser, reconciliationId: string) {
  requirePermission(user, 'accounting.delete');
  return prisma.$transaction(async (tx) => {
    const reconciliation = await lockOpen(tx, user.organizationId, reconciliationId);
    await tx.reconciledLine.deleteMany({
      where: { organizationId: user.organizationId, reconciliationId: reconciliation.id },
    });
    await tx.bankReconciliation.delete({ where: { id: reconciliation.id } });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'bank_reconciliation.discarded',
      entityType: 'BankReconciliation',
      entityId: reconciliation.id,
    });
    return { accountId: reconciliation.accountId };
  });
}
