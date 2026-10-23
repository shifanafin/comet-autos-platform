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
import { getTransferAccounts } from '@/lib/finance/money';
import { OWNER_MONEY_LABEL, type OwnerMoneyKindKey } from '@/lib/finance/owner-money-labels';

/*
 * Owner's money (OWN-) — an owner putting money into the business, or taking
 * it out, into or out of one of its cash, petty cash or bank accounts:
 *
 *   capital in    money to stay in the business      Dr the account / Cr Owner's capital
 *   loan in       money the owner will take back      Dr the account / Cr Due to owner
 *                 (repaid through "Reimburse owner", as anything owed to an owner)
 *   drawings      money the owner takes for themself  Dr Owner's drawings / Cr the account
 *
 * Capital can also come in without passing through cash or bank:
 *
 *   a cost paid   the partner paid a business cost from their own pocket
 *                 (Tasheel fees, a typing centre)   Dr the expense / Cr Owner's capital
 *   left in       what the business owed the partner — a salary not taken,
 *                 a bill they paid — left in        Dr what was owed / Cr Owner's capital
 *
 * Either way the partner is named, so it counts in their contribution.
 * The money put in is never income; a cost paid is the expense it always
 * was, only funded by the partner. Never edited: a mistake is voided, which
 * reverses its entry.
 */

/** Only the workshop's own cash, petty cash and bank — never card settlements or a card's debt. */
const OWN_MONEY = new Set(['cash', 'petty', 'bank', 'other']);

/** How money put in arrived: into cash or bank, as a cost the partner paid, or as something owed left in. */
export type OwnerMoneyHow = 'money' | 'cost' | 'owed';

/** Expense accounts the automatic postings keep — never chosen by hand. */
const SYSTEM_EXPENSES = [
  'COST_OF_PARTS',
  'STOCK_ADJUSTMENTS',
  'GRATUITY_EXPENSE',
  'LEAVE_EXPENSE',
] as const;

/** What the business can owe a partner that they may leave in as capital. */
const OWED_ROLES = ['SALARIES_PAYABLE', 'OWNER_ADVANCES'] as const;

/** The accounts capital can come in through other than cash or bank: costs paid, and amounts owed. */
async function directAccounts(organizationId: string) {
  const rows = await prisma.chartOfAccount.findMany({
    where: {
      organizationId,
      isActive: true,
      OR: [
        {
          accountType: 'EXPENSE',
          OR: [{ role: null }, { role: { notIn: [...SYSTEM_EXPENSES] } }],
        },
        { role: { in: [...OWED_ROLES] } },
      ],
    },
    orderBy: { accountCode: 'asc' },
    select: { id: true, accountCode: true, accountName: true, accountType: true },
  });
  const option = (row: (typeof rows)[number]) => ({
    id: row.id,
    code: row.accountCode,
    label: row.accountName,
  });
  return {
    cost: rows.filter((row) => row.accountType === 'EXPENSE').map(option),
    owed: rows.filter((row) => row.accountType !== 'EXPENSE').map(option),
  };
}

/** How a recorded entry's money arrived, read from the account it books to. */
export function ownerMoneyHow(account: { isPaymentAccount: boolean; accountType: string }) {
  if (account.isPaymentAccount) return 'money';
  return account.accountType === 'EXPENSE' ? 'cost' : 'owed';
}

/** Where an entry's money went, in words: "into Cash on hand", "paid for Bank charges"… */
export function ownerMoneyWhere(
  kind: OwnerMoneyKindKey,
  account: { accountName: string; isPaymentAccount: boolean; accountType: string },
) {
  if (kind === 'DRAWINGS') return `from ${account.accountName}`;
  const how = ownerMoneyHow(account);
  if (how === 'cost') return `paid for ${account.accountName}`;
  if (how === 'owed') return `left in from ${account.accountName}`;
  return `into ${account.accountName}`;
}

/** The accounts the entry books to besides the money account, by kind — for the form's preview. */
async function ownerAccounts(organizationId: string) {
  const rows = await prisma.chartOfAccount.findMany({
    where: {
      organizationId,
      OR: [
        { role: { in: ['OWNER_CAPITAL', 'OWNER_DRAWINGS', 'OWNER_ADVANCES'] } },
        // Before the chart has adopted them as system accounts.
        { accountCode: { in: ['3000', '3100', '2520'] } },
      ],
    },
    select: { accountCode: true, accountName: true, role: true },
  });
  const pick = (role: string, code: string, fallback: string) => {
    const row = rows.find((r) => r.role === role) ?? rows.find((r) => r.accountCode === code);
    return { code: row?.accountCode ?? code, name: row?.accountName ?? fallback };
  };
  return {
    CAPITAL_IN: pick('OWNER_CAPITAL', '3000', "Owner's capital"),
    LOAN_IN: pick('OWNER_ADVANCES', '2520', 'Due to owner'),
    DRAWINGS: pick('OWNER_DRAWINGS', '3100', "Owner's drawings"),
  };
}

