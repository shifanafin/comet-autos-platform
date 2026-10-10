import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Download, Info, Printer, TriangleAlert } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { canSeePay, getPayrollRun, PAYROLL_STATUS_LABEL, type PayrollRun } from '@/lib/hr/payroll';
import { getWpsFile } from '@/lib/hr/wps';
import { formatCalendarDate, formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import { AdjustDeductionButton, PayrollRunActions } from '@/components/hr/payroll-forms';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, PillTone> = {
  DRAFT: 'neutral',
  CALCULATED: 'warning',
  APPROVED: 'info',
  PAID: 'success',
  CANCELLED: 'neutral',
};

type Line = PayrollRun['lines'][number];

/** Leave and absence behind a line, in words. Empty when there is nothing to say. */
function notes(line: Line) {
  return [
    line.unpaidLeaveDays ? `${line.unpaidLeaveDays} unpaid` : null,
    line.halfPayDays ? `${line.halfPayDays} half pay` : null,
    line.paidLeaveDays > 0 ? `${line.paidLeaveDays} paid leave` : null,
    line.absentDays ? `${line.absentDays} absent` : null,
    line.overtimeHours ? `${line.overtimeHours} h overtime` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const DEDUCTION_KIND: Record<string, string> = {
  ADVANCE: 'advance recovered',
  PENALTY: 'penalty',
  OTHER: 'other',
};

/** The deduction, split into its parts, in words. */
function deductionParts(line: Line) {
  return [
    line.leaveDeduction !== '0.00' ? `leave & absence ${formatMoney(line.leaveDeduction)}` : null,
    line.otherDeduction !== '0.00'
      ? `${DEDUCTION_KIND[line.otherDeductionKind ?? 'OTHER']} ${formatMoney(line.otherDeduction)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

export default async function PayrollRunPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!canSeePay(user)) return <AccessDenied what="payroll" />;
  const { id } = await params;

  let run: PayrollRun;
  try {
    run = await getPayrollRun(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canPrepare = hasPermission(user, 'payroll.edit');
  const canApprove = hasPermission(user, 'payroll.approve');
  const editable = run.status === 'CALCULATED' && canPrepare;
  // Paying out: the bank's salary file and the payslips, once approved.
  const payable = run.status === 'APPROVED' || run.status === 'PAID';
  const wps = payable ? await getWpsFile(user, run.id) : null;

  const trail = [
    run.calculatedAt
      ? run.automatic && !run.createdBy
        ? `Calculated automatically ${formatDateTime(run.calculatedAt)}`
        : `Calculated ${formatDateTime(run.calculatedAt)} by ${run.createdBy}`
      : null,
    run.approvedAt ? `Approved ${formatDateTime(run.approvedAt)} by ${run.approvedBy}` : null,
    run.paidAt ? `Paid ${formatDateTime(run.paidAt)} by ${run.paidBy}` : null,
  ].filter(Boolean);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/hr/payroll" className="hover:text-foreground">
            Payroll
          </Link>
        }
        title={
          <>
            {run.label}
            <StatusPill tone={STATUS_TONE[run.status]}>
              {PAYROLL_STATUS_LABEL[run.status]}
            </StatusPill>
          </>
        }
        description={`${formatCalendarDate(run.periodStart)} to ${formatCalendarDate(run.periodEnd)} · ${run.days} days`}
      />

      <Panel className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Employees</span>
          <span className="text-2xl leading-none font-semibold tabular-nums">
            {run.totals.count}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Gross</span>
          <span className="text-2xl leading-none font-semibold tabular-nums">
            {formatMoney(run.totals.gross)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Deductions</span>
          <span className="text-2xl leading-none font-semibold tabular-nums">
            {formatMoney(run.totals.deductions)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Net to pay</span>
          <span className="text-2xl leading-none font-semibold text-primary tabular-nums">
            {formatMoney(run.totals.net)}
          </span>
        </div>
      </Panel>

      <PayrollRunActions
        payrollId={run.id}
        label={run.label}
        status={run.status}
        net={run.totals.net}
        canPrepare={canPrepare}
        canApprove={canApprove}
      />

      <Section
        title="Lines"
        description={
          editable
            ? 'Check each line before approval. Absences are shown but only deducted if you change the deduction.'
            : 'What each person is paid for the month.'
        }
      >
        <Panel padding="none" className="overflow-hidden">
          <RecordList>
            {run.lines.map((line) => (
              <RecordCard
                key={line.id}
                title={line.employee.name}
                subtitle={[line.employee.employeeCode, line.employee.jobTitle]
                  .filter(Boolean)
                  .join(' · ')}
                amount={formatMoney(line.netPay)}
                details={[
                  { label: 'Basic', value: formatMoney(line.basicSalary) },
                  { label: 'Allowances', value: formatMoney(line.allowances) },
                  {
                    label: 'Overtime',
                    value: line.overtimePay !== '0.00' ? formatMoney(line.overtimePay) : null,
                  },
                  { label: 'Deductions', value: deductionParts(line) || formatMoney('0.00') },
                  { label: 'Leave & absence', value: notes(line) || null },
                ]}
              >
                {editable ? (
                  <AdjustDeductionButton
                    payrollId={run.id}
                    itemId={line.id}
                    employeeName={line.employee.name}
                    gross={line.gross}
                    deductions={line.otherDeduction}
                    kind={line.otherDeductionKind}
                    leaveDeduction={line.leaveDeduction}
                  />
                ) : null}
              </RecordCard>
            ))}
          </RecordList>

          <TableWrap>
            <table className="w-full min-w-[920px] text-sm">
              <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-4 pl-6">Employee</th>
                  <th className="px-2 py-4">Leave &amp; absence</th>
                  <th className="w-28 px-2 py-4 text-right">Basic</th>
                  <th className="w-28 px-2 py-4 text-right">Allowances</th>
                  <th className="w-24 px-2 py-4 text-right">Overtime</th>
                  <th className="w-28 px-2 py-4 text-right">Deductions</th>
                  <th className="w-32 px-4 py-4 pr-6 text-right">Net pay</th>
                  {editable ? <th className="w-0 px-2 py-4" /> : null}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {run.lines.map((line) => (
                  <tr key={line.id}>
                    <td className="px-4 py-4 pl-6">
                      <Link
                        href={`/hr/employees/${line.employee.id}`}
                        className="font-medium hover:underline"
                      >
                        {line.employee.name}
                      </Link>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        <span className="font-mono">{line.employee.employeeCode}</span>
                        {line.employee.jobTitle ? ` · ${line.employee.jobTitle}` : ''}
                      </span>
                    </td>
                    <td className="px-2 py-4 text-muted-foreground">{notes(line) || '—'}</td>
                    <td className="px-2 py-4 text-right tabular-nums">
                      {formatMoney(line.basicSalary)}
                    </td>
                    <td className="px-2 py-4 text-right tabular-nums">
                      {formatMoney(line.allowances)}
                    </td>
                    <td className="px-2 py-4 text-right tabular-nums">
                      {line.overtimePay === '0.00' ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        `+${formatMoney(line.overtimePay)}`
                      )}
                    </td>
                    <td className="px-2 py-4 text-right tabular-nums">
                      {line.deductions === '0.00' ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span title={deductionParts(line)}>−{formatMoney(line.deductions)}</span>
                      )}
                    </td>
                    <td className="px-4 py-4 pr-6 text-right font-semibold tabular-nums">
                      {formatMoney(line.netPay)}
                    </td>
                    {editable ? (
                      <td className="px-2 py-4 text-right">
                        <AdjustDeductionButton
                          payrollId={run.id}
                          itemId={line.id}
                          employeeName={line.employee.name}
                          gross={line.gross}
                          deductions={line.otherDeduction}
                          kind={line.otherDeductionKind}
                          leaveDeduction={line.leaveDeduction}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t border-border bg-muted/30 font-semibold">
                <tr>
                  <td className="px-4 py-4 pl-6" colSpan={5}>
                    Total
                  </td>
                  <td className="px-2 py-4 text-right tabular-nums">
                    −{formatMoney(run.totals.deductions)}
                  </td>
                  <td className="px-4 py-4 pr-6 text-right tabular-nums">
                    {formatMoney(run.totals.net)}
                  </td>
                  {editable ? <td /> : null}
                </tr>
              </tfoot>
            </table>
          </TableWrap>
        </Panel>
      </Section>

      {payable && wps ? (
        <Section
          title="Paying the team"
          description="Upload the salary file to the bank or exchange house (WPS), then give each person their payslip."
        >
          <Panel className="flex flex-col gap-4">
            {wps.problems.length ? (
              <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm">
                <p className="flex items-center gap-2 font-medium text-warning">
                  <TriangleAlert className="size-4 shrink-0" />
                  The WPS salary file needs a few details first
                </p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {wps.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="flex flex-wrap gap-3">
              {wps.problems.length === 0 ? (
                <a
                  href={`/hr/payroll/${run.id}/wps`}
                  className="inline-flex h-11 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  <Download className="size-4" />
                  Download WPS salary file
                </a>
              ) : null}
              <Link
                href={`/hr/payroll/${run.id}/payslips`}
                className="inline-flex h-11 items-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-medium hover:bg-muted"
              >
                <Printer className="size-4" />
                Payslips
              </Link>
            </div>
          </Panel>
        </Section>
      ) : null}

      <Section
        title="End-of-service gratuity"
        description={`What each person would be owed if they left on ${formatCalendarDate(run.periodEnd)}, and this month's part of it — set aside in the books with the payroll.`}
      >
        <Panel padding="none" className="overflow-hidden">
          <ul className="divide-y divide-border">
            {run.lines.map((line) => (
              <li
                key={line.id}
                className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[1fr_9rem_9rem] sm:px-6"
              >
                <span className="font-medium">{line.employee.name}</span>
                <span className="text-right tabular-nums text-muted-foreground">
                  {line.gratuityAccrual.startsWith('-')
                    ? `−${formatMoney(line.gratuityAccrual.slice(1))}`
                    : `+${formatMoney(line.gratuityAccrual)}`}{' '}
                  <span className="sm:hidden">this month</span>
                </span>
                <span className="col-span-2 text-right font-semibold tabular-nums sm:col-span-1">
                  {formatMoney(line.gratuityLiability)}
                  <span className="block text-xs font-normal text-muted-foreground">
                    + leave {line.leaveBalanceDays} d · {formatMoney(line.leaveLiability)}
                  </span>
                </span>
              </li>
            ))}
            <li className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 bg-muted/30 px-4 py-3 text-sm font-semibold sm:grid-cols-[1fr_9rem_9rem] sm:px-6">
              <span>Total</span>
              <span className="text-right tabular-nums">
                {run.totals.gratuity.startsWith('-')
                  ? `−${formatMoney(run.totals.gratuity.slice(1))}`
                  : `+${formatMoney(run.totals.gratuity)}`}
              </span>
              <span className="col-span-2 text-right tabular-nums sm:col-span-1">
                {formatMoney(run.gratuityOwed)}
              </span>
            </li>
          </ul>
        </Panel>
        <p className="text-xs text-muted-foreground">
          UAE Labour Law: 21 days of basic salary for each of the first five years, 30 days for each
          year after, at most two years&apos; salary. Nothing is due to someone who leaves in their
          first year — what was set aside for them is released then.
        </p>
      </Section>

      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        {trail.map((line) => (
          <p key={line}>{line}</p>
        ))}
        <p className="flex items-start gap-2">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Salaries are taken as they stood on the last day of the month and pro-rated for anyone who
          joined or left during it. Unpaid days and absence with no approved leave are deducted at
          (basic + allowances) ÷ 30 a day, half-pay days at half that; approved overtime is added at
          +25% or +50% of the hourly basic. Annual leave earned but not taken is set aside with the
          end-of-service, at basic ÷ 30 a day.
        </p>
      </div>
    </Stack>
  );
}
