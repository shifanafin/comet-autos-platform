import Link from 'next/link';
import { ArrowRight, CalendarCheck, UserPlus } from 'lucide-react';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { getHrOverview, type HrOverview } from '@/lib/overview/hr';
import { formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { RankedBars } from '@/components/reports/charts';
import { AttentionChip, Kpi, KpiRow } from '@/components/overview/kpi';

export const metadata = { title: 'HR overview' };
export const dynamic = 'force-dynamic';

/*
 * HR overview: the team, who is in today, who is off, this month's
 * attendance and — for whoever may see pay — the salary bill and the latest
 * payroll run.
 */

const PAYROLL_STATUS: Record<string, string> = {
  DRAFT: 'Draft',
  CALCULATED: 'Calculated — waiting for approval',
  APPROVED: 'Approved — not paid yet',
  PAID: 'Paid',
};

export default async function HrOverviewPage() {
  const user = await requireUser();
  let data: HrOverview;
  try {
    data = await getHrOverview(user);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="the HR overview" />;
    throw error;
  }
  const { team, today, attendance, leave, pay } = data;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="HR & Payroll"
        title="HR overview"
        description="The team, who is in today, who is off, attendance this month and the salary bill."
        actions={
          <span className="flex flex-wrap gap-2">
            {hasPermission(user, 'attendance.view') ? (
              <Link
                href="/hr/attendance"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium hover:bg-muted"
              >
                <CalendarCheck className="size-4" />
                Attendance
              </Link>
            ) : null}
            {hasPermission(user, 'employee.create') ? (
              <Link
                href="/hr/employees/new"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                <UserPlus className="size-4" />
                New employee
              </Link>
            ) : null}
          </span>
        }
      />

      <KpiRow>
        <Kpi
          label="Employees"
          value={String(team.active)}
          hint={`${team.withLogin} with an app login`}
          href="/hr/employees"
        />
        {today ? (
          <>
            <Kpi
              label="In today"
              value={`${today.present} of ${today.team}`}
              hint={`${today.stillIn} still clocked in · ${today.team - today.recorded} not recorded yet`}
              href="/hr/attendance"
            />
            <Kpi
              label="Absent today"
              value={String(today.absent)}
              tone={today.absent > 0 ? 'bad' : 'default'}
              hint={`${today.onLeave} on approved leave`}
              href="/hr/attendance"
            />
          </>
        ) : null}
        {attendance ? (
          <Kpi
            label="Attendance this month"
            value={attendance.rate !== null ? `${attendance.rate}%` : '—'}
            hint={`${attendance.present} days present · ${attendance.halfDays} half days · ${attendance.absent} absent`}
          />
        ) : null}
      </KpiRow>

      {pay ? (
        <KpiRow>
          <Kpi
            label="Monthly salary bill"
            value={formatMoney(pay.monthly)}
            hint={
              pay.missingSalary > 0
                ? `${pay.missingSalary} employee${pay.missingSalary === 1 ? '' : 's'} with no salary set`
                : 'Basic salary and allowances, every active employee'
            }
            href="/hr/payroll"
          />
          {pay.latest ? (
            <>
              <Kpi
                label={`Payroll — ${pay.latest.label}`}
                value={formatMoney(pay.latest.totals.net)}
                hint={`${PAYROLL_STATUS[pay.latest.status] ?? pay.latest.status} · ${pay.latest.totals.count} employee${pay.latest.totals.count === 1 ? '' : 's'}`}
                href="/hr/payroll"
              />
              <Kpi
                label="Deductions"
                value={formatMoney(pay.latest.totals.deductions)}
                hint={`From ${formatMoney(pay.latest.totals.gross)} gross, in ${pay.latest.label}`}
              />
            </>
          ) : (
            <Kpi label="Payroll" value="—" hint="No payroll run yet" href="/hr/payroll" />
          )}
        </KpiRow>
      ) : null}

      {leave && (leave.pending > 0 || leave.offToday > 0 || leave.upcoming > 0) ? (
        <Section title="Leave" description="Requests to decide, and who is away.">
          <div className="flex flex-wrap gap-2">
            {leave.pending > 0 ? (
              <AttentionChip
                href="/hr/leave?status=PENDING"
                count={leave.pending}
                label={`request${leave.pending === 1 ? '' : 's'} waiting for a decision`}
                tone="warning"
              />
            ) : null}
            {leave.offToday > 0 ? (
              <AttentionChip
                href="/hr/leave"
                count={leave.offToday}
                label={`off today: ${leave.offTodayNames.join(', ')}`}
              />
            ) : null}
            {leave.upcoming > 0 ? (
              <AttentionChip
                href="/hr/leave"
                count={leave.upcoming}
                label="approved leave starting in the next 30 days"
              />
            ) : null}
          </div>
        </Section>
      ) : null}

      <Grid gap="xl" className="items-start lg:grid-cols-2">
        <Section
          title="Team by role"
          action={
            <Link
              href="/hr/employees"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover"
            >
              All employees
              <ArrowRight className="size-4" />
            </Link>
          }
        >
          <Panel padding="none">
            {team.roles.length ? (
              <RankedBars
                rows={team.roles.map((row) => ({
                  key: row.role,
                  label: row.role,
                  value: `${row.count}`,
                  weight: row.count,
                }))}
              />
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-6">No employees yet.</p>
            )}
          </Panel>
        </Section>
        {attendance ? (
          <Section
            title="This month's attendance"
            description="Days recorded, from the 1st to today."
          >
            <Panel padding="none">
              <RankedBars
                rows={[
                  {
                    key: 'present',
                    label: 'Present',
                    value: String(attendance.present),
                    weight: attendance.present,
                  },
                  {
                    key: 'half',
                    label: 'Half day',
                    value: String(attendance.halfDays),
                    weight: attendance.halfDays,
                  },
                  {
                    key: 'leave',
                    label: 'On leave',
                    value: String(attendance.onLeave),
                    weight: attendance.onLeave,
                  },
                  {
                    key: 'absent',
                    label: 'Absent',
                    value: String(attendance.absent),
                    weight: attendance.absent,
                  },
                ]}
              />
            </Panel>
          </Section>
        ) : null}
      </Grid>
    </Stack>
  );
}
