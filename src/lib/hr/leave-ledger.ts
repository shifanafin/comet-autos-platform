import type { Prisma } from '@/generated/prisma/client';
import type { LeaveType } from '@/generated/prisma/enums';
import {
  annualLeaveBalance,
  countedServiceDays,
  splitLeave,
  splitWithin,
  type LeaveSplit,
} from '@/lib/hr/leave-rules';

/*
 * The facts the leave rules need, read from the database: an employee's
 * counted service, annual leave balance, the paid days of each type used in
 * the last 12 months, and what a new leave would pay. The rules themselves
 * are in lib/hr/leave-rules.ts.
 *
 * Days that don't count as service: approved unpaid days (the unpaid part of
 * any leave) and days marked absent with no approved leave (half a day for a
 * half day).
 */

type Tx = Prisma.TransactionClient;

const DAY_MS = 86_400_000;
const day = (date: Date) => date.toISOString().slice(0, 10);
const asDate = (value: string) => new Date(`${value}T00:00:00Z`);
const addDays = (value: string, days: number) =>
  day(new Date(asDate(value).getTime() + days * DAY_MS));
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

interface LeaveRow {
  id: string;
  leaveType: LeaveType;
  startDate: Date;
  endDate: Date;
  fullPayDays: number;
  halfPayDays: number;
  unpaidDays: number;
}

async function approvedLeaves(tx: Tx, organizationId: string, employeeId: string, to: string) {
  return tx.leave.findMany({
    where: { organizationId, employeeId, status: 'APPROVED', startDate: { lte: asDate(to) } },
    orderBy: { startDate: 'asc' },
    select: {
      id: true,
      leaveType: true,
      startDate: true,
      endDate: true,
      fullPayDays: true,
      halfPayDays: true,
      unpaidDays: true,
    },
  });
}

const splitOf = (leave: LeaveRow) => ({
  full: leave.fullPayDays,
  half: leave.halfPayDays,
  unpaid: leave.unpaidDays,
});

/** Leave days by pay in [from, to]. */
function leaveDaysWithin(
  leaves: LeaveRow[],
  from: string,
  to: string,
  filter?: (l: LeaveRow) => boolean,
) {
  const total = { full: 0, half: 0, unpaid: 0 };
  for (const leave of leaves) {
    if (filter && !filter(leave)) continue;
    if (day(leave.endDate) < from || day(leave.startDate) > to) continue;
    const part = splitWithin(day(leave.startDate), splitOf(leave), from, to);
    total.full += part.full;
    total.half += part.half;
    total.unpaid += part.unpaid;
  }
  return total;
}

/** Days marked absent (or half day) in [from, to] that no approved leave covers. */
export async function unexcusedAbsence(
  tx: Tx,
  organizationId: string,
  employeeId: string,
  from: string,
  to: string,
  leaves?: LeaveRow[],
) {
  const rows = await tx.attendance.findMany({
    where: {
      organizationId,
      employeeId,
      status: { in: ['ABSENT', 'HALF_DAY'] },
      attendanceDate: { gte: asDate(from), lte: asDate(to) },
    },
    select: { attendanceDate: true, status: true },
  });
  if (rows.length === 0) return { days: 0, dates: [] as string[] };
  const covering = leaves ?? (await approvedLeaves(tx, organizationId, employeeId, to));
  let days = 0;
  const dates: string[] = [];
  for (const row of rows) {
    const date = day(row.attendanceDate);
    const covered = covering.some((l) => day(l.startDate) <= date && day(l.endDate) >= date);
    if (covered) continue;
    days += row.status === 'HALF_DAY' ? 0.5 : 1;
    dates.push(date);
  }
  return { days, dates };
}

export interface EmployeeLeaveFacts {
  hireDate: Date;
  probationEndDate: Date | null;
  leaveOpeningDays: { toString(): string } | null;
  leaveOpeningAsOf: Date | null;
}

