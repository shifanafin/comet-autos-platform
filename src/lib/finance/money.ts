import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { filsToString, toFils } from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { allocateDocumentNumber } from '@/lib/numbering';
import { syncPosting } from '@/lib/accounting/journal';
import { checkMoneyAccount } from '@/lib/accounting/chart';
import { lineText, sourceLinks } from '@/lib/accounting/reports';
import { resolvePeriod } from '@/lib/finance/dashboard';
import { monthByMonth } from '@/lib/accounting/months';

/** A period chosen on screen: ?period=month, or custom with from/to. */
export type MoneyPeriodInput = { period?: string; from?: string; to?: string };

const calendarDay = (day: string) => new Date(`${day}T00:00:00Z`);

/*
 * Money — what the workshop has in each of its own accounts, in plain words,
 * and moving it between them.
 *
 * The accounts are the chart's cash, bank and card accounts (those marked as
 * money accounts). Each balance is read from the books — the same journal
 * lines every report uses — so this screen never disagrees with the balance
 * sheet. Nothing is calculated a second way.
 *
 *   Cash on hand            the cash drawer                       counted as money
 *   Petty cash              the separate small-cash box           counted as money
 *   Bank                    the bank account(s)                   counted as money
 *   Card payments on the    customers' card payments the card     counted as money
 *     way                   company has yet to pay into the bank
 *   Company card            a card the workshop owes on           NOT money: a debt
 *                           (a liability money account)
 *   Other                   e.g. post-dated cheques received      not counted until banked
 *
 * A money transfer (TRF-) moves money between two of them — cash on hand
 * into the petty-cash box, takings into the bank. It is neither income nor
 * expense; the books show Dr the account it went to, Cr the one it came from.
 * It is never edited: a mistake is voided, which reverses its entry.
 *
 * Card money paid into the bank arrives less the card machine's fee. The
 * transfer then says what the bank kept — its fee and the VAT on it — and
 * that is a bank charge: Card payments on the way go down by all of it, the
 * bank up by what arrived (lib/accounting/postings.ts).
 */

export type MoneyKind = 'cash' | 'petty' | 'bank' | 'card-settlements' | 'company-card' | 'other';

export const MONEY_KIND_LABEL: Record<MoneyKind, string> = {
  cash: 'Cash on hand',
  petty: 'Petty cash',
  bank: 'Bank',
  'card-settlements': 'Card payments on the way',
  'company-card': 'Company card',
  other: 'Other',
};

/** Which of the kinds above a money account is. */
function kindOf(account: {
  role: string | null;
  accountCode: string;
  accountName: string;
  accountType: string;
}): MoneyKind {
  if (account.accountType === 'LIABILITY') return 'company-card';
  if (account.role === 'CASH') return 'cash';
  if (account.role === 'CARD_CLEARING') return 'card-settlements';
  if (account.accountCode === '1005' || /petty/i.test(account.accountName)) return 'petty';
  if (account.role === 'BANK' || /bank/i.test(account.accountName)) return 'bank';
  return 'other';
}

/** Kinds that are the workshop's own money, counted in "money now". */
const COUNTED: MoneyKind[] = ['cash', 'petty', 'bank', 'card-settlements'];

async function moneyAccounts(organizationId: string) {
  const accounts = await prisma.chartOfAccount.findMany({
    where: { organizationId, isPaymentAccount: true },
    orderBy: { accountCode: 'asc' },
    select: {
      id: true,
      accountCode: true,
      accountName: true,
      accountType: true,
      role: true,
      isActive: true,
    },
  });
  const sums = await prisma.journalEntryLine.groupBy({
    by: ['chartOfAccountId'],
    where: { organizationId, chartOfAccountId: { in: accounts.map((account) => account.id) } },
    _sum: { debitAmount: true, creditAmount: true },
  });
  const balance = new Map(
    sums.map((row) => [
      row.chartOfAccountId,
      toFils(row._sum.debitAmount?.toString() ?? '0') -
        toFils(row._sum.creditAmount?.toString() ?? '0'),
    ]),
  );
  return accounts.map((account) => {
    const kind = kindOf(account);
    // Debit balance: what is in it. A company card's credit balance: what is owed on it.
    const fils = balance.get(account.id) ?? 0;
    return { ...account, kind, fils, balance: signed(kind === 'company-card' ? -fils : fils) };
  });
}

const signed = (fils: number) => (fils < 0 ? `-${filsToString(-fils)}` : filsToString(fils));

