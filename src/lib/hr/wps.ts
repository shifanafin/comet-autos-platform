import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { AuthError, hasPermission, requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { emptyToNull } from '@/lib/normalize';
import { toFils } from '@/lib/money';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { approvedLeaveDays } from '@/lib/hr/leave';
import { buildSif, PERSON_CODE, ROUTING, validUaeIban } from '@/lib/hr/wps-file';

export { buildSif, validUaeIban };

/*
 * Paying salaries through WPS, the UAE Wage Protection System.
 *
 * The bank or exchange house that pays the team takes a Salary Information
 * File (SIF): one EDR line per employee and an SCR line for the company —
 *
 *   EDR,<MOHRE person code>,<agent routing code>,<IBAN>,<pay start>,<pay end>,
 *       <days in period>,<fixed income>,<variable income>,<days on leave>
 *   SCR,<MOHRE establishment id>,<bank routing code>,<file date>,<HHMM>,
 *       <salary month MMYYYY>,<EDR count>,<total salary>,AED,<reference>
 *
 * named <establishment id><YYMMDDHHMMSS>.SIF. Banks follow this layout; some
 * ask for small variations — the file is plain text, and their portal says
 * if anything is off.
 *
 * The details it needs live on the company (calendar → company dates) and on
 * each employee (their page, beside the salary). Only people who see pay see
 * or change them.
 */

const compact = (value: string | undefined) =>
  emptyToNull(value)?.replace(/[\s-]/g, '').toUpperCase() ?? null;

const payDetailsSchema = z.object({
  wpsPersonCode: z.string().trim().max(30).optional(),
  wpsAgentCode: z.string().trim().max(20).optional(),
  salaryIban: z.string().trim().max(40).optional(),
  requestKey: z.string().optional(),
});

/** How an employee's salary reaches them: MOHRE person code, bank routing code, IBAN. */
export async function setPayDetails(
  user: AuthenticatedUser,
  employeeId: string,
  rawInput: unknown,
) {
  const input = parseInput(payDetailsSchema, rawInput);
  requirePermission(user, 'payroll.create');
  const data = {
    wpsPersonCode: compact(input.wpsPersonCode),
    wpsAgentCode: compact(input.wpsAgentCode),
    salaryIban: compact(input.salaryIban),
  };
  if (data.wpsPersonCode && !PERSON_CODE.test(data.wpsPersonCode)) {
    throw new DomainError(
      'The MOHRE person code is 14 digits — it is on the labour card or work permit.',
      'wpsPersonCode',
    );
  }
  if (data.wpsAgentCode && !ROUTING.test(data.wpsAgentCode)) {
    throw new DomainError(
      'A routing code is 9 digits — ask their bank or exchange house.',
      'wpsAgentCode',
    );
  }
  if (data.salaryIban && !validUaeIban(data.salaryIban)) {
    throw new DomainError(
      'Enter a UAE IBAN: AE followed by 21 digits. Check it against their bank card or letter.',
      'salaryIban',
    );
  }

  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'employee.pay_details');
    const before = await tx.employee.findFirst({
      where: { id: employeeId, organizationId: user.organizationId },
      select: {
        id: true,
        branchId: true,
        wpsPersonCode: true,
        wpsAgentCode: true,
        salaryIban: true,
      },
    });
    if (!before) throw new NotFoundError('employee');
    await tx.employee.update({ where: { id: before.id }, data });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: before.branchId,
      actorUserId: user.id,
      action: 'employee.pay_details_updated',
      entityType: 'Employee',
      entityId: before.id,
      // The IBAN is kept out of the log but for its last four digits.
      beforeData: {
        wpsPersonCode: before.wpsPersonCode,
        wpsAgentCode: before.wpsAgentCode,
        salaryIban: before.salaryIban ? `…${before.salaryIban.slice(-4)}` : null,
      },
      afterData: {
        wpsPersonCode: data.wpsPersonCode,
        wpsAgentCode: data.wpsAgentCode,
        salaryIban: data.salaryIban ? `…${data.salaryIban.slice(-4)}` : null,
      },
    });
    await settleRequestKey(tx, user, rawInput, before.id);
    return { id: before.id };
  });
}

// ─── The salary file ────────────────────────────────────────────────────────

/** The UAE time now, for the file's date and time. */
function uaeNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dubai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}${parts.minute}`,
    seconds: parts.second,
  };
}

/**
 * The WPS file for an approved (or paid) payroll run, or what is missing
 * before it can be made.
 */
export async function getWpsFile(user: AuthenticatedUser, payrollId: string) {
  if (!hasPermission(user, 'payroll.view') && !hasPermission(user, 'payroll.approve')) {
    throw new AuthError('Missing permission: payroll.view');
  }
  const [payroll, organization] = await Promise.all([
    prisma.payroll.findFirst({
      where: { id: payrollId, organizationId: user.organizationId },
      select: {
        status: true,
        periodStart: true,
        periodEnd: true,
        items: {
          select: {
            netPay: true,
            employee: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                wpsPersonCode: true,
                wpsAgentCode: true,
                salaryIban: true,
              },
            },
          },
          orderBy: { employee: { firstName: 'asc' } },
        },
      },
    }),
    prisma.organization.findUniqueOrThrow({
      where: { id: user.organizationId },
      select: { mohreEstablishmentId: true, wpsRoutingCode: true },
    }),
  ]);
  if (!payroll) throw new NotFoundError('payroll run');
  if (payroll.status !== 'APPROVED' && payroll.status !== 'PAID') {
    throw new DomainError('Approve the payroll first — the bank pays what was approved.');
  }
  const leave = await approvedLeaveDays(
    prisma,
    user.organizationId,
    payroll.items.map((item) => item.employee.id),
    payroll.periodStart,
    payroll.periodEnd,
  );
  const now = uaeNow();
  return buildSif({
    establishmentId: organization.mohreEstablishmentId,
    routingCode: organization.wpsRoutingCode,
    periodStart: payroll.periodStart.toISOString().slice(0, 10),
    periodEnd: payroll.periodEnd.toISOString().slice(0, 10),
    createdDay: now.day,
    createdTime: now.time,
    createdSeconds: now.seconds,
    employees: payroll.items.map((item) => {
      const days = leave.get(item.employee.id);
      return {
        name: `${item.employee.firstName} ${item.employee.lastName}`.trim(),
        personCode: item.employee.wpsPersonCode,
        agentCode: item.employee.wpsAgentCode,
        iban: item.employee.salaryIban,
        fixedFils: toFils(item.netPay.toString()),
        variableFils: 0,
        leaveDays: days ? Object.values(days).reduce((sum, n) => sum + n, 0) : 0,
      };
    }),
  });
}
