import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { filsToString, toFils } from '@/lib/money';
import { formatCalendarDate, localDateString, parseCalendarDate } from '@/lib/format';
import { lastCompleted, lockOpen, lockReconcilableAccount } from '@/lib/accounting/reconciliation';
import { readStatement, statementColumnsSchema } from '@/lib/accounting/statement-file';
import { matchLines, type MatchLine } from '@/lib/accounting/statement-match';

/*
 * Reconciling from an uploaded statement.
 *
 * The statement downloaded from online banking is read (lib/accounting/
 * statement-file.ts) and kept line by line on a new reconciliation. Each
 * statement line is then matched to the book lines it clears, and matching
 * ticks them — the same ticks a person makes by hand, so the cleared balance,
 * the difference and completing work exactly as before:
 *
 *  - lines the statement repeats from the last reconciled one are left out;
 *  - the first upload of an account starts from the statement's opening
 *    balance: the book lines before the statement are cleared by it, when
 *    they come to that balance;
 *  - an entry and its reversal cancel out and never reach the bank: they are
 *    ticked together;
 *  - a statement line is matched to a book line of the same amount close in
 *    date (lib/accounting/statement-match.ts); a person confirms the rest,
 *    or matches one statement line to several book lines;
 *  - a statement line with nothing in the books (a bank charge, interest) is
 *    recorded first, then matched.
 */

type Tx = Prisma.TransactionClient;

const AMOUNT = /^-?\d+(\.\d{1,2})?$/;
const signedFils = (value: string) =>
  value.startsWith('-') ? -toFils(value.slice(1)) : toFils(value);
const signedString = (fils: number) => (fils < 0 ? `-${filsToString(-fils)}` : filsToString(fils));
const decimalFils = (value: { toString(): string }) => signedFils(value.toString());

/** A statement is a few thousand lines at most; a file far past that is not one. */
const MAX_ROWS = 5000;

const uploadSchema = z.object({
  accountId: z.uuid({ error: 'Choose the bank or card account.' }),
  fileName: z.string().trim().max(200).default(''),
  grid: z
    .array(z.array(z.string().max(1000)).max(80))
    .min(1, 'The file is empty.')
    .max(MAX_ROWS, `A statement can have at most ${MAX_ROWS} rows. Upload it a month at a time.`),
  columns: statementColumnsSchema,
  /** Left blank: the last line's date, and the file's own closing balance. */
  statementDate: z.string().trim().optional(),
  statementBalance: z
    .string()
    .trim()
    .refine((value) => value === '' || AMOUNT.test(value), 'Enter the balance like 12500.00.')
    .optional(),
});

const rowLabel = (row: number) => (row > 0 ? `Row ${row}` : 'The file');

/**
 * Reads an uploaded statement onto a new reconciliation, remembers how the
 * account's files are read, and ticks every sure match.
 */