/**
 * Every money account with what is in it, grouped, and the workshop's money in
 * total. Given a period, each account also shows the money in and out in it.
 */
export async function getMoneyOverview(user: AuthenticatedUser, periodInput?: MoneyPeriodInput) {
  requirePermission(user, 'money.view');
  const accounts = await moneyAccounts(user.organizationId);
  const period = periodInput ? resolvePeriod(periodInput) : null;
  const moved = new Map<string, { in: number; out: number }>();
  if (period) {
    const sums = await prisma.journalEntryLine.groupBy({
      by: ['chartOfAccountId'],
      where: {
        organizationId: user.organizationId,
        chartOfAccountId: { in: accounts.map((account) => account.id) },
        journalEntry: { entryDate: { gte: calendarDay(period.from), lte: calendarDay(period.to) } },
      },
      _sum: { debitAmount: true, creditAmount: true },
    });
    for (const row of sums) {
      moved.set(row.chartOfAccountId, {
        in: toFils(row._sum.debitAmount?.toString() ?? '0'),
        out: toFils(row._sum.creditAmount?.toString() ?? '0'),
      });
    }
  }
  const shown = accounts.filter((account) => account.isActive || account.fils !== 0);
  const total = (kinds: MoneyKind[]) =>
    shown.filter((account) => kinds.includes(account.kind)).reduce((sum, a) => sum + a.fils, 0);
  const groups = (Object.keys(MONEY_KIND_LABEL) as MoneyKind[])
    .map((kind) => {
      const inKind = shown.filter((account) => account.kind === kind);
      const fils = inKind.reduce((sum, account) => sum + account.fils, 0);
      return {
        kind,
        label: MONEY_KIND_LABEL[kind],
        counted: COUNTED.includes(kind),
        total: signed(kind === 'company-card' ? -fils : fils),
        accounts: inKind.map((account) => ({
          id: account.id,
          code: account.accountCode,
          name: account.accountName,
          balance: account.balance,
          /** In and out in the period chosen (a card: paid off, and spent). */
          moneyIn: filsToString(moved.get(account.id)?.in ?? 0),
          moneyOut: filsToString(moved.get(account.id)?.out ?? 0),
          /** Below zero: more was paid out of it than was ever recorded going in. */
          belowZero: kind !== 'company-card' && account.fils < 0,
        })),
      };
    })
    .filter((group) => group.accounts.length > 0);
  return {
    groups,
    /** Cash on hand + petty cash + bank + card payments on the way. Never a card's debt. */
    moneyNow: signed(total(COUNTED)),
    /** What is owed on company cards (a debt, not money). */
    owedOnCards: signed(-total(['company-card'])),
    hasCompanyCard: shown.some((account) => account.kind === 'company-card'),
    canTransfer: hasPermission(user, 'money.create'),
    period,
  };
}

export type MoneyOverview = Awaited<ReturnType<typeof getMoneyOverview>>;

/** The money accounts to move money between, with what is in each. */
export async function getTransferAccounts(user: AuthenticatedUser) {
  requirePermission(user, 'money.view');
  return (await moneyAccounts(user.organizationId))
    .filter((account) => account.isActive)
    .map((account) => ({
      id: account.id,
      label: account.accountName,
      code: account.accountCode,
      kind: account.kind,
      balance: account.balance,
    }));
}

/**
 * One money account: every movement in and out, newest first, with the
 * balance after each — each one linked to the invoice, expense or transfer
 * behind it. Given a period, only its movements, with the balance brought
 * forward from before it and the balance at its end — a statement.
 */
