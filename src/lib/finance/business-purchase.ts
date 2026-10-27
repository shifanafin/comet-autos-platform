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

/*
 * Buying the business — money a partner paid, out of their own pocket, for
 * the company itself: the price to its previous owner, and the fees of
 * transferring it (Tasheel, the agreement's typing).
 *
 * The partners bought the company; the company paid and received nothing.
 * So none of this is in the company's books: no journal entry, no expense,
 * no asset, nothing for VAT or corporate tax. It is a record of each
 * partner's investment, kept beside the money they put INTO the company
 * (Owner's money, which is in the books) so the whole of what each partner
 * has invested shows in one place.
 *
 * A mistake is voided (kept on record), never edited.
 */

const MONEY = /^\d{1,9}(\.\d{1,2})?$/;

const recordSchema = z.object({
  partnerId: z.uuid({ error: 'Choose the partner who paid.' }),
  amount: z
    .string({ error: 'Enter the amount.' })
    .trim()
    .refine((value) => MONEY.test(value), 'Enter the amount like 10000 or 381.78.'),
  paidOn: z.string({ error: 'Enter the date.' }).trim().min(1, 'Enter the date.'),
  paidTo: z
    .string({ error: 'Say who it was paid to.' })
    .trim()
    .min(2, 'Say who it was paid to.')
    .max(120, 'Keep it under 120 characters.'),
  description: z
    .string({ error: 'Say what it was for.' })
    .trim()
    .min(2, 'Say what it was for.')
    .max(200, 'Keep it under 200 characters.'),
  reference: z.string().trim().max(60, 'Keep the reference under 60 characters.').optional(),
  notes: z.string().trim().max(500, 'Keep the notes under 500 characters.').optional(),
  requestKey: z.string().optional(),
});

/** Records a payment a partner made to buy the business. Books nothing. */
export async function recordBusinessPurchasePayment(user: AuthenticatedUser, rawInput: unknown) {
  const input = parseInput(recordSchema, rawInput);
  requirePermission(user, 'money.create');
  const amountFils = toFils(input.amount);
  if (amountFils <= 0) throw new DomainError('Enter an amount above zero.', 'amount');
  const paidOn = parseCalendarDate(input.paidOn);
  if (!paidOn || input.paidOn > localDateString()) {
    throw new DomainError('Enter the date — not a future one.', 'paidOn');
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'business_purchase.record');
    const partner = await tx.partner.findFirst({
      where: { id: input.partnerId, organizationId: user.organizationId, isActive: true },
      select: { id: true, name: true },
    });
    if (!partner) throw new DomainError('Choose a partner from the list.', 'partnerId');
    const row = await tx.businessPurchasePayment.create({
      data: {
        organizationId: user.organizationId,
        partnerId: partner.id,
        amount: filsToString(amountFils),
        paidOn,
        paidTo: input.paidTo,
        description: input.description,
        reference: input.reference || null,
        notes: input.notes || null,
        createdByUserId: user.id,
      },
      select: { id: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'business_purchase.recorded',
      entityType: 'BusinessPurchasePayment',
      entityId: row.id,
      afterData: {
        partner: partner.name,
        amount: filsToString(amountFils),
        paidOn: input.paidOn,
        paidTo: input.paidTo,
        description: input.description,
        reference: input.reference || null,
      },
    });
    await settleRequestKey(tx, user, rawInput, row.id);
    return row;
  });
}

/** One payment as its edit form needs it — only one that stands. */
export async function getBusinessPurchasePayment(user: AuthenticatedUser, id: string) {
  requirePermission(user, 'money.view');
  const row = await prisma.businessPurchasePayment.findFirst({
    where: { id, organizationId: user.organizationId, voidedAt: null },
    select: {
      id: true,
      partnerId: true,
      amount: true,
      paidOn: true,
      paidTo: true,
      description: true,
      reference: true,
      notes: true,
    },
  });
  if (!row) throw new NotFoundError('payment');
  return {
    ...row,
    amount: row.amount.toFixed(2),
    paidOn: row.paidOn.toISOString().slice(0, 10),
    reference: row.reference ?? '',
    notes: row.notes ?? '',
  };
}

export type BusinessPurchaseEntry = Awaited<ReturnType<typeof getBusinessPurchasePayment>>;