export async function uploadStatement(user: AuthenticatedUser, rawInput: unknown) {
  requirePermission(user, 'accounting.create');
  const input = parseInput(uploadSchema, rawInput);
  const read = readStatement(input.grid, input.columns);
  if (read.problems.length > 0) {
    const shown = read.problems
      .slice(0, 3)
      .map((problem) => `${rowLabel(problem.row)}: ${problem.message}`)
      .join('; ');
    const more = read.problems.length > 3 ? ` (and ${read.problems.length - 3} more)` : '';
    throw new DomainError(`Some lines can’t be read — ${shown}${more}. Check the columns chosen.`);
  }
  if (read.lines.length === 0) {
    throw new DomainError('No lines with a date and an amount were found in the file.');
  }

  return prisma.$transaction(async (tx) => {
    const organizationId = user.organizationId;
    const account = await lockReconcilableAccount(tx, organizationId, input.accountId);
    const previous = await lastCompleted(tx, organizationId, account.id);
    const after = previous?.statementDate.toISOString().slice(0, 10) ?? null;

    // A download overlapping the last reconciled statement repeats lines.
    const lines = after ? read.lines.filter((line) => line.date > after) : read.lines;
    const repeated = read.lines.length - lines.length;
    if (lines.length === 0) {
      throw new DomainError(
        `Every line in this file is on or before ${formatCalendarDate(after!)}, which is already reconciled. Download the statement from the day after.`,
      );
    }
    const lastLine = lines[lines.length - 1].date;
    const dateText = input.statementDate || lastLine;
    const statementDate = parseCalendarDate(dateText);
    if (!statementDate) throw new DomainError('Enter the statement date.', 'statementDate');
    if (dateText > localDateString()) {
      throw new DomainError('A statement cannot be dated in the future.', 'statementDate');
    }
    if (dateText < lastLine) {
      throw new DomainError(
        `The file has lines up to ${formatCalendarDate(lastLine)}: the statement date can't be earlier.`,
        'statementDate',
      );
    }

    // The balance before the first line kept, when the file shows balances.
    const first = lines[0];
    const opening =
      first.balanceFils !== null
        ? first.balanceFils - first.amountFils
        : repeated === 0
          ? read.openingFils
          : null;
    const movement = lines.reduce((sum, line) => sum + line.amountFils, 0);
    const closing = input.statementBalance
      ? signedFils(input.statementBalance)
      : read.closingFils !== null
        ? read.closingFils
        : opening !== null
          ? opening + movement
          : null;
    if (closing === null) {
      throw new DomainError(
        'This file shows no balance. Enter the closing balance from the statement.',
        'statementBalance',
      );
    }

    // What doesn't add up is shown on the reconciliation (statementChecks).
    const reconciliation = await tx.bankReconciliation.create({
      data: {
        organizationId,
        accountId: account.id,
        statementDate,
        statementBalance: signedString(closing),
        statementOpening: opening === null ? null : signedString(opening),
        statementFileName: input.fileName || null,
        createdByUserId: user.id,
      },
      select: { id: true },
    });

    // The first reconciliation of an account starts from the statement's
    // opening balance: it stands for everything before the statement.
    const broughtForward = !previous && opening !== null && opening !== 0;
    await tx.bankStatementLine.createMany({
      data: [
        ...(broughtForward
          ? [
              {
                organizationId,
                reconciliationId: reconciliation.id,
                position: 0,
                lineDate: parseCalendarDate(first.date)!,
                description: 'Opening balance on the statement',
                amount: signedString(opening),
                broughtForward: true,
              },
            ]
          : []),
        ...lines.map((line, index) => ({
          organizationId,
          reconciliationId: reconciliation.id,
          position: index + 1,
          lineDate: parseCalendarDate(line.date)!,
          description: line.description.slice(0, 500),
          reference: line.reference?.slice(0, 200) ?? null,
          amount: signedString(line.amountFils),
          balance: line.balanceFils === null ? null : signedString(line.balanceFils),
        })),
      ],
    });
    await tx.chartOfAccount.update({
      where: { id: account.id },
      data: { statementColumns: input.columns },
    });

    const matched = await autoMatch(tx, organizationId, reconciliation.id);
    await writeAuditLog(tx, {
      organizationId,
      actorUserId: user.id,
      action: 'bank_reconciliation.statement_uploaded',
      entityType: 'BankReconciliation',
      entityId: reconciliation.id,
      afterData: {
        accountId: account.id,
        fileName: input.fileName || null,
        statementDate: dateText,
        statementBalance: signedString(closing),
        lines: lines.length,
        repeated,
        matched,
      },
    });
    return {
      reconciliationId: reconciliation.id,
      lines: lines.length,
      repeated,
      matched,
    };
  });
}

/** The reconciliation's statement lines with what each is matched to. */
async function statementLines(
  tx: Tx | typeof prisma,
  organizationId: string,
  reconciliationId: string,
) {
  return tx.bankStatementLine.findMany({
    where: { organizationId, reconciliationId },
    orderBy: { position: 'asc' },
    include: {
      matches: {
        select: {
          journalEntryLineId: true,
          line: { select: { debitAmount: true, creditAmount: true } },
        },
      },
    },
  });
}

