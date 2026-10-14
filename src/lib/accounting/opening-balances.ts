import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import type { AccountRole } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput, ValidationError } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { filsToString, toFils } from '@/lib/money';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { allocateDocumentNumber } from '@/lib/numbering';
import { emptyToNull } from '@/lib/normalize';
import { ensureChart } from '@/lib/accounting/chart';
import {
  amendEntry,
  bookEntry,
  deleteEntry,
  renumberJournal,
  reverseEntry,
  syncPosting,
  whyNotCorrectable,
} from '@/lib/accounting/journal';
import { voidInvoice } from '@/lib/billing/invoice-changes';

/*
 * Opening balances — where the books start.
 *
 * Every balance the workshop had on the day before it began keeping its books
 * here is entered once, all on one date (Organization.openingBalanceDate):
 *
 *   GENERAL ACCOUNTS  cash, bank, prepayments, loans, capital… entered as a
 *                     trial balance and booked as ONE journal entry (source
 *                     OPENING_BALANCE). Whatever does not balance goes to
 *                     Opening balance equity, which the accountant clears to
 *                     capital or retained earnings once everything is in.
 *                     Saving again reverses the standing entry and books the
 *                     new one — never an edit.
 *
 *   CUSTOMERS         what each customer owed, as an opening balance invoice
 *                     (OB-…): Dr Trade receivables, Cr Opening balance
 *                     equity. Receipts are taken against it like any invoice,
 *                     so it ages, appears on the customer's statement and
 *                     clears when paid. No VAT: the VAT was on the original
 *                     invoices, before the books began.
 *
 * Some balance-sheet accounts are not typed here, because a record already
 * carries them and typing them again would count them twice:
 *
 *   Trade receivables   the customer opening balances below
 *   Trade payables      supplier opening balances (with supplier bills)
 *   Inventory           each part's opening stock (Inventory)
 *   Fixed assets        the register (Fixed assets → owned before the books began)
 *   Opening balance equity  the balancing figure itself
 */

const MANAGED_ROLES: Partial<Record<AccountRole, string>> = {
  ACCOUNTS_RECEIVABLE: 'From the customer opening balances below',
  ACCOUNTS_PAYABLE: 'From supplier opening balances',
  INVENTORY: 'From each part’s opening stock',
  OPENING_BALANCE: 'The balancing figure',
  VAT_SETTLEMENT: 'From VAT returns filed',
};

const amountText = z
  .string()
  .trim()
  .refine(
    (value) => value === '' || /^\d{1,11}(\.\d{1,2})?$/.test(value),
    'Enter an amount like 2500 or 2500.50.',
  );

const saveSchema = z.object({
  date: z
    .string({ error: 'Choose the opening date.' })
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the opening date.'),
  lines: z
    .array(
      z.object({
        accountId: z.uuid(),
        debit: amountText.optional(),
        credit: amountText.optional(),
      }),
    )
    .max(500),
  requestKey: z.string().optional(),
});

const customerSchema = z.object({
  customerId: z.string({ error: 'Choose the customer.' }).trim().min(1, 'Choose the customer.'),
  amount: z
    .string({ error: 'Enter what the customer owed.' })
    .trim()
    .regex(/^\d{1,11}(\.\d{1,2})?$/, 'Enter an amount like 1250.00.'),
  dueDate: z
    .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.')])
    .optional(),
  reference: z.string().trim().max(200).optional(),
  requestKey: z.string().optional(),
});