/** Corrects a payment where it stands; the audit log keeps what it said before. Books nothing. */
export async function updateBusinessPurchasePayment(
  user: AuthenticatedUser,
  id: string,
  rawInput: unknown,
) {
  const input = parseInput(recordSchema, rawInput);
  requirePermission(user, 'money.create');
  const amountFils = toFils(input.amount);
  if (amountFils <= 0) throw new DomainError('Enter an amount above zero.', 'amount');
  const paidOn = parseCalendarDate(input.paidOn);
  if (!paidOn || input.paidOn > localDateString()) {
    throw new DomainError('Enter the date — not a future one.', 'paidOn');
  }

  return prisma.$transaction(async (tx) => {
    const before = await tx.businessPurchasePayment.findFirst({
      where: { id, organizationId: user.organizationId },
      select: {
        id: true,
        voidedAt: true,
        partnerId: true,
        amount: true,
        paidOn: true,
        paidTo: true,
        description: true,
        reference: true,
        notes: true,
      },
    });
    if (!before) throw new NotFoundError('payment');
    if (before.voidedAt) throw new DomainError('A void payment can’t be changed.');
    const partner = await tx.partner.findFirst({
      where: { id: input.partnerId, organizationId: user.organizationId, isActive: true },
      select: { id: true, name: true },
    });
    if (!partner) throw new DomainError('Choose a partner from the list.', 'partnerId');
    await tx.businessPurchasePayment.update({
      where: { id },
      data: {
        partnerId: partner.id,
        amount: filsToString(amountFils),
        paidOn,
        paidTo: input.paidTo,
        description: input.description,
        reference: input.reference || null,
        notes: input.notes || null,
      },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'business_purchase.corrected',
      entityType: 'BusinessPurchasePayment',
      entityId: id,
      beforeData: {
        partnerId: before.partnerId,
        amount: before.amount.toString(),
        paidOn: before.paidOn.toISOString().slice(0, 10),
        paidTo: before.paidTo,
        description: before.description,
        reference: before.reference,
        notes: before.notes,
      },
      afterData: {
        partner: partner.name,
        amount: filsToString(amountFils),
        paidOn: input.paidOn,
        paidTo: input.paidTo,
        description: input.description,
        reference: input.reference || null,
        notes: input.notes || null,
      },
    });
    return { id };
  });
}

const voidSchema = z.object({
  reason: z.string({ error: 'Say why.' }).trim().min(3, 'Say why, in a few words.').max(300),
  requestKey: z.string().optional(),
});

/** Withdraws a payment entered by mistake: kept on record, counted for nothing. */
export async function voidBusinessPurchasePayment(
  user: AuthenticatedUser,
  id: string,
  rawInput: unknown,
) {
  const input = parseInput(voidSchema, rawInput);
  requirePermission(user, 'money.delete');
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'business_purchase.void');
    const row = await tx.businessPurchasePayment.findFirst({
      where: { id, organizationId: user.organizationId },
      select: { id: true, voidedAt: true, amount: true, description: true },
    });
    if (!row) throw new NotFoundError('payment');
    if (row.voidedAt) throw new DomainError('This payment is already void.');
    await tx.businessPurchasePayment.update({
      where: { id: row.id },
      data: { voidedAt: new Date(), voidReason: input.reason },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      actorUserId: user.id,
      action: 'business_purchase.voided',
      entityType: 'BusinessPurchasePayment',
      entityId: row.id,
      beforeData: { amount: row.amount.toString(), description: row.description },
      metadata: { reason: input.reason },
    });
    await settleRequestKey(tx, user, rawInput, row.id);
    return row;
  });
}

/** Every payment made to buy the business, and each partner's total of them. */
export async function listBusinessPurchasePayments(user: AuthenticatedUser) {
  requirePermission(user, 'money.view');
  const rows = await prisma.businessPurchasePayment.findMany({
    where: { organizationId: user.organizationId },
    orderBy: [{ paidOn: 'asc' }, { createdAt: 'asc' }],
    select: {
      id: true,
      amount: true,
      paidOn: true,
      paidTo: true,
      description: true,
      reference: true,
      notes: true,
      voidedAt: true,
      voidReason: true,
      partner: { select: { id: true, name: true } },
    },
  });
  const byPartner = new Map<string, number>();
  let totalFils = 0;
  for (const row of rows) {
    if (row.voidedAt) continue;
    const fils = toFils(row.amount.toString());
    totalFils += fils;
    byPartner.set(row.partner.id, (byPartner.get(row.partner.id) ?? 0) + fils);
  }
  return {
    rows: rows.map((row) => ({ ...row, amount: row.amount.toString() })),
    total: filsToString(totalFils),
    /** Fils, per partner id. */
    byPartner,
    canRecord: hasPermission(user, 'money.create'),
    canVoid: hasPermission(user, 'money.delete'),
    canEdit: hasPermission(user, 'money.create'),
  };
}
