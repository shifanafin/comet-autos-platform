import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { PaymentMethod } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { filsToString, toFils } from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { allocateDocumentNumber } from '@/lib/numbering';
import { syncPosting } from '@/lib/accounting/journal';
import {
  checkMoneyAccount,
  ensureChart,
  refuseCardSettlementAccount,
} from '@/lib/accounting/chart';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { getVatSettings } from '@/lib/tax';
import { splitCardFee } from '@/lib/finance/card-fee';
import { resolveInventoryBranch } from '@/lib/inventory/stock';
import { recordExpenseInTransaction } from '@/lib/finance/expenses';
import { listJobChoices } from '@/lib/finance/job-costing';

/*
 * Payment vouchers (PV-): money paid out to someone, on paper they sign for
 * it. Two kinds:
 *
 * CARD COLLECTION — someone without a card machine (an outside upholsterer)
 * had their customer pay on the workshop's. The money lands in the card
 * account like any card payment, but it is theirs: the voucher records it as
 * owed to them ("Money collected for others"), then pays it over — less what
 * the bank kept for it, the card machine's fee and the VAT on that fee. An
 * example: AED 1,000 swiped, the bank keeps 2% (20.00) + 5% VAT (1.00), so
 * 979.00 is handed over. The fee comes off Bank charges and its VAT off what
 * the workshop reclaims: in the books, their money costs the workshop
 * nothing and earns it nothing. Collected and paid the same day, or paid
 * later ("owed" until then).
 *
 * OUTSIDE WORK — an outside mechanic called in, a sublet repair. It is an
 * expense (default "Cost of sales — sublet repairs"), recorded through the
 * expense rules so it counts in the job's cost; the voucher is the paper
 * the person signs. No VAT: someone with a tax invoice is entered as an
 * expense with its bill.
 *
 * A voucher is never edited. A mistake is voided — kept on record, its
 * entries reversed (and, for outside work, its expense voided) — and
 * entered again. Money is exact integer fils throughout.
 */

const MONEY = /^\d{1,9}(\.\d{1,2})?$/;
const METHODS = ['CASH', 'CARD', 'BANK_TRANSFER', 'CHEQUE', 'ONLINE'] as const;

const amount = (error: string) => z.string({ error }).trim().regex(MONEY, error);
const optionalAmount = (error: string) =>
  z.union([z.literal(''), z.string().trim().regex(MONEY, error)]).optional();
const day = (error: string) =>
  z
    .string({ error })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, error);
const optionalId = z.union([z.literal(''), z.uuid()]).optional();

const payeeFields = {
  payeeName: z
    .string({ error: 'Who is being paid?' })
    .trim()
    .min(2, 'Who is being paid?')
    .max(160, 'Keep the name under 160 characters.'),
  payeePhone: z.string().trim().max(30, 'Keep the phone number under 30 characters.').optional(),
  description: z
    .string({ error: 'Say what it is for.' })
    .trim()
    .min(2, 'Say what it is for.')
    .max(300, 'Keep it under 300 characters.'),
  notes: z.string().trim().max(1000, 'Keep the notes under 1000 characters.').optional(),
  requestKey: z.string().optional(),
};

/** How it was paid: the method, the account (blank: the method's own), a reference. */
const paymentFields = {
  paymentMethod: z.enum(METHODS, { error: 'Choose how it was paid.' }),
  paidFromAccountId: optionalId,
  paymentReference: z.string().trim().max(60, 'Keep the reference under 60 characters.').optional(),
};

/** Paying card money over: when, the bank's fee, and how. */
const payOverSchema = z.object({
  paidOn: day('Choose the day it was paid.'),
  /** The bank's rate on card payments, in %. Blank with a typed fee. */
  feeRate: z
    .union([
      z.literal(''),
      z
        .string()
        .trim()
        .regex(/^\d{1,2}(\.\d{1,2})?$/, 'Enter the bank’s rate like 2.5.'),
    ])
    .optional(),
  /** The fee as the bank statement shows it; blank: worked out from the rate. */
  feeAmount: optionalAmount('Enter the fee like 25.00.'),
  /** The VAT on the fee; blank: worked out at the VAT rate. */
  feeVatAmount: optionalAmount('Enter the VAT like 1.25.'),
  ...paymentFields,
  requestKey: z.string().optional(),
});

