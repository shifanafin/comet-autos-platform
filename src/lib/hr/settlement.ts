import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { filsToString, toFils } from '@/lib/money';
import { emptyToNull } from '@/lib/normalize';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { syncPosting } from '@/lib/accounting/journal';
import { checkMoneyAccount } from '@/lib/accounting/chart';
import { gratuityForServiceDaysFils } from '@/lib/hr/gratuity';
import {
  gratuityOnLeavingFils,
  leaveEncashmentFils,
  leaveLiabilityFils,
} from '@/lib/hr/leave-rules';
import { leavePosition } from '@/lib/hr/leave-ledger';

/*
 * Final settlement — what an employee is owed on leaving (Labour Law Art.
 * 51-53), due within 14 days of the contract ending:
 *
 *   end-of-service gratuity   on counted service (unpaid days excluded);
 *                             nothing under a full year (Art. 51)
 *   unused annual leave       the balance on the leaving date, at basic ÷ 30
 *   notice                    pay in lieu (+) or the notice the employee owes (−)
 *   other additions           anything else agreed
 *   less recoveries           salary advances still owed
 *
 * Their last days' salary is paid by that month's payroll, which must be run
 * and approved first: it brings the two provisions up to the leaving date, so
 * the settlement uses exactly what was set aside and books only the
 * difference (lib/accounting/postings.ts, FINAL SETTLEMENT).
 *
 *   draft → approved (booked) → paid (booked)    a draft can be recalculated;
 *   an approved one can be cancelled (its entry reversed) until it is paid.
 */

const MONEY = /^-?\d{1,9}(\.\d{1,2})?$/;
const POSITIVE = /^\d{1,9}(\.\d{1,2})?$/;
const DAY_MS = 86_400_000;
const day = (date: Date) => date.toISOString().slice(0, 10);
const signed = (value: number) => (value < 0 ? `-${filsToString(-value)}` : filsToString(value));
const fils = (value: { toString(): string } | null | undefined) => {
  if (!value) return 0;
  const text = value.toString();
  return text.startsWith('-') ? -toFils(text.slice(1)) : toFils(text);
};

export const SETTLEMENT_REASON_LABEL = {
  RESIGNATION: 'Resignation',
  TERMINATION: 'Termination by the employer',
  END_OF_CONTRACT: 'End of contract',
  OTHER: 'Other',
} as const;

const prepareSchema = z.object({
  terminationDate: z
    .string({ error: 'Choose the last working day.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose the last working day.'),
  reason: z.enum(['RESIGNATION', 'TERMINATION', 'END_OF_CONTRACT', 'OTHER'], {
    error: 'Choose why they are leaving.',
  }),
  noticePay: z
    .string()
    .trim()
    .optional()
    .refine(
      (v) => !v || MONEY.test(v),
      'Enter an amount like 1500.00 (a minus for notice they owe).',
    ),
  otherAdditions: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || POSITIVE.test(v), 'Enter an amount like 500.00.'),
  recoveries: z
    .string()
    .trim()
    .optional()
    .refine((v) => !v || POSITIVE.test(v), 'Enter an amount like 500.00.'),
  note: z.string().trim().max(500).optional(),
  requestKey: z.string().optional(),
});

/** What has been set aside for one person: the last payroll's, or what the opening balances held. */
async function provisionsHeld(
  tx: Prisma.TransactionClient,
  organizationId: string,
  employee: Parameters<typeof leavePosition>[3] & { id: string },
  basicFils: number,
) {
  const last = await tx.payrollItem.findFirst({
    where: { organizationId, employeeId: employee.id, payroll: { status: { not: 'CANCELLED' } } },
    orderBy: { payroll: { periodEnd: 'desc' } },
    select: { gratuityLiability: true, leaveLiability: true },
  });
  if (last) return { gratuity: fils(last.gratuityLiability), leave: fils(last.leaveLiability) };
  const organization = await tx.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { openingBalanceDate: true },
  });
  const booksStart = organization.openingBalanceDate;
  if (!booksStart || employee.hireDate >= booksStart) return { gratuity: 0, leave: 0 };
  const dayBefore = day(new Date(booksStart.getTime() - DAY_MS));
  const opening = await leavePosition(tx, organizationId, employee.id, employee, dayBefore);
  return {
    gratuity: gratuityForServiceDaysFils(opening.serviceDays, basicFils),
    leave: leaveLiabilityFils(Math.max(0, opening.annual.balance), basicFils),
  };
}