/** Book lines on the account up to the statement date this reconciliation may still match. */
async function openBookLines(
  tx: Tx | typeof prisma,
  organizationId: string,
  reconciliation: { id: string; accountId: string; statementDate: Date },
) {
  return tx.journalEntryLine.findMany({
    where: {
      organizationId,
      chartOfAccountId: reconciliation.accountId,
      journalEntry: { entryDate: { lte: reconciliation.statementDate } },
      OR: [
        { reconciled: null },
        { reconciled: { reconciliationId: reconciliation.id, statementLineId: null } },
      ],
    },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }],
    select: {
      id: true,
      debitAmount: true,
      creditAmount: true,
      description: true,
      reconciled: { select: { id: true } },
      journalEntry: {
        select: {
          id: true,
          entryNumber: true,
          entryDate: true,
          description: true,
          reversalOfJournalEntryId: true,
        },
      },
    },
  });
}

type BookLine = Awaited<ReturnType<typeof openBookLines>>[number];

const bookFils = (line: {
  debitAmount: { toString(): string };
  creditAmount: { toString(): string };
}) => toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString());

const bookText = (line: BookLine) =>
  [line.journalEntry.entryNumber, line.description, line.journalEntry.description]
    .filter(Boolean)
    .join(' ');

/** Ticks book lines as the statement line they are, or links lines already ticked by hand. */
async function link(
  tx: Tx,
  organizationId: string,
  reconciliationId: string,
  statementLineId: string | null,
  lines: BookLine[],
) {
  const ticked = lines.filter((line) => line.reconciled);
  if (ticked.length > 0 && statementLineId) {
    await tx.reconciledLine.updateMany({
      where: { organizationId, id: { in: ticked.map((line) => line.reconciled!.id) } },
      data: { statementLineId },
    });
  }
  const fresh = lines.filter((line) => !line.reconciled);
  if (fresh.length > 0) {
    await tx.reconciledLine.createMany({
      data: fresh.map((line) => ({
        organizationId,
        reconciliationId,
        journalEntryLineId: line.id,
        statementLineId,
      })),
    });
  }
}

/**
 * Ticks what is certain: the opening balance against the lines before the
 * statement, entries and their reversals together, and every sure match.
 * Returns how many statement lines are newly matched.
 */
async function autoMatch(tx: Tx, organizationId: string, reconciliationId: string) {
  const reconciliation = await tx.bankReconciliation.findFirstOrThrow({
    where: { id: reconciliationId, organizationId },
    select: { id: true, accountId: true, statementDate: true },
  });
  const statement = (await statementLines(tx, organizationId, reconciliationId)).filter(
    (line) => line.matches.length === 0,
  );
  let books = await openBookLines(tx, organizationId, reconciliation);
  const take = (taken: BookLine[]) => {
    const ids = new Set(taken.map((line) => line.id));
    books = books.filter((line) => !ids.has(line.id));
  };
  let matched = 0;

  // The opening balance clears the lines before the statement, when they
  // come to it exactly; otherwise a person sees what differs.
  const opening = statement.find((line) => line.broughtForward);
  const firstDate = statement.find((line) => !line.broughtForward)?.lineDate;
  if (opening && firstDate) {
    const before = books.filter((line) => line.journalEntry.entryDate < firstDate);
    const total = before.reduce((sum, line) => sum + bookFils(line), 0);
    if (before.length > 0 && total === decimalFils(opening.amount)) {
      await link(tx, organizationId, reconciliationId, opening.id, before);
      take(before);
      matched += 1;
    }
  }

  // An entry and its reversal cancel out; the bank never sees either.
  const byEntry = new Map(books.map((line) => [line.journalEntry.id, line]));
  const pairs: BookLine[] = [];
  for (const line of books) {
    const original = line.journalEntry.reversalOfJournalEntryId
      ? byEntry.get(line.journalEntry.reversalOfJournalEntryId)
      : undefined;
    if (original && bookFils(original) === -bookFils(line)) pairs.push(original, line);
  }
  const unpaired = pairs.filter((line) => !line.reconciled);
  if (unpaired.length > 0) {
    await link(tx, organizationId, reconciliationId, null, unpaired);
  }
  take(pairs);

  const toMatch = statement.filter((line) => !line.broughtForward);
  const bookById = new Map(books.map((line) => [line.id, line]));
  const sure = matchLines(
    toMatch.map((line) => statementMatchLine(line)),
    books.map((line) => bookMatchLine(line)),
  ).filter((match) => match.sure);
  for (const match of sure) {
    await link(tx, organizationId, reconciliationId, match.statementId, [
      bookById.get(match.bookId)!,
    ]);
    matched += 1;
  }
  return matched;
}

