import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
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
import { getTaxCodeOptions, resolveTaxCode } from '@/lib/accounting/tax-codes';
import { vatIncluded } from '@/lib/billing/advance-vat';
import { getVatSettings } from '@/lib/tax';
import { getTransferAccounts } from '@/lib/finance/money';

/*
 * Rent & other income (INC-) — money the business receives that is not from
 * its workshop work: the rent of its premises' space, a commission, scrap
 * sold. Kept apart from the workshop's tax invoices (INV-): no customer
 * record, no job, no parts — who paid, what for, how much, into which cash
 * or bank account, and the income account it books to.
 *
 * The amount is what was received, VAT included at its tax code's rate:
 *
 *   Dr the cash or bank account    amount
 *   Cr the income account          amount less VAT
 *   Cr Output VAT payable          the VAT inside it
 *
 * It is in the VAT return on the day received (the date of supply for money
 * received first). Its receipt, printed from the record, carries what a
 * simplified tax invoice must show — the business, its TRN, the date, what
 * for, the total and the VAT. Never edited: a mistake is voided, which
 * reverses its entry.
 */

type Tx = Prisma.TransactionClient;

/** Only the business's own cash, petty cash and bank — never card settlements. */
const OWN_MONEY = new Set(['cash', 'petty', 'bank', 'other']);

/** Income accounts it can book to: not the workshop's sales, discounts or round-offs. */
async function incomeAccounts(client: Tx | typeof prisma, organizationId: string) {
  const rows = await client.chartOfAccount.findMany({
    where: {
      organizationId,
      accountType: 'REVENUE',
      isActive: true,
      OR: [{ role: null }, { role: { in: ['OTHER_INCOME', 'SALES_OTHER'] } }],
    },
    orderBy: { accountCode: 'asc' },
    select: { id: true, accountCode: true, accountName: true, role: true },
  });
  return rows;
}

/** What the form needs: income accounts, money accounts and tax codes, with sensible defaults. */
export async function getOtherIncomeForm(user: AuthenticatedUser) {
  requirePermission(user, 'money.view');
  const [income, money, taxCodes, settings, outputVat] = await Promise.all([
    incomeAccounts(prisma, user.organizationId),
    getTransferAccounts(user),
    getTaxCodeOptions(user.organizationId, 'sales'),
    getVatSettings(user.organizationId),
    prisma.chartOfAccount.findFirst({
      where: { organizationId: user.organizationId, role: 'VAT_OUTPUT' },
      select: { accountCode: true, accountName: true },
    }),
  ]);
  const rent = income.find((account) => /rent/i.test(account.accountName));
  const other = income.find((account) => account.role === 'OTHER_INCOME');
  return {
    incomeAccounts: income.map((account) => ({
      id: account.id,
      code: account.accountCode,
      name: account.accountName,
    })),
    moneyAccounts: money.filter((account) => OWN_MONEY.has(account.kind)),
    taxCodes,
    registered: settings.isVatRegistered,
    outputVat: { code: outputVat?.accountCode ?? '', name: outputVat?.accountName ?? 'Output VAT' },
    defaults: {
      incomeAccountId: rent?.id ?? other?.id ?? income[0]?.id ?? '',
      accountId: money.find((account) => account.kind === 'cash')?.id ?? '',
      taxCodeId: taxCodes.find((code) => code.isDefault)?.id ?? taxCodes[0]?.id ?? '',
    },
    today: localDateString(),
  };
}

export type OtherIncomeForm = Awaited<ReturnType<typeof getOtherIncomeForm>>;