/** Service, annual leave and the paid days used, as of a day. */
export async function leavePosition(
  tx: Tx,
  organizationId: string,
  employeeId: string,
  employee: EmployeeLeaveFacts,
  asOf: string,
  options: { exceptLeaveId?: string } = {},
) {
  const hired = day(employee.hireDate);
  const leaves = (await approvedLeaves(tx, organizationId, employeeId, asOf)).filter(
    (leave) => leave.id !== options.exceptLeaveId,
  );
  const excludedTo = async (to: string) => {
    if (to < hired) return 0;
    const unpaid = leaveDaysWithin(leaves, hired, to).unpaid;
    const absent = (await unexcusedAbsence(tx, organizationId, employeeId, hired, to, leaves)).days;
    return unpaid + absent;
  };
  const serviceDays = asOf < hired ? 0 : countedServiceDays(hired, asOf, await excludedTo(asOf));

  const openingAsOf = employee.leaveOpeningAsOf ? day(employee.leaveOpeningAsOf) : null;
  const opening =
    openingAsOf && employee.leaveOpeningDays !== null
      ? {
          days: Number(employee.leaveOpeningDays.toString()),
          serviceDays:
            openingAsOf < hired
              ? 0
              : countedServiceDays(hired, openingAsOf, await excludedTo(openingAsOf)),
        }
      : null;
  const takenFrom = openingAsOf ? addDays(openingAsOf, 1) : hired;
  const taken =
    takenFrom > asOf
      ? 0
      : leaveDaysWithin(leaves, takenFrom, asOf, (leave) => leave.leaveType === 'ANNUAL').full;
  const annual = annualLeaveBalance({ serviceDays, opening, takenDays: taken });

  const probationEnd = employee.probationEndDate
    ? day(employee.probationEndDate)
    : day(
        new Date(
          Date.UTC(
            employee.hireDate.getUTCFullYear(),
            employee.hireDate.getUTCMonth() + 6,
            employee.hireDate.getUTCDate(),
          ),
        ),
      );
  const yearAgo = later(hired, addDays(asOf, -364));
  const usedOf = (type: LeaveType) => {
    const used = leaveDaysWithin(leaves, yearAgo, asOf, (leave) => leave.leaveType === type);
    return { full: used.full, half: used.half };
  };

  return {
    serviceDays,
    annual,
    inProbation: asOf <= probationEnd,
    probationEnd,
    usedOf,
  };
}

/** How a leave of `type` from `start` to `end` would be paid, given everything before it. */
export async function proposeSplit(
  tx: Tx,
  organizationId: string,
  employeeId: string,
  employee: EmployeeLeaveFacts,
  type: LeaveType,
  start: string,
  end: string,
  options: { exceptLeaveId?: string } = {},
): Promise<LeaveSplit> {
  const dayBefore = addDays(start, -1);
  const position = await leavePosition(
    tx,
    organizationId,
    employeeId,
    employee,
    dayBefore,
    options,
  );
  const used = position.usedOf(type);
  const days = Math.round((asDate(end).getTime() - asDate(start).getTime()) / DAY_MS) + 1;
  return splitLeave({
    type,
    days,
    serviceDays: position.serviceDays,
    inProbation: start <= position.probationEnd,
    annualBalance: position.annual.balance,
    usedFull: used.full,
    usedHalf: used.half,
  });
}

/** Unpaid, half-pay and absent days in a payroll window, per employee. */
export async function payWindowDays(
  tx: Tx,
  organizationId: string,
  employeeId: string,
  from: string,
  to: string,
) {
  const leaves = await approvedLeaves(tx, organizationId, employeeId, to);
  const leave = leaveDaysWithin(leaves, from, to);
  const absence = await unexcusedAbsence(tx, organizationId, employeeId, from, to, leaves);
  return {
    unpaid: leave.unpaid,
    half: leave.half,
    paidLeave: leave.full,
    absent: absence.days,
  };
}

export { earlier as earlierDay, later as laterDay };