const statementMatchLine = (line: {
  id: string;
  lineDate: Date;
  amount: { toString(): string };
  description: string;
  reference: string | null;
}): MatchLine => ({
  id: line.id,
  date: line.lineDate.toISOString().slice(0, 10),
  amountFils: decimalFils(line.amount),
  text: `${line.description} ${line.reference ?? ''}`,
});

const bookMatchLine = (line: BookLine): MatchLine => ({
  id: line.id,
  date: line.journalEntry.entryDate.toISOString().slice(0, 10),
  amountFils: bookFils(line),
  text: bookText(line),
});

/** Looks for matches again — after recording what was missing from the books. */
export async function rematchStatement(user: AuthenticatedUser, reconciliationId: string) {
  requirePermission(user, 'accounting.edit');
  return prisma.$transaction(async (tx) => {
    await lockOpen(tx, user.organizationId, reconciliationId);
    const matched = await autoMatch(tx, user.organizationId, reconciliationId);
    return { matched };
  });
}

const matchSchema = z.object({
  statementLineId: z.uuid(),
  bookLineIds: z.array(z.uuid()).min(1, 'Choose the lines in the books.').max(500),
});

/** Matches a statement line to one or more book lines that come to its amount. */
export async function matchStatementLine(
  user: AuthenticatedUser,
  reconciliationId: string,
  rawInput: unknown,
) {
  requirePermission(user, 'accounting.edit');
  const input = parseInput(matchSchema, rawInput);
  return prisma.$transaction(async (tx) => {
    const reconciliation = await lockOpen(tx, user.organizationId, reconciliationId);
    const statementLine = await tx.bankStatementLine.findFirst({
      where: {
        id: input.statementLineId,
        organizationId: user.organizationId,
        reconciliationId: reconciliation.id,
      },
      include: { matches: { select: { id: true } } },
    });
    if (!statementLine) throw new NotFoundError('statement line');
    if (statementLine.matches.length > 0) {
      throw new DomainError('That statement line is already matched. Unmatch it first.');
    }
    const wanted = new Set(input.bookLineIds);
    const lines = (await openBookLines(tx, user.organizationId, reconciliation)).filter((line) =>
      wanted.has(line.id),
    );
    if (lines.length !== wanted.size) {
      throw new DomainError(
        'Some of those lines are already matched, or are not on this account up to the statement date.',
      );
    }
    const total = lines.reduce((sum, line) => sum + bookFils(line), 0);
    const amount = decimalFils(statementLine.amount);
    if (total !== amount) {
      throw new DomainError(
        `The lines chosen come to ${signedString(total)}; the statement line is ${signedString(amount)}.`,
      );
    }
    await link(tx, user.organizationId, reconciliation.id, statementLine.id, lines);
    return { matched: lines.length };
  });
}

/** Undoes a statement line's match: its book lines are unticked. */
export async function unmatchStatementLine(
  user: AuthenticatedUser,
  reconciliationId: string,
  statementLineId: string,
) {
  requirePermission(user, 'accounting.edit');
  return prisma.$transaction(async (tx) => {
    const reconciliation = await lockOpen(tx, user.organizationId, reconciliationId);
    const { count } = await tx.reconciledLine.deleteMany({
      where: {
        organizationId: user.organizationId,
        reconciliationId: reconciliation.id,
        statementLineId,
      },
    });
    return { unticked: count };
  });
}

/**
 * The uploaded statement beside the books: each line, what it is matched to,
 * and for one not yet matched, the likeliest book line. Null when the
 * reconciliation was started by hand.
 */