/** The opening entry standing now: booked, and not since reversed. */
async function standingOpening(organizationId: string, client: typeof prisma | Tx = prisma) {
  return client.journalEntry.findFirst({
    where: {
      organizationId,
      sourceType: 'OPENING_BALANCE',
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

type Tx = Prisma.TransactionClient;

/** Accounts carried by a register, keyed to why they can't be typed here. */
async function managedAccounts(organizationId: string, client: typeof prisma | Tx = prisma) {
  const [roles, assets] = await Promise.all([
    client.chartOfAccount.findMany({
      where: { organizationId, role: { in: Object.keys(MANAGED_ROLES) as AccountRole[] } },
      select: { id: true, role: true },
    }),
    client.fixedAsset.findMany({
      where: { organizationId },
      select: { assetAccountId: true, accumulatedAccountId: true },
    }),
  ]);
  const managed = new Map<string, string>();
  for (const account of roles) managed.set(account.id, MANAGED_ROLES[account.role!]!);
  for (const asset of assets) {
    managed.set(asset.assetAccountId, 'From the fixed asset register');
    managed.set(asset.accumulatedAccountId, 'From the fixed asset register');
  }
  return managed;
}

/** The day before the earliest entry, or 1 January this year when the books are empty. */
async function suggestedDate(organizationId: string) {
  const first = await prisma.journalEntry.findFirst({
    where: { organizationId, sourceType: { notIn: ['OPENING_BALANCE', 'YEAR_END_CLOSE'] } },
    orderBy: { entryDate: 'asc' },
    select: { entryDate: true },
  });
  if (!first) return `${localDateString().slice(0, 4)}-01-01`;
  return new Date(first.entryDate.getTime() - 86_400_000).toISOString().slice(0, 10);
}

// ─── Reading ────────────────────────────────────────────────────────────────

export async function getOpeningBalances(user: AuthenticatedUser) {
  requirePermission(user, 'accounting.view');
  const organizationId = user.organizationId;

  const [organization, accounts, standing, managed, customers, earliest] = await Promise.all([
    prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { openingBalanceDate: true, booksClosedThrough: true },
    }),
    prisma.chartOfAccount.findMany({
      where: { organizationId, accountType: { in: ['ASSET', 'LIABILITY', 'EQUITY'] } },
      orderBy: { accountCode: 'asc' },
      select: {
        id: true,
        accountCode: true,
        accountName: true,
        accountType: true,
        isActive: true,
        role: true,
      },
    }),
    standingOpening(organizationId),
    managedAccounts(organizationId),
    prisma.invoice.findMany({
      where: {
        organizationId,
        invoiceType: 'OPENING_BALANCE',
        status: { notIn: ['VOID', 'CANCELLED'] },
      },
      orderBy: { invoiceNumber: 'asc' },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        totalAmount: true,
        dueDate: true,
        notes: true,
        customer: { select: { id: true, name: true, phone: true } },
        payments: { select: { id: true, amount: true, status: true, reversalOfPaymentId: true } },
      },
    }),
    prisma.journalEntry.findFirst({
      where: { organizationId, sourceType: { notIn: ['OPENING_BALANCE', 'YEAR_END_CLOSE'] } },
      orderBy: { entryDate: 'asc' },
      select: { entryDate: true },
    }),
  ]);

  const booked = new Map<string, number>();
  for (const line of standing?.lines ?? []) {
    const net = toFils(line.debitAmount.toString()) - toFils(line.creditAmount.toString());
    booked.set(line.chartOfAccountId, (booked.get(line.chartOfAccountId) ?? 0) + net);
  }

  const rows = accounts
    .filter((account) => account.isActive || booked.has(account.id))
    .map((account) => {
      const net = booked.get(account.id) ?? 0;
      return {
        id: account.id,
        code: account.accountCode,
        name: account.accountName,
        type: account.accountType,
        managed: managed.get(account.id) ?? null,
        debit: net > 0 ? filsToString(net) : '',
        credit: net < 0 ? filsToString(-net) : '',
      };
    });

  const customerRows = customers.map((invoice) => {
    const reversed = new Set(invoice.payments.map((p) => p.reversalOfPaymentId).filter(Boolean));
    const paid = invoice.payments
      .filter((p) => p.status === 'COMPLETED' && !p.reversalOfPaymentId && !reversed.has(p.id))
      .reduce((sum, p) => sum + toFils(p.amount.toString()), 0);
    return {
      id: invoice.id,
      number: invoice.invoiceNumber,
      status: invoice.status,
      customer: invoice.customer,
      amount: invoice.totalAmount.toString(),
      received: filsToString(paid),
      dueDate: invoice.dueDate,
      reference: invoice.notes,
    };
  });
  const customerFils = customers.reduce((sum, i) => sum + toFils(i.totalAmount.toString()), 0);

  const date = organization.openingBalanceDate?.toISOString().slice(0, 10) ?? null;
  return {
    date,
    suggestedDate: date ?? (await suggestedDate(organizationId)),
    closedThrough: organization.booksClosedThrough?.toISOString().slice(0, 10) ?? null,
    entryNumber: standing?.entryNumber ?? null,
    /** Transactions dated on or before the opening date would be counted twice. */
    earlierActivity:
      date && earliest && earliest.entryDate.toISOString().slice(0, 10) <= date
        ? earliest.entryDate.toISOString().slice(0, 10)
        : null,
    rows,
    customers: customerRows,
    customerTotal: filsToString(customerFils),
  };
}

export type OpeningBalances = Awaited<ReturnType<typeof getOpeningBalances>>;

// ─── General accounts ───────────────────────────────────────────────────────

/**
 * Books the general accounts' opening balances: one entry, the difference to
 * opening balance equity. Replaces the standing entry (by reversal) when the
 * figures change; changes nothing when they don't.
 */
export async function saveOpeningBalances(user: AuthenticatedUser, rawInput: unknown) {
  requirePermission(user, 'accounting.edit');
  const input = parseInput(saveSchema, rawInput);
  const date = parseCalendarDate(input.date);
  if (!date) throw new DomainError('Choose a valid opening date.', 'date');
  if (input.date > localDateString()) {
    throw new DomainError('The opening date can’t be in the future.', 'date');
  }

  const errors: Record<string, string> = {};
  const typed = input.lines
    .map((line, index) => {
      const debit = line.debit ? toFils(line.debit) : 0;
      const credit = line.credit ? toFils(line.credit) : 0;
      if (debit > 0 && credit > 0) {
        errors[`lines.${index}`] = 'Enter a debit or a credit on an account — not both.';
      }
      return { accountId: line.accountId, debit, credit };
    })
    .filter((line) => line.debit > 0 || line.credit > 0);
  if (Object.keys(errors).length) throw new ValidationError(errors);

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'opening.save');
    await tx.$executeRaw`SELECT id FROM organizations WHERE id = ${user.organizationId}::uuid FOR UPDATE`;
    const roles = await ensureChart(tx, user.organizationId);
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: { openingBalanceDate: true },
    });
    await assertDateChangeAllowed(tx, user.organizationId, organization.openingBalanceDate, date);

    const [accounts, managed] = await Promise.all([
      tx.chartOfAccount.findMany({
        where: { organizationId: user.organizationId, id: { in: typed.map((l) => l.accountId) } },
        select: { id: true, accountType: true, accountName: true, isActive: true },
      }),
      managedAccounts(user.organizationId, tx),
    ]);
    const known = new Map(accounts.map((account) => [account.id, account]));
    for (const line of typed) {
      const account = known.get(line.accountId);
      if (!account)
        throw new DomainError('One of the accounts was not found. Refresh and try again.');
      if (account.accountType === 'REVENUE' || account.accountType === 'EXPENSE') {
        throw new DomainError(
          `“${account.accountName}” is an income or expense account. Opening balances are for balance-sheet accounts; last year’s profit belongs in retained earnings.`,
        );
      }
      if (managed.has(account.id)) {
        throw new DomainError(
          `“${account.accountName}”: ${managed.get(account.id)!.toLowerCase()}.`,
        );
      }
      if (!account.isActive) {
        throw new DomainError(`“${account.accountName}” is retired. Reactivate it first.`);
      }
    }

    const debits = typed.reduce((sum, line) => sum + line.debit, 0);
    const credits = typed.reduce((sum, line) => sum + line.credit, 0);
    const lines = typed.map((line) => ({ ...line, memo: null as string | null }));
    if (debits !== credits) {
      lines.push({
        accountId: roles.OPENING_BALANCE,
        debit: debits < credits ? credits - debits : 0,
        credit: debits > credits ? debits - credits : 0,
        memo: 'Balancing figure',
      });
    }

    const standing = await standingOpening(user.organizationId, tx);
    const same =
      standing &&
      standing.entryDate.getTime() === date.getTime() &&
      signature(
        standing.lines.map((l) => ({
          accountId: l.chartOfAccountId,
          debit: toFils(l.debitAmount.toString()),
          credit: toFils(l.creditAmount.toString()),
        })),
      ) === signature(lines);

    let entryId = standing?.id ?? null;
    let entryNumber = standing?.entryNumber ?? null;
    // While the period is open the opening entry is corrected where it stands.
    const correctable = standing && !same && !(await whyNotCorrectable(tx, standing, date));
    if (standing && correctable && lines.length) {
      await amendEntry(tx, standing, {
        date,
        description: `Opening balances as at ${input.date}`,
        lines,
        actorUserId: user.id,
        reason: 'opening balances re-entered',
      });
      await renumberJournal(tx, user.organizationId);
      entryNumber = (await tx.journalEntry.findUniqueOrThrow({ where: { id: standing.id } }))
        .entryNumber;
    } else if (standing && correctable) {
      await deleteEntry(tx, standing, user.id, 'opening balances cleared');
      entryId = null;
      entryNumber = null;
    } else if (!same) {
      if (standing) {
        await reverseEntry(
          tx,
          standing,
          standing.entryDate,
          user.id,
          'opening balances re-entered',
        );
      }
      entryId = null;
      entryNumber = null;
      if (lines.length) {
        const booked = await bookEntry(tx, {
          organizationId: user.organizationId,
          branchId: null,
          date,
          description: `Opening balances as at ${input.date}`,
          lines,
          sourceType: 'OPENING_BALANCE',
          sourceId: null,
          actorUserId: user.id,
        });
        entryId = booked.id;
        entryNumber = booked.entryNumber;
      }
    }
    await tx.organization.update({
      where: { id: user.organizationId },
      data: { openingBalanceDate: date },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'opening_balances.saved',
      entityType: 'Organization',
      entityId: user.organizationId,
      beforeData: {
        openingBalanceDate: organization.openingBalanceDate?.toISOString().slice(0, 10) ?? null,
        entryNumber: standing?.entryNumber ?? null,
      },
      afterData: {
        openingBalanceDate: input.date,
        entryNumber,
        debits: filsToString(debits),
        credits: filsToString(credits),
        toOpeningEquity: filsToString(debits - credits),
      },
    });
    await settleRequestKey(tx, user, rawInput, entryId ?? user.organizationId);
    return { entryNumber, changed: !same };
  });
}