const collectionSchema = z.object({
  ...payeeFields,
  collectedOn: day('Choose the day the card was paid.'),
  collectedAmount: amount('Enter the amount like 1000.00.'),
  /** The card account it went into; blank: Card settlements receivable. */
  cardAccountId: optionalId,
  /** The card slip or approval number. */
  cardReference: z.string().trim().max(60, 'Keep the reference under 60 characters.').optional(),
  /** "now": handed over at once (the pay-over fields come with it). */
  payNow: z.string().optional(),
});

const workSchema = z.object({
  ...payeeFields,
  amount: amount('Enter the amount like 350.00.'),
  paidOn: day('Choose the day it was paid.'),
  /** The expense account; blank: Miscellaneous expenses. */
  categoryId: optionalId,
  /** The job it was for: "card:<id>" or "invoice:<id>" (lib/finance/job-costing.ts). */
  forJob: z.string().trim().optional(),
  ...paymentFields,
});

const voidSchema = z.object({
  reason: z.string({ error: 'Say why.' }).trim().min(3, 'Say why, in a few words.').max(300),
  requestKey: z.string().optional(),
});

type Tx = Prisma.TransactionClient;

/** A calendar day that has happened: today or before. */
function pastDay(value: string, field: string, what: string): Date {
  const date = parseCalendarDate(value);
  if (!date || value > localDateString()) {
    throw new DomainError(`Choose the day ${what} — not a future one.`, field);
  }
  return date;
}

/** The account it was paid from, checked: a money account, never the card settlements. */
async function readPaidFrom(
  tx: Tx,
  organizationId: string,
  input: { paymentMethod: PaymentMethod; paidFromAccountId?: string; paymentReference?: string },
) {
  const paidFromAccountId = await checkMoneyAccount(
    tx,
    organizationId,
    emptyToNull(input.paidFromAccountId),
  );
  await refuseCardSettlementAccount(
    tx,
    organizationId,
    input.paymentMethod,
    paidFromAccountId,
    'paidFromAccountId',
  );
  return {
    paymentMethod: input.paymentMethod,
    paidFromAccountId,
    paymentReference: emptyToNull(input.paymentReference),
  };
}

/** Everything stored when card money is paid over. */
async function readPayOver(
  tx: Tx,
  organizationId: string,
  collected: { amount: string; on: string },
  input: z.infer<typeof payOverSchema>,
) {
  const paidOn = pastDay(input.paidOn, 'paidOn', 'it was paid');
  if (input.paidOn < collected.on) {
    throw new DomainError('It can’t be paid over before the card payment was taken.', 'paidOn');
  }
  const settings = await getVatSettings(organizationId, tx);
  const split = splitCardFee(collected.amount, input, settings.vatRate);
  return {
    paidOn,
    feeRate: split.rate,
    feeAmount: filsToString(split.fee),
    feeVatAmount: filsToString(split.vat),
    amount: filsToString(split.paid),
    ...(await readPaidFrom(tx, organizationId, input)),
  };
}

/**
 * Card money taken for someone else — paid over at once ("payNow") or owed
 * to them until it is. Books the collection, and the payment when made.
 */