const recordSchema = z.object({
  receivedOn: z
    .string({ error: 'Enter the date it was received.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date it was received.'),
  receivedFrom: z
    .string({ error: 'Enter who paid it.' })
    .trim()
    .min(2, 'Enter who paid it.')
    .max(120, 'Keep the name under 120 characters.'),
  description: z
    .string({ error: 'Say what it was for.' })
    .trim()
    .min(3, 'Say what it was for, e.g. Rent — workshop space, October 2026.')
    .max(200, 'Keep it under 200 characters.'),
  incomeAccountId: z.uuid({ error: 'Choose the income account.' }),
  accountId: z.uuid({ error: 'Choose where the money went.' }),
  taxCodeId: z.uuid({ error: 'Choose the VAT.' }),
  amount: z
    .string({ error: 'Enter the amount received.' })
    .trim()
    .regex(/^\d{1,9}(\.\d{1,2})?$/, 'Enter the amount like 2000 or 2000.00.'),
  reference: z.string().trim().max(60, 'Keep the reference under 60 characters.').optional(),
  notes: z.string().trim().max(500, 'Keep the notes under 500 characters.').optional(),
  requestKey: z.string().optional(),
});

/** Records money received outside the workshop's sales, and books it. */
export async function recordOtherIncome(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(recordSchema, rawInput);
  requirePermission(user, 'money.create');
  const amountFils = toFils(input.amount);
  if (amountFils <= 0) throw new DomainError('Enter an amount above zero.', 'amount');
  const receivedOn = parseCalendarDate(input.receivedOn);
  if (!receivedOn || input.receivedOn > localDateString()) {
    throw new DomainError('Enter the date — not a future one.', 'receivedOn');
  }
  const money = (await getTransferAccounts(user)).find((a) => a.id === input.accountId);
  if (!money || !OWN_MONEY.has(money.kind)) {
    throw new DomainError('Choose a cash, petty cash or bank account.', 'accountId');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'other_income.record');
    await checkMoneyAccount(tx, user.organizationId, input.accountId);
    const income = (await incomeAccounts(tx, user.organizationId)).find(
      (account) => account.id === input.incomeAccountId,
    );
    if (!income)
      throw new DomainError('Choose an income account from the list.', 'incomeAccountId');
    const code = await resolveTaxCode(tx, user.organizationId, input.taxCodeId);
    const { isVatRegistered } = await getVatSettings(user.organizationId, tx);
    const vatFils = isVatRegistered ? vatIncluded(amountFils, code.rate) : 0;
    const incomeNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      null,
      'OTHER_INCOME',
    );
    const row = await tx.otherIncome.create({
      data: {
        organizationId: user.organizationId,
        incomeNumber,
        receivedOn,
        receivedFrom: input.receivedFrom,
        description: input.description,
        incomeAccountId: income.id,
        accountId: input.accountId,
        taxCodeId: code.id,
        vatTreatment: code.treatment,
        vatRate: isVatRegistered ? code.rate : '0',
        amount: filsToString(amountFils),
        netAmount: filsToString(amountFils - vatFils),
        vatAmount: filsToString(vatFils),
        reference: input.reference || null,
        notes: input.notes || null,
        createdByUserId: user.id,
      },
      select: { id: true, incomeNumber: true },
    });
    await syncPosting(tx, user.organizationId, 'OTHER_INCOME', row.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'other_income.recorded',
      entityType: 'OtherIncome',
      entityId: row.id,
      afterData: {
        incomeNumber,
        receivedOn: input.receivedOn,
        receivedFrom: input.receivedFrom,
        description: input.description,
        incomeAccount: `${income.accountCode} ${income.accountName}`,
        accountId: input.accountId,
        taxCode: code.code,
        amount: filsToString(amountFils),
        vat: filsToString(vatFils),
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

/** Withdraws a receipt entered by mistake: kept on record, its journal entry reversed. */
export async function voidOtherIncome(user: AuthenticatedUser, id: string, rawInput: unknown) {
  const input = parseInput(voidSchema, rawInput);
  requirePermission(user, 'money.delete');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM other_income WHERE id = ${id}::uuid AND organization_id = ${user.organizationId}::uuid FOR UPDATE`;
    const row = await tx.otherIncome.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, status: true, incomeNumber: true, amount: true },
    });
    if (!row) throw new NotFoundError('income receipt');
    if (row.status === 'VOID') throw new DomainError('This receipt is already void.');
    const voidedAt = new Date();
    await tx.otherIncome.update({
      where: { id: row.id },
      data: { status: 'VOID', voidedAt, voidReason: input.reason },
    });
    await syncPosting(tx, user.organizationId, 'OTHER_INCOME', row.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'other_income.voided',
      entityType: 'OtherIncome',
      entityId: row.id,
      beforeData: { status: 'POSTED' },
      afterData: { status: 'VOID', voidedAt: voidedAt.toISOString() },
      metadata: {
        reason: input.reason,
        incomeNumber: row.incomeNumber,
        amount: row.amount.toString(),
      },
    });
    return { id: row.id };
  });
}

const SELECT = {
  id: true,
  incomeNumber: true,
  receivedOn: true,
  receivedFrom: true,
  description: true,
  amount: true,
  netAmount: true,
  vatAmount: true,
  vatRate: true,
  vatTreatment: true,
  reference: true,
  notes: true,
  status: true,
  voidReason: true,
  createdAt: true,
  incomeAccount: { select: { accountCode: true, accountName: true } },
  account: { select: { accountCode: true, accountName: true } },
  taxCode: { select: { code: true, name: true } },
  createdBy: { select: { fullName: true } },
} satisfies Prisma.OtherIncomeSelect;

/** Every receipt, newest first; and what stands this year, by income account. */
export async function listOtherIncome(user: AuthenticatedUser) {
  requirePermission(user, 'money.view');
  const rows = await prisma.otherIncome.findMany({
    where: { organizationId: user.organizationId },
    orderBy: [{ receivedOn: 'desc' }, { createdAt: 'desc' }],
    select: SELECT,
  });
  const byAccount = new Map<string, number>();
  for (const row of rows) {
    if (row.status !== 'POSTED') continue;
    const key = row.incomeAccount.accountName;
    byAccount.set(key, (byAccount.get(key) ?? 0) + toFils(row.netAmount.toString()));
  }
  return {
    rows,
    totals: [...byAccount].map(([name, fils]) => ({ name, net: filsToString(fils) })),
    canRecord: hasPermission(user, 'money.create'),
    canVoid: hasPermission(user, 'money.delete'),
  };
}

/** One receipt, with what its printed copy shows about the business. */
export async function getOtherIncome(user: AuthenticatedUser, id: string) {
  requirePermission(user, 'money.view');
  const [row, organization, settings] = await Promise.all([
    prisma.otherIncome.findFirst({
      where: { id, organizationId: user.organizationId },
      select: SELECT,
    }),
    prisma.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: { name: true, address: true, phone: true },
    }),
    getVatSettings(user.organizationId),
  ]);
  if (!row) throw new NotFoundError('income receipt');
  return {
    ...row,
    business: { ...organization, taxNumber: settings.taxNumber },
    canVoid: row.status === 'POSTED' && hasPermission(user, 'money.delete'),
  };
}
