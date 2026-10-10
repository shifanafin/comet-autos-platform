import Link from 'next/link';
import { Clock3 } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import {
  DAILY_OVERTIME_LIMIT,
  listOvertime,
  OVERTIME_KIND_LABEL,
  OVERTIME_STATUS_LABEL,
} from '@/lib/hr/overtime';
import { formatCalendarDate, localDateString } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import {
  AddOvertimeForm,
  HolidayForm,
  OvertimeDecision,
  RemoveHolidayButton,
  RestDayForm,
} from '@/components/hr/overtime-forms';

export const metadata = { title: 'Overtime' };

const STATUS_TONE: Record<string, PillTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'neutral',
};

/** Shifts a "YYYY-MM" by n months. */
function shiftMonth(month: string, n: number) {
  const [year, m] = month.split('-').map(Number);
  return new Date(Date.UTC(year, m - 1 + n, 1)).toISOString().slice(0, 7);
}

export default async function OvertimePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, 'payroll.view')) return <AccessDenied what="overtime" />;
  const params = await searchParams;
  const data = await listOvertime(user, params.month);
  const canDecide = hasPermission(user, 'payroll.edit');
  const canSettings = hasPermission(user, 'settings.edit');
  const monthLabel = new Date(`${data.month}-01T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const pending = data.entries.filter((entry) => entry.status === 'PENDING').length;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/hr/payroll" className="hover:text-foreground">
            Payroll
          </Link>
        }
        title="Overtime"
        description="Hours beyond the normal day, suggested from check-in and check-out. Paid in the month's payroll once approved: +25% on a working day, +50% at night (22:00–04:00), on the rest day or a public holiday."
      />

      <Section
        title={monthLabel}
        description={pending ? `${pending} waiting for approval.` : 'Nothing waiting.'}
        action={
          <div className="flex gap-2 text-sm">
            <Link
              className="text-primary hover:underline"
              href={`/hr/overtime?month=${shiftMonth(data.month, -1)}`}
            >
              ← Previous
            </Link>
            <Link
              className="text-primary hover:underline"
              href={`/hr/overtime?month=${shiftMonth(data.month, 1)}`}
            >
              Next →
            </Link>
          </div>
        }
      >
        {data.entries.length === 0 ? (
          <Panel>
            <EmptyState
              icon={Clock3}
              title="No overtime this month"
              description="It appears here when someone checks out after their normal hours — or add it by hand below."
            />
          </Panel>
        ) : (
          <Panel padding="none" className="@container overflow-hidden">
            <ul className="divide-y divide-border">
              {data.entries.map((entry) => {
                const hours = entry.hours.toString();
                return (
                  <li
                    key={entry.id}
                    className="flex flex-col gap-3 px-4 py-3 @lg:flex-row @lg:items-center @lg:justify-between sm:px-6"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="font-medium">
                        {entry.employee.firstName} {entry.employee.lastName}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {entry.employee.employeeCode}
                        </span>
                      </span>
                      <span className="text-sm text-muted-foreground">
                        {formatCalendarDate(entry.workDate)} · {OVERTIME_KIND_LABEL[entry.kind]} ·{' '}
                        {entry.source === 'AUTO' ? 'from check-out' : 'entered by hand'}
                        {entry.decidedBy ? ` · ${entry.decidedBy.fullName}` : ''}
                      </span>
                      {entry.note ? (
                        <span className="text-xs text-warning">{entry.note}</span>
                      ) : null}
                    </div>
                    {entry.status === 'PENDING' && canDecide ? (
                      <OvertimeDecision id={entry.id} hours={hours} />
                    ) : (
                      <div className="flex items-center gap-3">
                        <span className="tabular-nums">{hours} h</span>
                        <StatusPill tone={STATUS_TONE[entry.status]}>
                          {OVERTIME_STATUS_LABEL[entry.status]}
                        </StatusPill>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}
        <p className="text-xs text-muted-foreground">
          UAE law allows at most {DAILY_OVERTIME_LIMIT} hours of overtime a day beyond the normal
          day, except in an emergency.
        </p>
      </Section>

      {canDecide ? (
        <Section title="Add overtime" description="For work no check-out recorded.">
          <Panel>
            <AddOvertimeForm
              employees={data.employees.map((employee) => ({
                id: employee.id,
                name: `${employee.firstName} ${employee.lastName}`.trim(),
              }))}
              today={localDateString()}
            />
          </Panel>
        </Section>
      ) : null}

      <Section
        title="Rest day and public holidays"
        description="Work on these days is paid at +50%. Public holidays are announced each year — add them as they are."
      >
        <Panel className="flex flex-col gap-6">
          {canSettings ? <RestDayForm current={data.weeklyRestDay} /> : null}
          {canSettings ? <HolidayForm /> : null}
          {data.holidays.length ? (
            <ul className="divide-y divide-border rounded-lg border border-border">
              {data.holidays.map((holiday) => (
                <li
                  key={holiday.id}
                  className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
                >
                  <span>
                    <span className="tabular-nums">{formatCalendarDate(holiday.holidayDate)}</span>{' '}
                    · {holiday.name}
                  </span>
                  {canSettings ? <RemoveHolidayButton id={holiday.id} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No public holidays entered for this year.
            </p>
          )}
        </Panel>
      </Section>
    </Stack>
  );
}
