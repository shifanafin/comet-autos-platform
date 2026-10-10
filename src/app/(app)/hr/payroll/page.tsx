import Link from 'next/link';
import { AlertTriangle, ArrowRight, Banknote, Users2 } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { canSeePay, getPayrollOverview, PAYROLL_STATUS_LABEL } from '@/lib/hr/payroll';
import { formatDate, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import { RunPayrollForm } from '@/components/hr/payroll-forms';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, PillTone> = {
  DRAFT: 'neutral',
  CALCULATED: 'warning',
  APPROVED: 'info',
  PAID: 'success',
  CANCELLED: 'neutral',
};

export default async function PayrollPage() {
  const user = await requireUser();
  if (!canSeePay(user)) return <AccessDenied what="payroll" />;

  const data = await getPayrollOverview(user);
  const canPrepare = hasPermission(user, 'payroll.create');

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="HR & Payroll"
        title="Payroll"
        description="One run per month: calculated from each person's salary and approved unpaid leave, approved, then recorded as paid."
      />

      <Panel className="grid grid-cols-2 gap-6 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Monthly salaries</span>
          <span className="text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
            {formatMoney(data.monthly)}
          </span>
          <span className="text-xs text-muted-foreground">
            Basic plus allowances, in force today
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">On the payroll</span>
          <span className="text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
            {data.team.length - data.missingSalary}
          </span>
          <span className="text-xs text-muted-foreground">of {data.team.length} active</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Last paid</span>
          <span className="text-2xl leading-none font-semibold tracking-[-0.02em]">
            {data.runs.find((run) => run.status === 'PAID')?.label ?? '—'}
          </span>
        </div>
      </Panel>

      {data.missingSalary > 0 ? (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-4 text-sm sm:px-6">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
          <span className="flex flex-col gap-1">
            <span className="font-medium">
              {data.missingSalary} active employee{data.missingSalary === 1 ? ' has' : 's have'} no
              salary set
            </span>
            <span className="text-muted-foreground">
              They are left out of payroll until a salary is set on their page.
            </span>
          </span>
        </div>
      ) : null}

      {canPrepare ? (
        <Section
          title="Run payroll"
          description="Calculates every line for the month. Nothing is final until it is approved."
        >
          <Panel>
            <RunPayrollForm
              defaultMonth={data.suggestedMonth ?? data.thisMonth}
              maxMonth={data.thisMonth}
            />
          </Panel>
        </Section>
      ) : null}

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Section title="Payroll runs" description="Newest month first." className="xl:col-span-7">
          {data.runs.length === 0 ? (
            <EmptyState
              icon={Banknote}
              title="No payroll run yet"
              description="Set salaries on each employee's page, then calculate the first month."
            />
          ) : (
            <Panel padding="none" className="overflow-hidden">
              <ul className="divide-y divide-border">
                {data.runs.map((run) => (
                  <li key={run.id}>
                    <Link
                      href={`/hr/payroll/${run.id}`}
                      className="flex items-center gap-4 px-4 py-4 hover:bg-muted/60 active:bg-muted sm:px-6"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                          {run.label}
                          <StatusPill tone={STATUS_TONE[run.status]}>
                            {PAYROLL_STATUS_LABEL[run.status]}
                          </StatusPill>
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {run.totals.count} employee{run.totals.count === 1 ? '' : 's'}
                          {run.paidAt
                            ? ` · paid ${formatDate(run.paidAt)}${run.paidBy ? ` by ${run.paidBy}` : ''}`
                            : run.approvedAt
                              ? ` · approved ${formatDate(run.approvedAt)}`
                              : ''}
                        </span>
                      </span>
                      <span
                        className={
                          run.status === 'CANCELLED'
                            ? 'shrink-0 text-sm text-muted-foreground tabular-nums line-through'
                            : 'shrink-0 text-sm font-semibold tabular-nums'
                        }
                      >
                        {formatMoney(run.totals.net)}
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </Section>

        <Section
          title="Salaries"
          description="In force today. Change a salary on the employee's page."
          className="xl:col-span-5"
        >
          {data.team.length === 0 ? (
            <EmptyState icon={Users2} title="No active employees" />
          ) : (
            <Panel padding="none" className="overflow-hidden">
              <ul className="divide-y divide-border">
                {data.team.map((member) => (
                  <li key={member.id}>
                    <Link
                      href={`/hr/employees/${member.id}#salary`}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/60 sm:px-6"
                    >
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">{member.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          <span className="font-mono">{member.code}</span>
                          {member.jobTitle ? ` · ${member.jobTitle}` : ''}
                        </span>
                      </span>
                      {member.salary ? (
                        <span className="shrink-0 text-sm tabular-nums">
                          {formatMoney(member.salary.total)}
                        </span>
                      ) : (
                        <StatusPill tone="warning">No salary</StatusPill>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </Section>
      </Grid>
    </Stack>
  );
}