/** Works out (or re-works) a draft settlement for someone leaving. */
export async function prepareSettlement(
  user: AuthenticatedUser,
  employeeId: string,
  rawInput: unknown,
) {
  const input = parseInput(prepareSchema, rawInput);
  requirePermission(user, 'payroll.create');
  const terminationDate = parseCalendarDate(input.terminationDate);
  if (!terminationDate) throw new DomainError('Choose the last working day.', 'terminationDate');
  const notice = input.noticePay ? fils(input.noticePay) : 0;
  const additions = input.otherAdditions ? toFils(input.otherAdditions) : 0;
  const recoveries = input.recoveries ? toFils(input.recoveries) : 0;

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'settlement.prepare');
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, organizationId: user.organizationId },
      select: {
        id: true,
        branchId: true,
        firstName: true,
        lastName: true,
        hireDate: true,
        terminationDate: true,
        probationEndDate: true,
        leaveOpeningDays: true,
        leaveOpeningAsOf: true,
      },
    });
    if (!employee) throw new NotFoundError('employee');
    if (terminationDate < employee.hireDate) {
      throw new DomainError('The last working day is before they joined.', 'terminationDate');
    }
    const existing = await tx.finalSettlement.findFirst({
      where: { organizationId: user.organizationId, employeeId: employee.id },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== 'DRAFT' && existing.status !== 'CANCELLED') {
      throw new DomainError(
        'This settlement is already approved. Cancel it first to work it out again.',
      );
    }
    const salary = await tx.salary.findFirst({
      where: {
        organizationId: user.organizationId,
        employeeId: employee.id,
        effectiveFrom: { lte: terminationDate },
      },
      orderBy: { effectiveFrom: 'desc' },
      select: { basicSalary: true },
    });
    if (!salary) {
      throw new DomainError(
        'They have no salary on file, so nothing can be worked out. Set it first.',
      );
    }
    const basic = fils(salary.basicSalary);
    const position = await leavePosition(
      tx,
      user.organizationId,
      employee.id,
      employee,
      input.terminationDate,
    );
    const gratuity = gratuityOnLeavingFils(position.serviceDays, basic);
    const leaveDays = Math.max(0, position.annual.balance);
    const encashment = leaveEncashmentFils(leaveDays, basic);
    const held = await provisionsHeld(tx, user.organizationId, employee, basic);
    const net = gratuity + encashment + notice + additions - recoveries;
    if (net < 0) {
      throw new DomainError(
        'The recoveries are more than they are owed: recover the rest separately and enter what this settlement can cover.',
        'recoveries',
      );
    }

    // Leaving: the employee record carries the date and stops being active.
    await tx.employee.update({
      where: { id: employee.id },
      data: { terminationDate, isActive: false },
    });
    const data = {
      terminationDate,
      reason: input.reason,
      serviceDays: position.serviceDays,
      basicSalary: filsToString(basic),
      gratuity: filsToString(gratuity),
      gratuityProvision: filsToString(Math.max(0, held.gratuity)),
      leaveDays: leaveDays.toFixed(2),
      leaveEncashment: filsToString(encashment),
      leaveProvision: filsToString(Math.max(0, held.leave)),
      noticePay: signed(notice),
      otherAdditions: filsToString(additions),
      recoveries: filsToString(recoveries),
      netPayable: filsToString(net),
      note: emptyToNull(input.note),
      status: 'DRAFT' as const,
      approvedByUserId: null,
      approvedAt: null,
      paidOn: null,
      paidFromAccountId: null,
    };
    const settlement = existing
      ? await tx.finalSettlement.update({ where: { id: existing.id }, data })
      : await tx.finalSettlement.create({
          data: {
            organizationId: user.organizationId,
            employeeId: employee.id,
            createdByUserId: user.id,
            ...data,
          },
        });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: employee.branchId,
      actorUserId: user.id,
      action: existing ? 'settlement.recalculated' : 'settlement.prepared',
      entityType: 'FinalSettlement',
      entityId: settlement.id,
      afterData: { ...data, terminationDate: input.terminationDate },
    });
    await settleRequestKey(tx, user, rawInput, settlement.id);
    return settlement;
  });
}

async function loadSettlement(tx: Prisma.TransactionClient, user: AuthenticatedUser, id: string) {
  const settlement = await tx.finalSettlement.findFirst({
    where: { id, organizationId: user.organizationId },
    include: { employee: { select: { branchId: true } } },
  });
  if (!settlement) throw new NotFoundError('settlement');
  return settlement;
}

/** Signs a draft off and books it. The leaving month's payroll must be approved first. */
export async function approveSettlement(user: AuthenticatedUser, id: string) {
  requirePermission(user, 'payroll.approve');
  return prisma.$transaction(async (tx) => {
    const settlement = await loadSettlement(tx, user, id);
    if (settlement.status !== 'DRAFT')
      throw new DomainError('Only a draft settlement can be approved.');
    const lastMonth = await tx.payroll.findFirst({
      where: {
        organizationId: user.organizationId,
        status: { in: ['APPROVED', 'PAID'] },
        periodStart: { lte: settlement.terminationDate },
        periodEnd: { gte: settlement.terminationDate },
      },
      select: { id: true },
    });
    if (!lastMonth) {
      throw new DomainError(
        'Run and approve the payroll for the leaving month first: it pays their last days and brings the end-of-service and leave set aside up to the leaving date.',
      );
    }
    const updated = await tx.finalSettlement.updateMany({
      where: { id: settlement.id, status: 'DRAFT' },
      data: { status: 'APPROVED', approvedByUserId: user.id, approvedAt: new Date() },
    });
    if (updated.count === 0)
      throw new DomainError('Someone else changed this settlement just now.');
    await syncPosting(tx, user.organizationId, 'FINAL_SETTLEMENT', settlement.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: settlement.employee.branchId,
      actorUserId: user.id,
      action: 'settlement.approved',
      entityType: 'FinalSettlement',
      entityId: settlement.id,
      afterData: { status: 'APPROVED', netPayable: settlement.netPayable.toString() },
    });
    return { id: settlement.id };
  });
}

