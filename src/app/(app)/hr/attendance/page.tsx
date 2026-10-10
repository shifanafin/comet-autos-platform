import { Users2 } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { AuthError } from '@/lib/auth/authorize';
import { DomainError } from '@/lib/errors';
import {
  ATTENDANCE_STATUSES,
  formatWorked,
  getAttendanceDay,
  type AttendanceDay,
} from '@/lib/hr/attendance';
import { formatDayHeading } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { AttendanceRow } from '@/components/hr/attendance-row';
import { AttendanceDatePicker } from '@/components/hr/attendance-date-picker';
import { AttendanceReview } from '@/components/hr/attendance-review';
import { listAttendanceToReview } from '@/lib/hr/self-attendance';

export const dynamic = 'force-dynamic';

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span className="text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
        {value}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  let day: AttendanceDay;
  try {
    day = await getAttendanceDay(user, params.date);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="the workshop's attendance" />;
    // A hand-typed date in the URL is a message, not a crash.
    if (error instanceof DomainError) {
      day = await getAttendanceDay(user);
    } else {
      throw error;
    }
  }
  const canEdit = hasPermission(user, 'attendance.create');
  const toReview = hasPermission(user, 'attendance.edit') ? await listAttendanceToReview(user) : [];

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="HR & Payroll"
        title="Attendance"
        description="Who is in today. Staff check themselves in on their phones (My work); you can still clock someone in or out here."
      />

      <AttendanceReview rows={toReview} />

      <AttendanceDatePicker date={day.date} isToday={day.isToday} />

      {day.rows.length === 0 ? (
        <EmptyState
          icon={Users2}
          title="No active employees"
          description="Add someone to the team before recording attendance."
        />
      ) : (
        <>
          <Panel className="grid grid-cols-2 gap-6 sm:grid-cols-4">
            <Figure
              label="In today"
              value={String(day.totals.present)}
              hint={`of ${day.totals.team}`}
            />
            <Figure
              label="Still in"
              value={String(day.totals.stillIn)}
              hint={day.totals.stillIn === 1 ? 'not clocked out' : 'not clocked out'}
            />
            <Figure label="Away" value={String(day.totals.absent + day.totals.onLeave)} hint="absent or on leave" />
            <Figure
              label="Hours"
              value={formatWorked(day.totals.minutes)}
              hint={day.totals.overtime ? `incl. ${formatWorked(day.totals.overtime)} overtime` : 'completed days'}
            />
          </Panel>

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[17px] leading-tight font-semibold tracking-[-0.011em]">
                {formatDayHeading(`${day.date}T12:00:00Z`)}
              </h2>
              <p className="text-sm text-muted-foreground">
                {day.totals.recorded} of {day.totals.team} recorded
              </p>
            </div>

            {!canEdit ? (
              <p className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
                Your role can see attendance but not record it.
              </p>
            ) : null}

            <ul className="flex flex-col gap-2">
              {day.rows.map((row) => (
                <AttendanceRow
                  key={row.employee.id}
                  row={row}
                  date={day.date}
                  canEdit={canEdit}
                  statuses={ATTENDANCE_STATUSES}
                />
              ))}
            </ul>
          </section>
        </>
      )}
    </Stack>
  );
}
