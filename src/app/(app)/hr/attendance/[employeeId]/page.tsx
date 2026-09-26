import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarOff } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { AuthError } from '@/lib/auth/authorize';
import { DomainError, NotFoundError } from '@/lib/errors';
import { ATTENDANCE_STATUSES, formatWorked, getEmployeeAttendance } from '@/lib/hr/attendance';
import { formatCalendarDate, formatTime, localDateString, WORKSHOP_LOCALE } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { TableWrap } from '@/components/shared/record-card';

export const dynamic = 'force-dynamic';

const TONE = {
  PRESENT: 'success',
  HALF_DAY: 'warning',
  ABSENT: 'danger',
  ON_LEAVE: 'neutral',
  HOLIDAY: 'neutral',
} as const;

const LABEL = Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s.value, s.label]));

/** The month before and after, so a supervisor can page through the year. */
function shiftMonth(month: string, by: number) {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, m - 1 + by, 1));
  return date.toISOString().slice(0, 7);
}

export default async function EmployeeAttendancePage({
  params,
  searchParams,
}: {
  params: Promise<{ employeeId: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser();
  const { employeeId } = await params;
  const { month } = await searchParams;

  let data;
  try {
    data = await getEmployeeAttendance(user, employeeId, month);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="this employee's attendance" />;
    if (error instanceof NotFoundError) notFound();
    if (error instanceof DomainError) {
      data = await getEmployeeAttendance(user, employeeId);
    } else {
      throw error;
    }
  }
  const { employee, days, totals } = data;
  const thisMonth = localDateString().slice(0, 7);
  const canEdit = hasPermission(user, 'payroll.create');
  const monthLabel = new Date(`${data.month}-01T12:00:00Z`).toLocaleDateString(WORKSHOP_LOCALE, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <Link
        href="/hr/attendance"
        className="-ml-2 inline-flex h-11 w-fit items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Attendance
      </Link>

      <PageHeader
        eyebrow="Attendance"
        title={employee.name}
        description={`${employee.employeeCode}${employee.jobTitle ? ` · ${employee.jobTitle}` : ''}`}
      />

      {/* Month paging: big enough for a thumb, never past this month. */}
      <div className="flex flex-wrap items-center gap-2">
        <LinkButton
          href={`/hr/attendance/${employee.id}?month=${shiftMonth(data.month, -1)}`}
          variant="outline"
          className="h-12 md:h-11"
        >
          Previous
        </LinkButton>
        <span className="min-w-0 flex-1 text-center text-sm font-medium sm:flex-none sm:px-3">
          {monthLabel}
        </span>
        {data.month < thisMonth ? (
          <LinkButton
            href={`/hr/attendance/${employee.id}?month=${shiftMonth(data.month, 1)}`}
            variant="outline"
            className="h-12 md:h-11"
          >
            Next
          </LinkButton>
        ) : null}
      </div>

      <Panel className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        {[
          ['Days present', String(totals.present + totals.halfDay)],
          ['Absent', String(totals.absent)],
          ['On leave', String(totals.onLeave)],
          ['Hours', formatWorked(totals.minutes)],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <span className="text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
              {value}
            </span>
          </div>
        ))}
      </Panel>

      <Section
        title="Recorded days"
        description={
          days.length === 0
            ? 'Nothing recorded for this month.'
            : `${days.length} day${days.length === 1 ? '' : 's'} on record, newest first.`
        }
        action={
          canEdit ? (
            <Link
              href="/hr/attendance"
              className="text-sm font-medium text-primary hover:text-primary-hover"
            >
              Record today
            </Link>
          ) : null
        }
      >
        {days.length === 0 ? (
          <EmptyState
            icon={CalendarOff}
            title="Nothing recorded"
            description="Days appear here once someone is clocked in or the day is marked."
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            {/* Phone: one row per day as a card. Desktop: a table. */}
            <ul className="divide-y divide-border md:hidden">
              {days.map((day) => (
                <li key={day.id} className="flex flex-col gap-1.5 px-4 py-3.5">
                  <span className="flex items-center justify-between gap-3">
                    <span className="text-sm font-medium">
                      {formatCalendarDate(day.attendanceDate)}
                    </span>
                    <StatusPill tone={TONE[day.status]}>{LABEL[day.status]}</StatusPill>
                  </span>
                  <span className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      {day.clockInAt
                        ? `${formatTime(day.clockInAt)}${day.clockOutAt ? ` – ${formatTime(day.clockOutAt)}` : ' – still in'}`
                        : '—'}
                    </span>
                    <span className="font-medium tabular-nums text-foreground">
                      {day.workedLabel}
                    </span>
                  </span>
                  {day.notes ? <span className="text-xs text-muted-foreground">{day.notes}</span> : null}
                </li>
              ))}
            </ul>
            <TableWrap>
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  <tr>
                    <th className="px-6 py-4">Date</th>
                    <th className="px-2 py-4">Status</th>
                    <th className="px-2 py-4">In</th>
                    <th className="px-2 py-4">Out</th>
                    <th className="w-24 px-2 py-4 text-right">Worked</th>
                    <th className="px-6 py-4">Note</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {days.map((day) => (
                    <tr key={day.id}>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {formatCalendarDate(day.attendanceDate)}
                      </td>
                      <td className="px-2 py-4">
                        <StatusPill tone={TONE[day.status]}>{LABEL[day.status]}</StatusPill>
                      </td>
                      <td className="px-2 py-4 tabular-nums text-muted-foreground">
                        {day.clockInAt ? formatTime(day.clockInAt) : '—'}
                      </td>
                      <td className="px-2 py-4 tabular-nums text-muted-foreground">
                        {day.clockOutAt ? formatTime(day.clockOutAt) : '—'}
                      </td>
                      <td className="px-2 py-4 text-right font-medium tabular-nums">
                        {day.workedLabel}
                      </td>
                      <td className="px-6 py-4 text-muted-foreground">{day.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Panel>
        )}
      </Section>
    </Stack>
  );
}
