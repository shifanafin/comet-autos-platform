import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowRight, Banknote, ClipboardCheck, Pencil, ShieldCheck, Wrench } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getEmployeeDetail } from '@/lib/hr/employees';
import { canSeePay, getSalaryHistory } from '@/lib/hr/payroll';
import { NotFoundError } from '@/lib/errors';
import { formatCalendarDate, formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { JobStatusBadge } from '@/components/shared/job-status-badge';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { InlineForm } from '@/components/shared/inline-form';
import { PayDetailsForm, SalaryForm } from '@/components/hr/payroll-forms';
import { ResetLoginButton } from '@/components/hr/reset-login-button';
import { PrepareSettlementForm } from '@/components/hr/settlement-forms';
import { getEmployeeLeaveSummary } from '@/lib/hr/leave';
import { getEmployeeSettlement } from '@/lib/hr/settlement';

export default async function EmployeePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!hasPermission(user, 'employee.view')) return <AccessDenied what="the team" />;
  const { id } = await params;

  let detail;
  try {
    detail = await getEmployeeDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { employee, openJobs, recentLabour, counts } = detail;
  const canManage = hasPermission(user, 'employee.edit');
  const canSetSalary = hasPermission(user, 'payroll.create');
  const canResetLogin =
    hasPermission(user, 'user.edit') && !!employee.user && employee.user.id !== user.id;
  // Pay is shown only to those who prepare or approve payroll.
  const pay = canSeePay(user) ? await getSalaryHistory(user, employee.id) : null;
  const [leave, settlement] = await Promise.all([
    hasPermission(user, 'leave.view') ? getEmployeeLeaveSummary(user, employee.id) : null,
    pay ? getEmployeeSettlement(user, employee.id) : null,
  ]);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/hr/employees" className="hover:text-foreground">
            Team
          </Link>
        }
        title={
          <>
            {employee.name}
            {employee.isActive ? null : <StatusPill tone="neutral">Left</StatusPill>}
          </>
        }
        description={
          [employee.jobTitle, employee.department, employee.branch.name]
            .filter(Boolean)
            .join(' · ') || 'No job title recorded.'
        }
        actions={
          canManage ? (
            <LinkButton href={`/hr/employees/${employee.id}/edit`} variant="outline" size="lg">
              <Pencil />
              Edit
            </LinkButton>
          ) : null
        }
      />

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Stack gap="2xl" className="xl:col-span-8">
          <Section
            title="Jobs in progress"
            description="Vehicles this person is responsible for right now."
          >
            {openJobs.length === 0 ? (
              <Panel>
                <p className="text-sm text-muted-foreground">No open jobs assigned.</p>
              </Panel>
            ) : (
              <Panel padding="none" className="overflow-hidden">
                <ul className="divide-y divide-border">
                  {openJobs.map((assignment) => (
                    <li key={assignment.id}>
                      <Link
                        href={`/job-cards/${assignment.jobCard.id}`}
                        className="flex items-center gap-4 px-4 py-4 hover:bg-muted/60 sm:px-6"
                      >
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <VehiclePlate
                              plateNumber={assignment.jobCard.vehicle.plateNumber}
                              className="px-2 py-0.5 text-xs"
                            />
                            <span className="text-sm font-medium">
                              {assignment.jobCard.vehicle.make} {assignment.jobCard.vehicle.model}
                            </span>
                            {assignment.assignmentRole === 'PRIMARY' ? (
                              <StatusPill tone="primary">Lead</StatusPill>
                            ) : null}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            <span className="font-mono">{assignment.jobCard.jobNumber}</span> ·{' '}
                            {assignment.jobCard.customer.name}
                          </span>
                        </div>
                        <JobStatusBadge status={assignment.jobCard.status} />
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </Section>

          <Section title="Recent labour" description="The last hours recorded against this person.">
            {recentLabour.length === 0 ? (
              <EmptyState icon={Wrench} title="No labour recorded yet" />
            ) : (
              <Panel padding="none" className="overflow-hidden">
                <ul className="divide-y divide-border">
                  {recentLabour.map((labour) => (
                    <li
                      key={labour.id}
                      className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm">{labour.description}</span>
                        <span className="text-xs text-muted-foreground">
                          <Link
                            href={`/job-cards/${labour.jobCard.id}`}
                            className="font-mono hover:underline"
                          >
                            {labour.jobCard.jobNumber}
                          </Link>{' '}
                          · {formatDateTime(labour.performedAt)}
                        </span>
                      </div>
                      <span className="shrink-0 text-sm font-medium tabular-nums">
                        {labour.hours.toString()} h
                      </span>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </Section>
        </Stack>

        <Stack gap="xl" className="xl:col-span-4">
          <Section title="Record">
            <Panel>
              <dl className="flex flex-col gap-4 text-sm">
                <div className="flex flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground">Employee code</dt>
                  <dd className="font-mono">{employee.employeeCode}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground">Designation</dt>
                  <dd>
                    {employee.designation ? (
                      <Link
                        href={`/hr/designations/${employee.designation.id}`}
                        className="hover:underline"
                      >
                        {employee.designation.name}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">
                        {employee.jobTitle
                          ? `${employee.jobTitle} (no designation set)`
                          : 'Not set'}
                      </span>
                    )}
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground">Contact</dt>
                  <dd>
                    {employee.phone || employee.email ? (
                      <>
                        {employee.phone ? (
                          <a
                            href={`tel:${employee.phone.replace(/[^\d+]/g, '')}`}
                            className="tabular-nums hover:underline"
                          >
                            {employee.phone}
                          </a>
                        ) : null}
                        {employee.email ? (
                          <a
                            href={`mailto:${employee.email}`}
                            className="block break-all text-muted-foreground hover:underline"
                          >
                            {employee.email}
                          </a>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">Not recorded</span>
                    )}
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground">Branch</dt>
                  <dd>{employee.branch.name}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground">Joined</dt>
                  <dd className="tabular-nums">{formatDate(employee.hireDate)}</dd>
                </div>
                {employee.terminationDate ? (
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs font-medium text-muted-foreground">Left</dt>
                    <dd className="tabular-nums">{formatDate(employee.terminationDate)}</dd>
                  </div>
                ) : null}
                <div className="flex flex-col gap-1">
                  <dt className="text-xs font-medium text-muted-foreground">System login</dt>
                  <dd>
                    {employee.user ? (
                      <div className="flex flex-col gap-1">
                        {employee.user.username ? (
                          <span>
                            Signs in as{' '}
                            <span className="font-mono font-medium">{employee.user.username}</span>
                          </span>
                        ) : null}
                        {employee.user.email ? (
                          <span className="break-all">{employee.user.email}</span>
                        ) : null}
                        {employee.user.phone ? (
                          <span className="text-muted-foreground">{employee.user.phone}</span>
                        ) : null}
                        {!employee.user.isActive ? (
                          <StatusPill tone="neutral">Login switched off</StatusPill>
                        ) : employee.user.mustChangePassword ? (
                          <span className="text-xs text-muted-foreground">
                            {employee.user.lastLoginAt
                              ? 'Has not chosen their own password yet.'
                              : 'Not signed in yet — they use the one-time password given when the login was made (Reset password gives a new one).'}
                          </span>
                        ) : null}
                        {canResetLogin ? <ResetLoginButton employeeId={employee.id} /> : null}
                      </div>
                    ) : (
                      <span className="text-muted-foreground">
                        None — recorded against their work without signing in
                      </span>
                    )}
                  </dd>
                </div>
              </dl>
            </Panel>
          </Section>

          {pay ? (
            <div id="salary" className="scroll-mt-24">
              <Section title="Salary" description="Per month. Payroll uses the salary in force.">
                <Panel padding="none" className="overflow-hidden">
                  {pay.current ? (
                    <dl className="grid grid-cols-3 gap-4 px-4 py-5 text-sm sm:px-6">
                      <div className="flex flex-col gap-1">
                        <dt className="text-xs font-medium text-muted-foreground">Basic</dt>
                        <dd className="font-medium tabular-nums">
                          {formatMoney(pay.current.basicSalary)}
                        </dd>
                      </div>
                      <div className="flex flex-col gap-1">
                        <dt className="text-xs font-medium text-muted-foreground">Allowances</dt>
                        <dd className="font-medium tabular-nums">
                          {formatMoney(pay.current.allowances)}
                        </dd>
                      </div>
                      <div className="flex flex-col gap-1">
                        <dt className="text-xs font-medium text-muted-foreground">Total</dt>
                        <dd className="font-semibold tabular-nums">
                          {formatMoney(pay.current.total)}
                        </dd>
                      </div>
                    </dl>
                  ) : (
                    <p className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground sm:px-6">
                      <Banknote className="size-4" />
                      No salary in force — this person is left out of payroll.
                    </p>
                  )}
                  {pay.upcoming ? (
                    <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
                      Changes to {formatMoney(pay.upcoming.basicSalary)} basic from{' '}
                      {formatCalendarDate(pay.upcoming.effectiveFrom)}.
                    </p>
                  ) : null}
                  {pay.history.length > 1 ? (
                    <ul className="divide-y divide-border border-t border-border text-xs">
                      {pay.history.map((row) => (
                        <li
                          key={row.id}
                          className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-6"
                        >
                          <span className="text-muted-foreground tabular-nums">
                            {formatCalendarDate(row.effectiveFrom)}
                            {row.effectiveTo
                              ? ` – ${formatCalendarDate(row.effectiveTo)}`
                              : ' onwards'}
                          </span>
                          <span className="tabular-nums">{formatMoney(row.total)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {canSetSalary ? (
                    <InlineForm
                      label={pay.current ? 'Change salary' : 'Set salary'}
                      hint="From a date. The same date as the latest salary corrects it."
                      icon={<Banknote className="size-4" />}
                      defaultOpen={!pay.current && !pay.upcoming}
                    >
                      <SalaryForm
                        employeeId={employee.id}
                        current={
                          pay.current
                            ? {
                                basicSalary: pay.current.basicSalary.toString(),
                                allowances: pay.current.allowances.toString(),
                              }
                            : null
                        }
                      />
                    </InlineForm>
                  ) : null}
                  <dl className="grid gap-4 border-t border-border px-4 py-4 text-sm sm:grid-cols-3 sm:px-6">
                    <div className="flex flex-col gap-1">
                      <dt className="text-xs font-medium text-muted-foreground">
                        MOHRE person code
                      </dt>
                      <dd className="font-mono">{pay.payDetails.wpsPersonCode ?? '—'}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-xs font-medium text-muted-foreground">
                        Bank routing code
                      </dt>
                      <dd className="font-mono">{pay.payDetails.wpsAgentCode ?? '—'}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-xs font-medium text-muted-foreground">IBAN</dt>
                      <dd className="font-mono break-all">{pay.payDetails.salaryIban ?? '—'}</dd>
                    </div>
                  </dl>
                  {canSetSalary ? (
                    <InlineForm
                      label={pay.payDetails.salaryIban ? 'Change bank details' : 'Add bank details'}
                      hint="For the WPS salary file the bank pays from."
                      icon={<Banknote className="size-4" />}
                      defaultOpen={false}
                    >
                      <PayDetailsForm employeeId={employee.id} current={pay.payDetails} />
                    </InlineForm>
                  ) : null}
                </Panel>
              </Section>
            </div>
          ) : null}

          {leave ? (
            <Section
              title="Annual leave"
              description={`As of ${formatCalendarDate(leave.asOf)}. Builds up with every day of service; unpaid leave and absent days don't count.`}
            >
              <Panel padding="none" className="overflow-hidden">
                <dl className="grid grid-cols-2 gap-4 px-4 py-5 text-sm sm:grid-cols-4 sm:px-6">
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs font-medium text-muted-foreground">Earned</dt>
                    <dd className="font-medium tabular-nums">{leave.annual.earned} days</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs font-medium text-muted-foreground">Taken</dt>
                    <dd className="font-medium tabular-nums">{leave.annual.taken} days</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs font-medium text-muted-foreground">Left</dt>
                    <dd className="font-semibold tabular-nums">{leave.annual.balance} days</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-xs font-medium text-muted-foreground">Service counted</dt>
                    <dd className="tabular-nums">
                      {leave.serviceDays} of {leave.calendarDays} days
                    </dd>
                  </div>
                </dl>
                <div className="flex flex-col gap-1 border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
                  {leave.annual.accruing > 0 ? (
                    <p>
                      {leave.annual.accruing} days building up — usable once they complete 6 months.
                    </p>
                  ) : null}
                  <p>
                    {leave.inProbation
                      ? `On probation until ${formatCalendarDate(leave.probationEnd)}: sick leave is unpaid.`
                      : `Sick leave this year: ${leave.sickFullUsed} of 15 days on full pay, ${leave.sickHalfUsed} of 30 on half pay.`}
                  </p>
                </div>
              </Panel>
            </Section>
          ) : null}

          {pay ? (
            <Section
              title="Leaving"
              description="Final settlement: end-of-service, unused leave and notice — due within 14 days."
            >
              <Panel>
                {settlement ? (
                  <Link
                    href={`/hr/settlements/${settlement.id}`}
                    className="flex items-center justify-between gap-3 text-sm hover:underline"
                  >
                    <span>
                      Final settlement · leaving {formatCalendarDate(settlement.terminationDate)} ·{' '}
                      {settlement.status.toLowerCase()}
                    </span>
                    <span className="font-semibold tabular-nums">
                      {formatMoney(settlement.netPayable.toString())}
                    </span>
                  </Link>
                ) : canSetSalary ? (
                  <InlineForm
                    label="Work out a final settlement"
                    hint="When someone resigns, is let go or their contract ends."
                    icon={<Banknote className="size-4" />}
                  >
                    <PrepareSettlementForm
                      employeeId={employee.id}
                      defaults={{
                        terminationDate: employee.terminationDate
                          ? employee.terminationDate.toISOString().slice(0, 10)
                          : null,
                      }}
                    />
                  </InlineForm>
                ) : (
                  <p className="text-sm text-muted-foreground">No settlement yet.</p>
                )}
              </Panel>
            </Section>
          ) : null}

          <Section title="Work recorded" description="Across every job, all time.">
            <Panel padding="none">
              <ul className="divide-y divide-border text-sm">
                <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <ClipboardCheck className="size-4" />
                    Inspections
                  </span>
                  <span className="font-medium tabular-nums">{counts.inspections}</span>
                </li>
                <li className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <ShieldCheck className="size-4" />
                    Quality checks
                  </span>
                  <span className="font-medium tabular-nums">{counts.qualityChecks}</span>
                </li>
              </ul>
            </Panel>
          </Section>
        </Stack>
      </Grid>
    </Stack>
  );
}