export async function getMoneyAccountActivity(
  user: AuthenticatedUser,
  accountId: string,
  periodInput?: MoneyPeriodInput,
) {
  requirePermission(user, 'money.view');
  const account = (await moneyAccounts(user.organizationId)).find((a) => a.id === accountId);
  if (!account) throw new NotFoundError('money account');
  const lines = await prisma.journalEntryLine.findMany({
    where: { organizationId: user.organizationId, chartOfAccountId: account.id },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }],
    select: {
      id: true,
      debitAmount: true,
      creditAmount: true,
      description: true,
      journalEntry: {
        select: {
          entryNumber: true,
          entryDate: true,
          description: true,
          sourceType: true,
          sourceId: true,
        },
      },
    },
  });
  const link = await sourceLinks(
    user.organizationId,
    lines.map((line) => line.journalEntry),
  );
  // A company card's balance runs the other way: a payment on it adds to what is owed.
  const sign = account.kind === 'company-card' ? -1 : 1;
  let running = 0;
  const rows = lines.map((line) => {
    const inFils = toFils(line.debitAmount.toString());
    const outFils = toFils(line.creditAmount.toString());
    running += sign * (inFils - outFils);
    return {
      id: line.id,
      date: line.journalEntry.entryDate,
      entryNumber: line.journalEntry.entryNumber,
      description: lineText(line.description, line.journalEntry.description),
      moneyIn: inFils ? filsToString(inFils) : '',
      moneyOut: outFils ? filsToString(outFils) : '',
      balance: signed(running),
      runningFils: running,
      inFils,
      outFils,
      href: link(line.journalEntry.sourceType, line.journalEntry.sourceId).href,
    };
  });
  const period = periodInput ? resolvePeriod(periodInput) : null;
  const day = (date: Date) => date.toISOString().slice(0, 10);
  const before = period ? rows.filter((row) => day(row.date) < period.from) : [];
  const within = period
    ? rows.filter((row) => day(row.date) >= period.from && day(row.date) <= period.to)
    : rows;
  const opening = before.length ? before[before.length - 1].runningFils : 0;
  const totalIn = within.reduce((sum, row) => sum + row.inFils, 0);
  const totalOut = within.reduce((sum, row) => sum + row.outFils, 0);
  return {
    period,
    statement: {
      /** What it held when the period began (a card: owed). */
      opening: signed(opening),
      moneyIn: filsToString(totalIn),
      moneyOut: filsToString(totalOut),
      closing: signed(opening + sign * (totalIn - totalOut)),
    },
    /** The period month by month, each opening on the last one's close. */
    months: period
      ? monthByMonth(
          opening,
          within.map((row) => ({
            date: day(row.date),
            a: row.inFils,
            b: row.outFils,
            delta: sign * (row.inFils - row.outFils),
          })),
          period.from,
          period.to,
        )
      : [],
    account: {
      id: account.id,
      code: account.accountCode,
      name: account.accountName,
      kind: account.kind,
      kindLabel: MONEY_KIND_LABEL[account.kind],
      balance: account.balance,
      belowZero: account.kind !== 'company-card' && account.fils < 0,
    },
    rows: within
      .map((row) => ({
        id: row.id,
        date: row.date,
        entryNumber: row.entryNumber,
        description: row.description,
        moneyIn: row.moneyIn,
        moneyOut: row.moneyOut,
        balance: row.balance,
        href: row.href,
      }))
      .reverse(),
  };
}

// ─── Transfers ──────────────────────────────────────────────────────────────

const transferSchema = z.object({
  fromAccountId: z.uuid({ error: 'Choose where the money came from.' }),
  toAccountId: z.uuid({ error: 'Choose where the money went.' }),
  amount: z
    .string({ error: 'Enter the amount.' })
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter the amount like 500.00.'),
  /** What the bank kept on the way: its fee before VAT, and the VAT on it. */
  chargesAmount: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter the charges like 25.00.'),
    ])
    .optional(),
  chargesVatAmount: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter the VAT like 1.25.'),
    ])
    .optional(),
  transferredOn: z
    .string({ error: 'Enter the date.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date.'),
  reference: z.string().trim().max(60, 'Keep the reference under 60 characters.').optional(),
  notes: z.string().trim().max(500, 'Keep the notes under 500 characters.').optional(),
  requestKey: z.string().optional(),
});

