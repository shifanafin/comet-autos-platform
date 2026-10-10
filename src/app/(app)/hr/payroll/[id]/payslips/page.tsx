import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { canSeePay, getPayrollRun, type PayrollRun } from '@/lib/hr/payroll';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { PageHeader, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { PrintButton } from '@/components/shared/print-button';

export const dynamic = 'force-dynamic';

/*
 * The month's payslips: one per person, each on its own sheet when printed
 * (or saved as a PDF to send). From an approved or paid payroll only — a
 * payslip states what was actually paid.
 */

type Line = PayrollRun['lines'][number];

const maskIban = (iban: string | null) =>
  iban ? `${iban.slice(0, 4)} •••• ${iban.slice(-4)}` : null;

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      className={
        strong
          ? 'flex justify-between border-t border-border pt-2 font-semibold'
          : 'flex justify-between'
      }
    >
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function Payslip({ run, line }: { run: PayrollRun; line: Line }) {
  const leave = [
    line.unpaidLeaveDays ? `${line.unpaidLeaveDays} day(s) unpaid` : null,
    line.halfPayDays ? `${line.halfPayDays} day(s) on half pay` : null,
    line.paidLeaveDays > 0 ? `${line.paidLeaveDays} day(s) paid leave` : null,
    line.absentDays ? `${line.absentDays} day(s) absent` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const iban = maskIban(line.employee.salaryIban);
  return (
    <article className="flex flex-col gap-5 rounded-xl border border-border bg-card p-6 break-inside-avoid print:break-after-page print:rounded-none print:border-0 print:p-0">
      <header className="flex flex-col gap-1 border-b border-border pb-4">
        <span className="text-lg font-semibold">{run.company.legalName ?? run.company.name}</span>
        {run.company.address ? (
          <span className="text-xs whitespace-pre-line text-muted-foreground">
            {run.company.address}
          </span>
        ) : null}
        <span className="mt-2 text-sm font-semibold tracking-wide uppercase">
          Payslip — {run.label}
        </span>
        <span className="text-xs text-muted-foreground">
          {formatCalendarDate(run.periodStart)} to {formatCalendarDate(run.periodEnd)}
        </span>
      </header>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Employee</dt>
        <dd className="font-medium">{line.employee.name}</dd>
        <dt className="text-muted-foreground">Employee code</dt>
        <dd className="font-mono">{line.employee.employeeCode}</dd>
        <dt className="text-muted-foreground">Designation</dt>
        <dd>{line.employee.designation?.name ?? line.employee.jobTitle ?? '—'}</dd>
        <dt className="text-muted-foreground">Joined</dt>
        <dd>{formatCalendarDate(line.employee.hireDate)}</dd>
        {iban ? (
          <>
            <dt className="text-muted-foreground">Paid to</dt>
            <dd className="font-mono">{iban}</dd>
          </>
        ) : null}
      </dl>

      <div className="flex flex-col gap-2 text-sm">
        <Row label="Basic salary" value={formatMoney(line.basicSalary)} />
        <Row label="Allowances" value={formatMoney(line.allowances)} />
        {line.overtimePay !== '0.00' ? (
          <Row
            label={`Overtime (${line.overtimeHours} h)`}
            value={`+${formatMoney(line.overtimePay)}`}
          />
        ) : null}
        <Row label="Gross pay" value={formatMoney(line.earned)} strong />
        {line.leaveDeduction !== '0.00' ? (
          <Row label="Unpaid days and absence" value={`−${formatMoney(line.leaveDeduction)}`} />
        ) : null}
        {line.otherDeduction !== '0.00' ? (
          <Row
            label={
              line.otherDeductionKind === 'ADVANCE'
                ? 'Salary advance recovered'
                : line.otherDeductionKind === 'PENALTY'
                  ? 'Penalty'
                  : 'Other deduction'
            }
            value={`−${formatMoney(line.otherDeduction)}`}
          />
        ) : null}
        {line.deductions === '0.00' ? <Row label="Deductions" value={formatMoney('0.00')} /> : null}
        <Row label="Net pay" value={formatMoney(line.netPay)} strong />
      </div>

      {leave ? <p className="text-xs text-muted-foreground">Leave this month: {leave}.</p> : null}
      <p className="text-xs text-muted-foreground">
        Annual leave balance on {formatCalendarDate(run.periodEnd)}: {line.leaveBalanceDays} days.
        End-of-service gratuity earned so far: {formatMoney(line.gratuityLiability)} — payable on
        leaving after a year of service, under UAE Labour Law.
      </p>

      <footer className="mt-4 grid grid-cols-2 gap-6 pt-8 text-xs text-muted-foreground">
        <span className="border-t border-border pt-2">For the company</span>
        <span className="border-t border-border pt-2">Received by the employee</span>
      </footer>
    </article>
  );
}

export default async function PayslipsPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!canSeePay(user)) return <AccessDenied what="payslips" />;
  const { id } = await params;
  let run: PayrollRun;
  try {
    run = await getPayrollRun(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (run.status !== 'APPROVED' && run.status !== 'PAID') notFound();

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href={`/hr/payroll/${run.id}`} className="hover:text-foreground">
            Payroll · {run.label}
          </Link>
        }
        title="Payslips"
        description="One for each person. Print them, or save them as a PDF from the print dialog to send."
        actions={<PrintButton />}
      />
      <div className="print-sheet grid gap-6 @container lg:grid-cols-2 print:block">
        {run.lines.map((line) => (
          <Payslip key={line.id} run={run} line={line} />
        ))}
      </div>
    </Stack>
  );
}