const paySchema = z.object({
  paidOn: z
    .string({ error: 'Enter the date paid.' })
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the date paid.'),
  accountId: z.union([z.literal(''), z.uuid()]).optional(),
  requestKey: z.string().optional(),
});

/** Records the approved settlement as paid, from a money account. */
export async function paySettlement(user: AuthenticatedUser, id: string, rawInput: unknown) {
  const input = parseInput(paySchema, rawInput);
  requirePermission(user, 'payroll.approve');
  const paidOn = parseCalendarDate(input.paidOn);
  if (!paidOn) throw new DomainError('Enter the date paid.', 'paidOn');
  if (input.paidOn > localDateString())
    throw new DomainError('The date can’t be in the future.', 'paidOn');

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'settlement.pay');
    const settlement = await loadSettlement(tx, user, id);
    if (settlement.status !== 'APPROVED') {
      throw new DomainError('Approve the settlement before recording it as paid.');
    }
    if (paidOn < settlement.terminationDate) {
      throw new DomainError('It can’t be paid before the leaving date.', 'paidOn');
    }
    const accountId = emptyToNull(input.accountId);
    if (accountId) await checkMoneyAccount(tx, user.organizationId, accountId);
    await tx.finalSettlement.update({
      where: { id: settlement.id },
      data: { status: 'PAID', paidOn, paidFromAccountId: accountId },
    });
    await syncPosting(tx, user.organizationId, 'FINAL_SETTLEMENT_PAYMENT', settlement.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: settlement.employee.branchId,
      actorUserId: user.id,
      action: 'settlement.paid',
      entityType: 'FinalSettlement',
      entityId: settlement.id,
      afterData: { status: 'PAID', paidOn: input.paidOn, accountId },
    });
    await settleRequestKey(tx, user, rawInput, settlement.id);
    return { id: settlement.id };
  });
}

/** Withdraws a draft, or an approved settlement not yet paid (its entry reversed). */
export async function cancelSettlement(
  user: AuthenticatedUser,
  id: string,
  input: { reason: string },
) {
  requirePermission(user, 'payroll.approve');
  const reason = input.reason?.trim();
  if (!reason || reason.length < 3)
    throw new DomainError('Say why it is being cancelled.', 'reason');
  return prisma.$transaction(async (tx) => {
    const settlement = await loadSettlement(tx, user, id);
    if (settlement.status === 'PAID') {
      throw new DomainError(
        'A paid settlement is history. Correct it with a journal entry if needed.',
      );
    }
    if (settlement.status === 'CANCELLED') return { id: settlement.id };
    await tx.finalSettlement.update({
      where: { id: settlement.id },
      data: { status: 'CANCELLED' },
    });
    await syncPosting(tx, user.organizationId, 'FINAL_SETTLEMENT', settlement.id, user.id);
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: settlement.employee.branchId,
      actorUserId: user.id,
      action: 'settlement.cancelled',
      entityType: 'FinalSettlement',
      entityId: settlement.id,
      beforeData: { status: settlement.status },
      afterData: { status: 'CANCELLED' },
      metadata: { reason },
    });
    return { id: settlement.id };
  });
}

/** One settlement, as its page shows it. */
export async function getSettlement(user: AuthenticatedUser, id: string) {
  requirePermission(user, 'payroll.view');
  const settlement = await prisma.finalSettlement.findFirst({
    where: { id, organizationId: user.organizationId },
    include: {
      employee: {
        select: { id: true, firstName: true, lastName: true, employeeCode: true, hireDate: true },
      },
      approvedBy: { select: { fullName: true } },
      createdBy: { select: { fullName: true } },
      paidFrom: { select: { accountName: true } },
    },
  });
  if (!settlement) throw new NotFoundError('settlement');
  return settlement;
}

/** Settlements still to approve or pay, and the leavers who have none yet — for reminders. */
export async function settlementsDue(organizationId: string) {
  const [open, leavers] = await Promise.all([
    prisma.finalSettlement.findMany({
      where: { organizationId, status: { in: ['DRAFT', 'APPROVED'] } },
      select: {
        id: true,
        status: true,
        terminationDate: true,
        employee: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.employee.findMany({
      where: { organizationId, terminationDate: { not: null }, finalSettlement: null },
      select: { id: true, firstName: true, lastName: true, terminationDate: true },
    }),
  ]);
  return { open, leavers };
}

/** The settlement of one employee, if any — for their page. */
export async function getEmployeeSettlement(user: AuthenticatedUser, employeeId: string) {
  requirePermission(user, 'payroll.view');
  return prisma.finalSettlement.findFirst({
    where: { organizationId: user.organizationId, employeeId },
    select: { id: true, status: true, netPayable: true, terminationDate: true },
  });
}