function signature(lines: { accountId: string; debit: number; credit: number }[]) {
  return lines
    .filter((l) => l.debit || l.credit)
    .map((l) => `${l.accountId}:${l.debit}:${l.credit}`)
    .sort()
    .join('|');
}

/**
 * The opening date is shared by everything opened on it. It can move only
 * while no customer opening balance holds it.
 */
async function assertDateChangeAllowed(
  tx: Tx,
  organizationId: string,
  current: Date | null,
  next: Date,
) {
  if (!current || current.getTime() === next.getTime()) return;
  const held = await tx.invoice.count({
    where: {
      organizationId,
      invoiceType: 'OPENING_BALANCE',
      status: { notIn: ['VOID', 'CANCELLED'] },
    },
  });
  if (held > 0) {
    throw new DomainError(
      `Customer opening balances are dated ${current.toISOString().slice(0, 10)}. Remove them before changing the opening date.`,
      'date',
    );
  }
}

// ─── Customers ──────────────────────────────────────────────────────────────

/** Records what one customer owed on the opening date. One per customer. */
export async function addCustomerOpeningBalance(user: AuthenticatedUser, rawInput: unknown) {
  requirePermission(user, 'accounting.edit');
  const input = parseInput(customerSchema, rawInput);
  const amount = toFils(input.amount);
  if (amount <= 0) throw new DomainError('The amount must be more than zero.', 'amount');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'opening.customer');
    const organization = await tx.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: {
        openingBalanceDate: true,
        name: true,
        legalName: true,
        taxNumber: true,
        address: true,
      },
    });
    const date = organization.openingBalanceDate;
    if (!date) {
      throw new DomainError('Save the opening date (with the account balances) first.');
    }
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, organizationId: user.organizationId, isActive: true },
      select: { id: true, name: true, taxNumber: true, address: true },
    });
    if (!customer) throw new DomainError('Choose a customer from the list.', 'customerId');
    const existing = await tx.invoice.findFirst({
      where: {
        organizationId: user.organizationId,
        customerId: customer.id,
        invoiceType: 'OPENING_BALANCE',
        status: { notIn: ['VOID', 'CANCELLED'] },
      },
      select: { invoiceNumber: true },
    });
    if (existing) {
      throw new DomainError(
        `${customer.name} already has opening balance ${existing.invoiceNumber}. Remove it to enter a different amount.`,
        'customerId',
      );
    }
    const branch =
      user.primaryBranchId ??
      (
        await tx.branch.findFirstOrThrow({
          where: { organizationId: user.organizationId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      ).id;
    const dueDate = input.dueDate ? parseCalendarDate(input.dueDate) : date;
    if (!dueDate) throw new DomainError('Enter a valid due date.', 'dueDate');

    const invoiceNumber = await allocateDocumentNumber(
      tx,
      user.organizationId,
      branch,
      'OPENING_BALANCE',
    );
    const text = filsToString(amount);
    const invoice = await tx.invoice.create({
      data: {
        organizationId: user.organizationId,
        branchId: branch,
        customerId: customer.id,
        invoiceType: 'OPENING_BALANCE',
        invoiceNumber,
        status: 'ISSUED',
        issueDate: date,
        dueDate,
        subtotal: text,
        taxAmount: '0.00',
        totalAmount: text,
        notes: emptyToNull(input.reference),
        sellerLegalName: organization.legalName ?? organization.name,
        sellerTaxNumber: organization.taxNumber,
        sellerAddress: organization.address,
        customerName: customer.name,
        customerTaxNumber: customer.taxNumber,
        customerAddress: customer.address,
        createdByUserId: user.id,
        issuedByUserId: user.id,
        // Midnight of the opening date in Dubai, so any receipt after it is valid.
        issuedAt: new Date(`${date.toISOString().slice(0, 10)}T00:00:00+04:00`),
      },
    });
    await tx.invoiceItem.create({
      data: {
        organizationId: user.organizationId,
        invoiceId: invoice.id,
        itemType: 'OTHER',
        description: input.reference
          ? `Balance brought forward — ${input.reference}`
          : 'Balance brought forward',
        quantity: '1.000',
        unitPrice: text,
        lineTotal: text,
        taxRate: '0.00',
        taxAmount: '0.00',
        vatTreatment: 'OUT_OF_SCOPE',
      },
    });
    await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: branch,
      actorUserId: user.id,
      action: 'opening_balances.customer_added',
      entityType: 'Invoice',
      entityId: invoice.id,
      afterData: { invoiceNumber, customerId: customer.id, amount: text },
    });
    await settleRequestKey(tx, user, rawInput, invoice.id);
    return invoice;
  });
}

/** Removes a customer's opening balance (voids it). Refused once receipts are taken against it. */
export async function removeCustomerOpeningBalance(
  user: AuthenticatedUser,
  invoiceId: string,
  rawInput: unknown,
) {
  requirePermission(user, 'accounting.edit');
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, organizationId: user.organizationId, invoiceType: 'OPENING_BALANCE' },
    select: { id: true },
  });
  if (!invoice) throw new NotFoundError('opening balance');
  return voidInvoice(user, invoice.id, rawInput);
}