/** What the form needs: the money accounts, the partners and the other side of each entry. */
export async function getOwnerMoneyForm(user: AuthenticatedUser) {
  requirePermission(user, 'money.view');
  const [accounts, partners, other, direct] = await Promise.all([
    getTransferAccounts(user),
    prisma.partner.findMany({
      where: { organizationId: user.organizationId, isActive: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    }),
    ownerAccounts(user.organizationId),
    directAccounts(user.organizationId),
  ]);
  return {
    accounts: accounts.filter((account) => OWN_MONEY.has(account.kind)),
    partners,
    other,
    /** Capital put in other than through cash or bank: the cost paid, or what was owed. */
    direct,
    today: localDateString(),
  };
}

export type OwnerMoneyForm = Awaited<ReturnType<typeof getOwnerMoneyForm>>;

const recordSchema = z.object({
  kind: z.enum(['CAPITAL_IN', 'LOAN_IN', 'DRAWINGS'], {
    error: 'Choose whether money went in or came out.',
  }),
  how: z.enum(['money', 'cost', 'owed']).optional(),
  accountId: z.uuid({ error: 'Choose the account.' }),
  partnerId: z.union([z.literal(''), z.uuid()]).optional(),
  amount: z
    .string({ error: 'Enter the amount.' })
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter the amount like 6000 or 6000.00.'),
  movedOn: z
    .string({ error: 'Enter the date.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date.'),
  reference: z.string().trim().max(60, 'Keep the reference under 60 characters.').optional(),
  notes: z.string().trim().max(500, 'Keep the notes under 500 characters.').optional(),
  requestKey: z.string().optional(),
});

/** Records an owner putting money in or taking it out, and books it. */
export async function recordOwnerMoney(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(recordSchema, rawInput);
  requirePermission(user, 'money.create');
  const amountFils = toFils(input.amount);
  if (amountFils <= 0) throw new DomainError('Enter an amount above zero.', 'amount');
  const movedOn = parseCalendarDate(input.movedOn);
  if (!movedOn || input.movedOn > localDateString()) {
    throw new DomainError('Enter the date — not a future one.', 'movedOn');
  }
  const how: OwnerMoneyHow = input.how ?? 'money';
  if (how === 'money') {
    const account = (await getTransferAccounts(user)).find((a) => a.id === input.accountId);
    if (!account || !OWN_MONEY.has(account.kind)) {
      throw new DomainError('Choose a cash, petty cash or bank account.', 'accountId');
    }
  } else {
    if (input.kind !== 'CAPITAL_IN') {
      throw new DomainError('Only money put in can be a cost paid or an amount left in.', 'how');
    }
    const direct = await directAccounts(user.organizationId);
    if (!direct[how].some((a) => a.id === input.accountId)) {
      throw new DomainError(
        how === 'cost'
          ? 'Choose the expense the partner paid for.'
          : 'Choose what the business owed.',
        'accountId',
      );
    }
    // A cost paid or an amount left in is always someone's: it counts in their contribution.
    if (!input.partnerId) throw new DomainError('Choose the partner.', 'partnerId');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'owner_money.record');
    if (how === 'money') await checkMoneyAccount(tx, user.organizationId, input.accountId);
    const partner = input.partnerId
      ? await tx.partner.findFirst({
          where: { id: input.partnerId, organizationId: user.organizationId, isActive: true },
          select: { id: true, name: true },
        })
      : null;
    if (input.partnerId && !partner) {
      throw new DomainError('Choose a partner from the list.', 'partnerId');
    }
    const entryNumber = await allocateDocumentNumber(tx, user.organizationId, null, 'OWNER_MONEY');
    const row = await tx.ownerMoney.create({
      data: {
        organizationId: user.organizationId,
        entryNumber,
        kind: input.kind,
        accountId: input.accountId,
        partnerId: partner?.id ?? null,
        amount: filsToString(amountFils),
        movedOn,
        reference: input.reference || null,
        notes: input.notes || null,
        createdByUserId: user.id,
      },
      select: { id: true, entryNumber: true },
    });
    await syncPosting(tx, user.organizationId, 'OWNER_MONEY', row.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'owner_money.recorded',
      entityType: 'OwnerMoney',
      entityId: row.id,
      afterData: {
        entryNumber,
        kind: input.kind,
        what: OWNER_MONEY_LABEL[input.kind],
        how,
        accountId: input.accountId,
        partner: partner?.name ?? null,
        amount: filsToString(amountFils),
        movedOn: input.movedOn,
        reference: input.reference || null,
      },
    });
    await settleRequestKey(tx, user, rawInput, row.id);
    return row;
  });
}

const voidSchema = z.object({
  reason: z.string({ error: 'Say why.' }).trim().min(3, 'Say why, in a few words.').max(300),
  requestKey: z.string().optional(),
});