/** Moves money between two of the workshop's own accounts, and books it. */
export async function recordMoneyTransfer(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(transferSchema, rawInput);
  requirePermission(user, 'money.create');
  if (input.fromAccountId === input.toAccountId) {
    throw new DomainError('Choose two different accounts.', 'toAccountId');
  }
  if (toFils(input.amount) <= 0) throw new DomainError('Enter an amount above zero.', 'amount');
  const charges = toFils(input.chargesAmount || '0');
  const chargesVat = toFils(input.chargesVatAmount || '0');
  if (chargesVat > 0 && charges === 0) {
    throw new DomainError('Enter the bank’s fee the VAT is charged on.', 'chargesAmount');
  }
  if (chargesVat > charges) {
    throw new DomainError('The VAT can’t be more than the fee it is on.', 'chargesVatAmount');
  }
  const transferredOn = parseCalendarDate(input.transferredOn);
  if (!transferredOn || input.transferredOn > localDateString()) {
    throw new DomainError('Enter the date — not a future one.', 'transferredOn');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'money.transfer');
    // Both must be money accounts still in use.
    await checkMoneyAccount(tx, user.organizationId, input.fromAccountId);
    await checkMoneyAccount(tx, user.organizationId, input.toAccountId);
    const transferNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      null,
      'MONEY_TRANSFER',
    );
    const transfer = await tx.moneyTransfer.create({
      data: {
        organizationId: user.organizationId,
        transferNumber,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: filsToString(toFils(input.amount)),
        chargesAmount: filsToString(charges),
        chargesVatAmount: filsToString(chargesVat),
        transferredOn,
        reference: input.reference || null,
        notes: input.notes || null,
        createdByUserId: user.id,
      },
      select: { id: true, transferNumber: true },
    });
    await syncPosting(tx, user.organizationId, 'MONEY_TRANSFER', transfer.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'money_transfer.recorded',
      entityType: 'MoneyTransfer',
      entityId: transfer.id,
      afterData: {
        transferNumber,
        fromAccountId: input.fromAccountId,
        toAccountId: input.toAccountId,
        amount: filsToString(toFils(input.amount)),
        ...(charges + chargesVat > 0
          ? { chargesAmount: filsToString(charges), chargesVatAmount: filsToString(chargesVat) }
          : {}),
        transferredOn: input.transferredOn,
        reference: input.reference || null,
      },
    });
    await settleRequestKey(tx, user, rawInput, transfer.id);
    return transfer;
  });
}

const voidSchema = z.object({
  reason: z.string({ error: 'Say why.' }).trim().min(3, 'Say why, in a few words.').max(300),
  requestKey: z.string().optional(),
});

/** Withdraws a transfer entered by mistake: kept on record, its entry reversed. */
export async function voidMoneyTransfer(
  user: AuthenticatedUser,
  transferId: string,
  rawInput: unknown,
) {
  const input = parseInput(voidSchema, rawInput);
  requirePermission(user, 'money.delete');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM money_transfers WHERE id = ${transferId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const transfer = await tx.moneyTransfer.findFirst({
      where: { id: transferId, organizationId: user.organizationId },
      select: { id: true, status: true, transferNumber: true, amount: true },
    });
    if (!transfer) throw new NotFoundError('money transfer');
    if (transfer.status === 'VOID') throw new DomainError('This transfer is already void.');
    const voidedAt = new Date();
    await tx.moneyTransfer.update({
      where: { id: transfer.id },
      data: { status: 'VOID', voidedAt, voidReason: input.reason },
    });
    await syncPosting(tx, user.organizationId, 'MONEY_TRANSFER', transfer.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'money_transfer.voided',
      entityType: 'MoneyTransfer',
      entityId: transfer.id,
      beforeData: { status: 'POSTED' },
      afterData: { status: 'VOID', voidedAt: voidedAt.toISOString() },
      metadata: {
        reason: input.reason,
        transferNumber: transfer.transferNumber,
        amount: transfer.amount.toString(),
      },
    });
    return { transferId: transfer.id };
  });
}

/** One page of transfers, newest first, and how many there are in all. */
export async function listMoneyTransfers(
  user: AuthenticatedUser,
  limit = 300,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
  /** Active (the default) or only those voided — kept on record, out of the everyday list. */
  view: 'active' | 'voided' = 'active',
) {
  requirePermission(user, 'money.view');
  const where = {
    organizationId: user.organizationId,
    status: view === 'voided' ? ('VOID' as const) : ('POSTED' as const),
  };
  const [transfers, total] = await Promise.all([
    prisma.moneyTransfer.findMany({
      where,
      orderBy: [{ transferredOn: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: limit,
      select: {
        id: true,
        transferNumber: true,
        amount: true,
        chargesAmount: true,
        chargesVatAmount: true,
        transferredOn: true,
        reference: true,
        notes: true,
        status: true,
        voidReason: true,
        fromAccount: { select: { id: true, accountName: true } },
        toAccount: { select: { id: true, accountName: true } },
        createdBy: { select: { fullName: true } },
        createdAt: true,
      },
    }),
    prisma.moneyTransfer.count({ where }),
  ]);
  return {
    transfers,
    total,
    canTransfer: hasPermission(user, 'money.create'),
    canVoid: hasPermission(user, 'money.delete'),
  };
}