export async function getStatementView(user: AuthenticatedUser, reconciliationId: string) {
  requirePermission(user, 'accounting.view');
  const organizationId = user.organizationId;
  const reconciliation = await prisma.bankReconciliation.findFirst({
    where: { id: reconciliationId, organizationId },
    select: {
      id: true,
      accountId: true,
      statementDate: true,
      status: true,
      statementBalance: true,
      statementOpening: true,
    },
  });
  if (!reconciliation) throw new NotFoundError('reconciliation');
  const lines = await statementLines(prisma, organizationId, reconciliationId);
  if (lines.length === 0) return null;
  const checks = await statementChecks(organizationId, reconciliation, lines);

  const suggestions = new Map<string, string>();
  if (reconciliation.status === 'IN_PROGRESS') {
    const books = await openBookLines(prisma, organizationId, reconciliation);
    const open = books.filter((line) => !line.reconciled);
    for (const match of matchLines(
      lines
        .filter((line) => line.matches.length === 0 && !line.broughtForward)
        .map((line) => statementMatchLine(line)),
      open.map((line) => bookMatchLine(line)),
    )) {
      suggestions.set(match.statementId, match.bookId);
    }
  }

  const rows = lines.map((line) => {
    const amount = decimalFils(line.amount);
    const matchedFils = line.matches.reduce((sum, match) => sum + bookFils(match.line), 0);
    return {
      id: line.id,
      date: line.lineDate.toISOString().slice(0, 10),
      description: line.description,
      reference: line.reference,
      amount: signedString(amount),
      balance: line.balance === null ? null : signedString(decimalFils(line.balance)),
      broughtForward: line.broughtForward,
      /** Book lines ticked as this statement line. */
      matchedLineIds: line.matches.map((match) => match.journalEntryLineId),
      status:
        line.matches.length === 0
          ? ('open' as const)
          : matchedFils === amount
            ? ('matched' as const)
            : ('partly' as const),
      suggestedLineId: suggestions.get(line.id) ?? null,
    };
  });
  return {
    rows,
    matched: rows.filter((row) => row.status === 'matched').length,
    open: rows.filter((row) => row.status !== 'matched').length,
    checks,
  };
}

/**
 * What a careful accountant checks on a statement before trusting it: the
 * lines add up from the opening to the closing balance, the running balance
 * never jumps (no line missing), and it opens where the last one closed (no
 * statement missing in between).
 */
async function statementChecks(
  organizationId: string,
  reconciliation: {
    id: string;
    accountId: string;
    statementDate: Date;
    statementBalance: { toString(): string };
    statementOpening: { toString(): string } | null;
  },
  lines: Awaited<ReturnType<typeof statementLines>>,
) {
  const checks: string[] = [];
  const own = lines.filter((line) => !line.broughtForward);
  const closing = decimalFils(reconciliation.statementBalance);
  const opening =
    reconciliation.statementOpening === null ? null : decimalFils(reconciliation.statementOpening);
  if (opening !== null) {
    const added = opening + own.reduce((sum, line) => sum + decimalFils(line.amount), 0);
    if (added !== closing) {
      checks.push(
        `The lines don't add up: the opening ${signedString(opening)} plus the lines is ${signedString(added)}, not the closing ${signedString(closing)}. A line may be missing from the file.`,
      );
    }
  }
  let breaks = 0;
  for (let i = 1; i < own.length; i += 1) {
    const before = own[i - 1].balance;
    const after = own[i].balance;
    if (
      before &&
      after &&
      decimalFils(before) + decimalFils(own[i].amount) !== decimalFils(after)
    ) {
      breaks += 1;
    }
  }
  if (breaks > 0) {
    checks.push(
      `The running balance jumps on ${breaks} line${breaks === 1 ? '' : 's'}: the file may be missing lines.`,
    );
  }
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
  if (previous && opening !== null && opening !== decimalFils(previous.statementBalance)) {
    checks.push(
      `This statement opens at ${signedString(opening)}, but the one reconciled to ${formatCalendarDate(previous.statementDate)} closed at ${signedString(decimalFils(previous.statementBalance))}. A statement in between may be missing.`,
    );
  }
  return checks;
}

export type StatementView = NonNullable<Awaited<ReturnType<typeof getStatementView>>>;