/** Withdraws an entry made by mistake: kept on record, its journal entry reversed. */
export async function voidOwnerMoney(user: AuthenticatedUser, id: string, rawInput: unknown) {
  const input = parseInput(voidSchema, rawInput);
  requirePermission(user, 'money.delete');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM owner_money WHERE id = ${id}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const row = await tx.ownerMoney.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, status: true, entryNumber: true, amount: true, kind: true },
    });
    if (!row) throw new NotFoundError("owner's money entry");
    if (row.status === 'VOID') throw new DomainError('This entry is already void.');
    const voidedAt = new Date();
    await tx.ownerMoney.update({
      where: { id: row.id },
      data: { status: 'VOID', voidedAt, voidReason: input.reason },
    });
    await syncPosting(tx, user.organizationId, 'OWNER_MONEY', row.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'owner_money.voided',
      entityType: 'OwnerMoney',
      entityId: row.id,
      beforeData: { status: 'POSTED' },
      afterData: { status: 'VOID', voidedAt: voidedAt.toISOString() },
      metadata: {
        reason: input.reason,
        entryNumber: row.entryNumber,
        kind: row.kind,
        amount: row.amount.toString(),
      },
    });
    return { id: row.id };
  });
}

/** Every entry, newest first, with its journal entry; and what stands in total by kind. */
export async function listOwnerMoney(user: AuthenticatedUser) {
  requirePermission(user, 'money.view');
  const rows = await prisma.ownerMoney.findMany({
    where: { organizationId: user.organizationId },
    // Every entry: the totals and each partner's balance are worked out over them all.
    orderBy: [{ movedOn: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      entryNumber: true,
      kind: true,
      amount: true,
      movedOn: true,
      reference: true,
      notes: true,
      status: true,
      voidReason: true,
      account: {
        select: { accountCode: true, accountName: true, isPaymentAccount: true, accountType: true },
      },
      owner: { select: { fullName: true } },
      partner: { select: { id: true, name: true } },
      createdBy: { select: { fullName: true } },
    },
  });
  const partners = await prisma.partner.findMany({
    where: { organizationId: user.organizationId },
    orderBy: { name: 'asc' },
    select: { id: true, name: true, isActive: true },
  });
  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: user.organizationId,
      sourceType: 'OWNER_MONEY',
      sourceId: { in: rows.map((row) => row.id) },
    },
    orderBy: { createdAt: 'asc' },
    select: { sourceId: true, entryNumber: true, reversalOfJournalEntryId: true },
  });
  const booked = new Map<string, { entry: string | null; reversal: string | null }>();
  for (const entry of entries) {
    const seen = booked.get(entry.sourceId!) ?? { entry: null, reversal: null };
    if (entry.reversalOfJournalEntryId) seen.reversal = entry.entryNumber;
    else seen.entry = entry.entryNumber;
    booked.set(entry.sourceId!, seen);
  }
  // What stands (void entries count for nothing), for everyone or one partner.
  const sumFils = (kind: keyof typeof OWNER_MONEY_LABEL, partnerId?: string) =>
    rows
      .filter(
        (row) =>
          row.kind === kind &&
          row.status === 'POSTED' &&
          (partnerId === undefined || row.partner?.id === partnerId),
      )
      .reduce((sum, row) => sum + toFils(row.amount.toString()), 0);
  const total = (kind: keyof typeof OWNER_MONEY_LABEL) => filsToString(sumFils(kind));
  return {
    rows: rows.map((row) => ({
      ...row,
      label: OWNER_MONEY_LABEL[row.kind],
      where: ownerMoneyWhere(row.kind, row.account),
      journalEntry: booked.get(row.id)?.entry ?? null,
      reversedBy: booked.get(row.id)?.reversal ?? null,
    })),
    totals: {
      capitalIn: total('CAPITAL_IN'),
      loansIn: total('LOAN_IN'),
      drawings: total('DRAWINGS'),
    },
    /** Each partner: put in, lent, taken out, and what they have in the business net. */
    partners: partners.map((partner) => {
      const capitalIn = sumFils('CAPITAL_IN', partner.id);
      const loansIn = sumFils('LOAN_IN', partner.id);
      const drawings = sumFils('DRAWINGS', partner.id);
      const net = capitalIn + loansIn - drawings;
      return {
        ...partner,
        capitalIn: filsToString(capitalIn),
        loansIn: filsToString(loansIn),
        drawings: filsToString(drawings),
        net: net < 0 ? `-${filsToString(-net)}` : filsToString(net),
      };
    }),
    canRecord: hasPermission(user, 'money.create'),
    canVoid: hasPermission(user, 'money.delete'),
  };
}

const partnerSchema = z.object({
  name: z
    .string({ error: 'Enter the partner’s name.' })
    .trim()
    .min(2, 'Enter the partner’s name.')
    .max(100, 'Keep the name under 100 characters.'),
  requestKey: z.string().optional(),
});

/** Adds a partner (owner) — a name kept here, not a login. */
export async function addPartner(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(partnerSchema, rawInput);
  requirePermission(user, 'money.create');
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'partner.add');
    const clash = await tx.partner.findFirst({
      where: {
        organizationId: user.organizationId,
        name: { equals: input.name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (clash) throw new DomainError('There is already a partner by that name.', 'name');
    const partner = await tx.partner.create({
      data: { organizationId: user.organizationId, name: input.name },
      select: { id: true, name: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'partner.added',
      entityType: 'Partner',
      entityId: partner.id,
      afterData: { name: partner.name },
    });
    await settleRequestKey(tx, user, rawInput, partner.id);
    return partner;
  });
}
