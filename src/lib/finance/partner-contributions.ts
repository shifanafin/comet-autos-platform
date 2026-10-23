import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { filsToString, toFils } from '@/lib/money';
import { OWNER_MONEY_LABEL } from '@/lib/finance/owner-money-labels';
import { ownerMoneyWhere } from '@/lib/finance/owner-money';

/*
 * One partner's whole investment, line by line — the investments sheet for
 * one person: what they put into the company (Owner's money, in its books)
 * and what they paid to buy it (Buying the business, outside its books),
 * in date order. Void entries count for nothing and are left out.
 */

type Line = {
  id: string;
  date: Date;
  /** "books": owner's money, with its journal entry; "purchase": buying the business. */
  source: 'books' | 'purchase';
  what: string;
  detail: string;
  notes: string | null;
  journalEntry: string | null;
  /** Signed, in fils: money taken out is below zero. */
  fils: number;
  createdAt: Date;
};

const signed = (fils: number) => (fils < 0 ? `-${filsToString(-fils)}` : filsToString(fils));

export async function getPartnerContributions(user: AuthenticatedUser, partnerId: string) {
  requirePermission(user, 'money.view');
  const organizationId = user.organizationId;
  const partner = await prisma.partner.findFirst({
    where: { id: partnerId, organizationId },
    select: { id: true, name: true, isActive: true },
  });
  if (!partner) throw new NotFoundError('partner');

  const [money, purchase] = await Promise.all([
    prisma.ownerMoney.findMany({
      where: { organizationId, partnerId, status: 'POSTED' },
      select: {
        id: true,
        entryNumber: true,
        kind: true,
        amount: true,
        movedOn: true,
        reference: true,
        notes: true,
        createdAt: true,
        account: {
          select: { accountName: true, isPaymentAccount: true, accountType: true },
        },
      },
    }),
    prisma.businessPurchasePayment.findMany({
      where: { organizationId, partnerId, voidedAt: null },
      select: {
        id: true,
        amount: true,
        paidOn: true,
        paidTo: true,
        description: true,
        reference: true,
        notes: true,
        createdAt: true,
      },
    }),
  ]);
  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId,
      sourceType: 'OWNER_MONEY',
      sourceId: { in: money.map((row) => row.id) },
      reversalOfJournalEntryId: null,
    },
    select: { sourceId: true, entryNumber: true },
  });
  const entryOf = new Map(entries.map((entry) => [entry.sourceId, entry.entryNumber]));

  const lines: Line[] = [
    ...money.map((row) => {
      const fils = toFils(row.amount.toString());
      return {
        id: row.id,
        date: row.movedOn,
        source: 'books' as const,
        what: OWNER_MONEY_LABEL[row.kind],
        detail: `${row.entryNumber} · ${ownerMoneyWhere(row.kind, row.account)}${row.reference ? ` · ref ${row.reference}` : ''}`,
        notes: row.notes,
        journalEntry: entryOf.get(row.id) ?? null,
        fils: row.kind === 'DRAWINGS' ? -fils : fils,
        createdAt: row.createdAt,
      };
    }),
    ...purchase.map((row) => ({
      id: row.id,
      date: row.paidOn,
      source: 'purchase' as const,
      what: row.description,
      detail: `To ${row.paidTo}${row.reference ? ` · ref ${row.reference}` : ''}`,
      notes: row.notes,
      journalEntry: null,
      fils: toFils(row.amount.toString()),
      createdAt: row.createdAt,
    })),
  ].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || a.createdAt.getTime() - b.createdAt.getTime(),
  );

  const sum = (pick: (row: (typeof money)[number]) => boolean) =>
    money.filter(pick).reduce((total, row) => total + toFils(row.amount.toString()), 0);
  const capitalIn = sum((row) => row.kind === 'CAPITAL_IN');
  const loansIn = sum((row) => row.kind === 'LOAN_IN');
  const drawings = sum((row) => row.kind === 'DRAWINGS');
  const inBusiness = capitalIn + loansIn - drawings;
  const bought = purchase.reduce((total, row) => total + toFils(row.amount.toString()), 0);

  // The running total after each line, as the sheet keeps it.
  let running = 0;
  return {
    partner,
    lines: lines.map((line) => {
      running += line.fils;
      return {
        id: line.id,
        date: line.date,
        source: line.source,
        what: line.what,
        detail: line.detail,
        notes: line.notes,
        journalEntry: line.journalEntry,
        amount: signed(line.fils),
        runningTotal: signed(running),
      };
    }),
    totals: {
      capitalIn: filsToString(capitalIn),
      loansIn: filsToString(loansIn),
      drawings: filsToString(drawings),
      inBusiness: signed(inBusiness),
      bought: filsToString(bought),
      invested: signed(inBusiness + bought),
    },
  };
}