export async function recordCardCollection(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(collectionSchema, rawInput);
  requirePermission(user, 'payment_voucher.create');
  const collectedOn = pastDay(input.collectedOn, 'collectedOn', 'the card was paid');
  if (toFils(input.collectedAmount) <= 0) {
    throw new DomainError('Enter an amount above zero.', 'collectedAmount');
  }
  const payOver = input.payNow === 'now' ? parseInput(payOverSchema, rawInput) : null;

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'payment_voucher.record');
    const branch = await resolveInventoryBranch(user, tx);
    const accounts = await ensureChart(tx, user.organizationId);
    const cardAccountId =
      (await checkMoneyAccount(tx, user.organizationId, emptyToNull(input.cardAccountId))) ??
      accounts.CARD_CLEARING;
    const collected = filsToString(toFils(input.collectedAmount));
    const paid = payOver
      ? await readPayOver(
          tx,
          user.organizationId,
          { amount: collected, on: input.collectedOn },
          payOver,
        )
      : null;
    const voucherNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      branch.id,
      'PAYMENT_VOUCHER',
    );
    const voucher = await tx.paymentVoucher.create({
      data: {
        organizationId: user.organizationId,
        branchId: branch.id,
        voucherNumber,
        kind: 'CARD_COLLECTION',
        status: paid ? 'PAID' : 'OWED',
        payeeName: input.payeeName.replace(/\s+/g, ' '),
        payeePhone: emptyToNull(input.payeePhone),
        description: input.description.replace(/\s+/g, ' '),
        collectedOn,
        collectedAmount: collected,
        cardAccountId,
        cardReference: emptyToNull(input.cardReference),
        notes: emptyToNull(input.notes),
        ...(paid ?? {}),
        createdByUserId: user.id,
      },
      select: { id: true, voucherNumber: true },
    });
    await syncPosting(tx, user.organizationId, 'CARD_COLLECTION', voucher.id, user.id);
    if (paid) await syncPosting(tx, user.organizationId, 'PAYMENT_VOUCHER', voucher.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      actorUserId: user.id,
      action: 'payment_voucher.recorded',
      entityType: 'PaymentVoucher',
      entityId: voucher.id,
      afterData: {
        voucherNumber,
        kind: 'CARD_COLLECTION',
        payeeName: input.payeeName,
        collectedOn: input.collectedOn,
        collectedAmount: collected,
        ...(paid && payOver
          ? {
              paidOn: payOver.paidOn,
              feeAmount: paid.feeAmount,
              feeVatAmount: paid.feeVatAmount,
              amount: paid.amount,
              paymentMethod: paid.paymentMethod,
            }
          : { status: 'OWED' }),
      },
    });
    await settleRequestKey(tx, user, rawInput, voucher.id);
    return voucher;
  });
}

/** Pays over card money collected earlier, less the bank's fee. */
export async function payCardCollection(
  user: AuthenticatedUser,
  voucherId: string,
  rawInput: unknown,
) {
  const input = parseInput(payOverSchema, rawInput);
  requirePermission(user, 'payment_voucher.create');
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'payment_voucher.pay');
    await tx.$executeRaw`SELECT id FROM payment_vouchers WHERE id = ${voucherId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const voucher = await tx.paymentVoucher.findFirst({
      where: { id: voucherId, organizationId: user.organizationId },
      select: {
        id: true,
        kind: true,
        status: true,
        branchId: true,
        voucherNumber: true,
        collectedOn: true,
        collectedAmount: true,
      },
    });
    if (!voucher) throw new NotFoundError('payment voucher');
    if (voucher.kind !== 'CARD_COLLECTION' || voucher.status !== 'OWED') {
      throw new DomainError(
        voucher.status === 'VOID' ? 'This voucher is void.' : 'This has already been paid.',
      );
    }
    const paid = await readPayOver(
      tx,
      user.organizationId,
      {
        amount: voucher.collectedAmount!.toString(),
        on: voucher.collectedOn!.toISOString().slice(0, 10),
      },
      input,
    );
    await tx.paymentVoucher.update({
      where: { id: voucher.id },
      data: { status: 'PAID', ...paid },
    });
    await syncPosting(tx, user.organizationId, 'PAYMENT_VOUCHER', voucher.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: voucher.branchId,
      actorUserId: user.id,
      action: 'payment_voucher.paid',
      entityType: 'PaymentVoucher',
      entityId: voucher.id,
      beforeData: { status: 'OWED' },
      afterData: {
        status: 'PAID',
        paidOn: input.paidOn,
        feeAmount: paid.feeAmount,
        feeVatAmount: paid.feeVatAmount,
        amount: paid.amount,
        paymentMethod: paid.paymentMethod,
      },
    });
    await settleRequestKey(tx, user, rawInput, voucher.id);
    return { id: voucher.id, voucherNumber: voucher.voucherNumber };
  });
}

/**
 * Outside work paid for: an expense (so it is booked, and counts in the
 * job's cost), with the voucher the person signs.
 */
export async function recordWorkPayment(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(workSchema, rawInput);
  requirePermission(user, 'payment_voucher.create');
  pastDay(input.paidOn, 'paidOn', 'it was paid');
  if (toFils(input.amount) <= 0) throw new DomainError('Enter an amount above zero.', 'amount');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'payment_voucher.record');
    const branch = await resolveInventoryBranch(user, tx);
    // The expense's own rules: the category, the job, how it was paid.
    // No request key of its own: this voucher's guards the whole submission.
    const expense = await recordExpenseInTransaction(tx, user, {
      description: input.description,
      amount: input.amount,
      taxRate: '',
      expenseDate: input.paidOn,
      vendorName: input.payeeName,
      categoryId: input.categoryId ?? '',
      forJob: input.forJob ?? '',
      paymentMethod: input.paymentMethod,
      paidFromAccountId: input.paidFromAccountId ?? '',
      paymentReference: input.paymentReference ?? '',
      notes: input.notes ?? '',
    });
    const voucherNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      branch.id,
      'PAYMENT_VOUCHER',
    );
    const voucher = await tx.paymentVoucher.create({
      data: {
        organizationId: user.organizationId,
        branchId: branch.id,
        voucherNumber,
        kind: 'WORK',
        status: 'PAID',
        payeeName: input.payeeName.replace(/\s+/g, ' '),
        payeePhone: emptyToNull(input.payeePhone),
        description: expense.description,
        amount: expense.amount,
        paidOn: expense.expenseDate,
        paymentMethod: expense.paymentMethod,
        paidFromAccountId: expense.paidFromAccountId,
        paymentReference: expense.paymentReference,
        expenseId: expense.id,
        notes: emptyToNull(input.notes),
        createdByUserId: user.id,
      },
      select: { id: true, voucherNumber: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch.id,
      actorUserId: user.id,
      action: 'payment_voucher.recorded',
      entityType: 'PaymentVoucher',
      entityId: voucher.id,
      afterData: {
        voucherNumber,
        kind: 'WORK',
        payeeName: input.payeeName,
        amount: expense.amount.toString(),
        paidOn: input.paidOn,
        expenseNumber: expense.expenseNumber,
      },
    });
    await settleRequestKey(tx, user, rawInput, voucher.id);
    return voucher;
  });
}

/**
 * Withdraws a voucher entered by mistake: kept on record, marked void, its
 * entries reversed — and, for outside work, its expense voided with it.
 */
export async function voidPaymentVoucher(
  user: AuthenticatedUser,
  voucherId: string,
  rawInput: unknown,
) {
  const input = parseInput(voidSchema, rawInput);
  requirePermission(user, 'payment_voucher.delete');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM payment_vouchers WHERE id = ${voucherId}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const voucher = await tx.paymentVoucher.findFirst({
      where: { id: voucherId, organizationId: user.organizationId },
      select: {
        id: true,
        kind: true,
        status: true,
        branchId: true,
        voucherNumber: true,
        amount: true,
        collectedAmount: true,
        expense: { select: { id: true, status: true, amount: true } },
      },
    });
    if (!voucher) throw new NotFoundError('payment voucher');
    if (voucher.status === 'VOID') throw new DomainError('This voucher is already void.');
    const voidedAt = new Date();
    await tx.paymentVoucher.update({
      where: { id: voucher.id },
      data: { status: 'VOID', voidedAt, voidReason: input.reason },
    });
    if (voucher.kind === 'CARD_COLLECTION') {
      await syncPosting(tx, user.organizationId, 'CARD_COLLECTION', voucher.id, user.id);
      await syncPosting(tx, user.organizationId, 'PAYMENT_VOUCHER', voucher.id, user.id);
    } else if (voucher.expense && voucher.expense.status === 'RECORDED') {
      await tx.expense.update({ where: { id: voucher.expense.id }, data: { status: 'VOID' } });
      await writeAuditLog(tx, {
        organizationId: user.organizationId,
        branchId: voucher.branchId,
        actorUserId: user.id,
        action: 'expense.voided',
        entityType: 'Expense',
        entityId: voucher.expense.id,
        beforeData: { status: 'RECORDED', amount: voucher.expense.amount.toString() },
        afterData: { status: 'VOID' },
        metadata: { reason: input.reason, paymentVoucher: voucher.voucherNumber },
      });
      await syncPosting(tx, user.organizationId, 'EXPENSE', voucher.expense.id, user.id);
    }
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: voucher.branchId,
      actorUserId: user.id,
      action: 'payment_voucher.voided',
      entityType: 'PaymentVoucher',
      entityId: voucher.id,
      beforeData: { status: voucher.status },
      afterData: { status: 'VOID', voidedAt: voidedAt.toISOString() },
      metadata: {
        reason: input.reason,
        voucherNumber: voucher.voucherNumber,
        amount: (voucher.amount ?? voucher.collectedAmount)?.toString() ?? null,
      },
    });
    return { voucherId: voucher.id };
  });
}

const listSelect = {
  id: true,
  voucherNumber: true,
  kind: true,
  status: true,
  payeeName: true,
  description: true,
  collectedOn: true,
  collectedAmount: true,
  feeAmount: true,
  feeVatAmount: true,
  amount: true,
  paidOn: true,
  paymentMethod: true,
  voidReason: true,
  createdAt: true,
  createdBy: { select: { fullName: true } },
  expense: { select: { status: true } },
} satisfies Prisma.PaymentVoucherSelect;

/**
 * One page of vouchers, newest first, and — always in full — the card money
 * still owed to people, with its total.
 */
export async function listPaymentVouchers(
  user: AuthenticatedUser,
  limit = 300,
  /** Rows to skip: the pages before the one shown. */
  offset = 0,
  /** Active (the default) or only those voided — kept on record, out of the everyday list. */
  view: 'active' | 'voided' = 'active',
) {
  requirePermission(user, 'payment_voucher.view');
  const where = { organizationId: user.organizationId };
  const shown = {
    ...where,
    status: view === 'voided' ? ('VOID' as const) : { not: 'VOID' as const },
  };
  const [rows, total, owed] = await Promise.all([
    prisma.paymentVoucher.findMany({
      where: shown,
      orderBy: [{ createdAt: 'desc' }],
      skip: offset,
      take: limit,
      select: listSelect,
    }),
    prisma.paymentVoucher.count({ where: shown }),
    prisma.paymentVoucher.findMany({
      where: { ...where, status: 'OWED' },
      orderBy: [{ collectedOn: 'asc' }, { createdAt: 'asc' }],
      select: listSelect,
    }),
  ]);
  const owedFils = owed.reduce(
    (sum, voucher) => sum + toFils(voucher.collectedAmount?.toString() ?? '0'),
    0,
  );
  return {
    // Outside work whose expense was voided on its own is no longer paid.
    vouchers: rows.map((row) => ({
      ...row,
      status: row.expense?.status === 'VOID' ? ('VOID' as const) : row.status,
    })),
    total,
    owed,
    owedTotal: filsToString(owedFils),
    canCreate: hasPermission(user, 'payment_voucher.create'),
    canVoid: hasPermission(user, 'payment_voucher.delete'),
  };
}

export type PaymentVoucherRow = Awaited<ReturnType<typeof listPaymentVouchers>>['vouchers'][number];

/** One voucher in full: what was paid and how, its expense, its entries and its history. */
export async function getPaymentVoucher(user: AuthenticatedUser, voucherId: string) {
  requirePermission(user, 'payment_voucher.view');
  const voucher = await prisma.paymentVoucher.findFirst({
    where: { id: voucherId, organizationId: user.organizationId },
    include: {
      branch: { select: { name: true } },
      cardAccount: { select: { accountCode: true, accountName: true } },
      paidFrom: { select: { accountCode: true, accountName: true } },
      createdBy: { select: { fullName: true } },
      expense: {
        select: {
          id: true,
          expenseNumber: true,
          status: true,
          chartOfAccount: { select: { accountCode: true, accountName: true } },
          jobCard: {
            select: { id: true, jobNumber: true, vehicle: { select: { plateNumber: true } } },
          },
          invoice: { select: { id: true, invoiceNumber: true } },
        },
      },
    },
  });
  if (!voucher) throw new NotFoundError('payment voucher');
  const [entries, history] = await Promise.all([
    prisma.journalEntry.findMany({
      where: {
        organizationId: user.organizationId,
        OR: [
          { sourceType: { in: ['CARD_COLLECTION', 'PAYMENT_VOUCHER'] }, sourceId: voucher.id },
          ...(voucher.expenseId
            ? [{ sourceType: 'EXPENSE' as const, sourceId: voucher.expenseId }]
            : []),
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      select: {
        id: true,
        entryNumber: true,
        entryDate: true,
        description: true,
        reversalOfJournalEntryId: true,
        _count: { select: { reversals: true } },
        lines: {
          select: {
            debitAmount: true,
            creditAmount: true,
            chartOfAccount: { select: { accountCode: true, accountName: true } },
          },
        },
      },
    }),
    prisma.auditLog.findMany({
      where: {
        organizationId: user.organizationId,
        entityType: 'PaymentVoucher',
        entityId: voucher.id,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        action: true,
        createdAt: true,
        metadata: true,
        actorUser: { select: { fullName: true } },
      },
    }),
  ]);
  // Outside work whose expense was voided on its own is no longer paid.
  const status =
    voucher.kind === 'WORK' && voucher.expense?.status === 'VOID' ? 'VOID' : voucher.status;
  return {
    ...voucher,
    status,
    entries: entries.map((entry) => ({
      ...entry,
      superseded: entry._count.reversals > 0 || Boolean(entry.reversalOfJournalEntryId),
    })),
    history,
    canPay: status === 'OWED' && hasPermission(user, 'payment_voucher.create'),
    canVoid: status !== 'VOID' && hasPermission(user, 'payment_voucher.delete'),
  };
}

export type PaymentVoucherDetail = Awaited<ReturnType<typeof getPaymentVoucher>>;

/**
 * What the voucher forms need: how money can be paid out (never from the
 * card settlements), the card accounts card money goes into, the expense
 * accounts for outside work (sublet repairs first), the jobs, the VAT rate,
 * the bank's rate used last time, and people paid before.
 */
export async function getPaymentVoucherFormOptions(user: AuthenticatedUser) {
  requirePermission(user, 'payment_voucher.create');
  const organizationId = user.organizationId;
  await prisma.$transaction((tx) => ensureChart(tx, organizationId));
  const canRecordWork = hasPermission(user, 'expense.create');
  const [modes, receiptModes, categories, jobs, settings, lastPaid, payees] = await Promise.all([
    getPaymentModeOptions(organizationId, 'spending'),
    getPaymentModeOptions(organizationId, 'receipts'),
    prisma.chartOfAccount.findMany({
      where: { organizationId, accountType: 'EXPENSE', isActive: true },
      orderBy: { accountCode: 'asc' },
      select: { id: true, accountCode: true, accountName: true },
    }),
    canRecordWork ? listJobChoices(user) : Promise.resolve([]),
    getVatSettings(organizationId),
    prisma.paymentVoucher.findFirst({
      where: { organizationId, kind: 'CARD_COLLECTION', status: 'PAID', feeRate: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { feeRate: true },
    }),
    prisma.paymentVoucher.findMany({
      where: { organizationId, status: { not: 'VOID' } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { payeeName: true, payeePhone: true },
    }),
  ]);
  // Each card account once: where a customer's card payment goes.
  const cardAccounts = [
    ...new Map(
      receiptModes
        .filter((mode) => mode.method === 'CARD')
        .map((mode) => [mode.accountId, { id: mode.accountId, name: mode.accountName }]),
    ).values(),
  ];
  const seen = new Set<string>();
  const knownPayees = payees.filter((payee) => {
    const key = payee.payeeName.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    modes,
    cardAccounts,
    categories,
    defaultCategoryId: categories.find((account) => account.accountCode === '5020')?.id ?? '',
    jobs,
    vatRate: settings.vatRate,
    lastFeeRate: lastPaid?.feeRate?.toString().replace(/\.?0+$/, '') ?? '',
    payees: knownPayees.slice(0, 50),
    canRecordWork,
  };
}

export type PaymentVoucherFormOptions = Awaited<ReturnType<typeof getPaymentVoucherFormOptions>>;
