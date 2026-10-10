import Link from 'next/link';
import { notFound } from 'next/navigation';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getAccountChoices } from '@/lib/accounting/reports';
import { getSettlement, SETTLEMENT_REASON_LABEL } from '@/lib/hr/settlement';
import { formatCalendarDate, formatDateTime, formatMoney, localDateString } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { PrintButton } from '@/components/shared/print-button';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import { InlineForm } from '@/components/shared/inline-form';
import { PrepareSettlementForm, SettlementActions } from '@/components/hr/settlement-forms';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { label: string; tone: PillTone }> = {
  DRAFT: { label: 'Draft — check and approve', tone: 'warning' },
  APPROVED: { label: 'Approved — to pay', tone: 'info' },
  PAID: { label: 'Paid', tone: 'success' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const DAY_MS = 86_400_000;

function Row({
  label,
  detail,
  amount,
  strong,
}: {
  label: string;
  detail?: string;
  amount: string;
  strong?: boolean;
}) {
  return (
    <div
      className={
        strong
          ? 'flex items-baseline justify-between gap-4 border-t border-border pt-3 text-base font-semibold'
          : 'flex items-baseline justify-between gap-4 text-sm'
      }
    >
      <span className="flex flex-col">
        <span>{label}</span>
        {detail ? (
          <span className="text-xs font-normal text-muted-foreground">{detail}</span>
        ) : null}
      </span>
      <span className="shrink-0 tabular-nums">{amount}</span>
    </div>
  );
}

export default async function SettlementPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!hasPermission(user, 'payroll.view')) return <AccessDenied what="final settlements" />;
  const { id } = await params;
  let settlement;
  try {
    settlement = await getSettlement(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const canApprove = hasPermission(user, 'payroll.approve');
  const canPrepare = hasPermission(user, 'payroll.create');
  const accounts = canApprove ? (await getAccountChoices(user)).money : [];
  const name = `${settlement.employee.firstName} ${settlement.employee.lastName}`.trim();
  const termination = settlement.terminationDate.toISOString().slice(0, 10);
  const due = new Date(settlement.terminationDate.getTime() + 14 * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const years = (settlement.serviceDays / 365).toFixed(2);
  const notice = settlement.noticePay.toString();
  const status = STATUS[settlement.status];

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href={`/hr/employees/${settlement.employee.id}`} className="hover:text-foreground">
            {name}
          </Link>
        }
        title={
          <>
            Final settlement
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
          </>
        }
        description={`Leaving ${formatCalendarDate(termination)} · ${SETTLEMENT_REASON_LABEL[settlement.reason]}. Due by ${formatCalendarDate(due)} (14 days, Labour Law Art. 53).`}
        actions={<PrintButton />}
      />

      <Panel className="print-sheet flex flex-col gap-3">
        <div className="mb-2 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <span className="text-muted-foreground">Employee</span>
          <span className="font-medium">
            {name} <span className="font-mono text-xs">{settlement.employee.employeeCode}</span>
          </span>
          <span className="text-muted-foreground">Joined</span>
          <span>{formatCalendarDate(settlement.employee.hireDate)}</span>
          <span className="text-muted-foreground">Service counted</span>
          <span>
            {settlement.serviceDays} days ({years} years) — unpaid leave and absence excluded
          </span>
          <span className="text-muted-foreground">Basic salary</span>
          <span className="tabular-nums">{formatMoney(settlement.basicSalary.toString())}</span>
        </div>
        <Row
          label="End-of-service gratuity"
          detail={
            settlement.serviceDays < 365
              ? 'Less than a year of service: nothing is due (Art. 51).'
              : '21 days’ basic a year for the first 5 years, 30 after (Art. 51).'
          }
          amount={formatMoney(settlement.gratuity.toString())}
        />
        <Row
          label="Unused annual leave"
          detail={`${settlement.leaveDays.toString()} days at basic ÷ 30 (Art. 29).`}
          amount={formatMoney(settlement.leaveEncashment.toString())}
        />
        {notice !== '0' && notice !== '0.00' ? (
          <Row
            label={notice.startsWith('-') ? 'Notice they owe' : 'Notice pay'}
            amount={
              notice.startsWith('-') ? `−${formatMoney(notice.slice(1))}` : formatMoney(notice)
            }
          />
        ) : null}
        {Number(settlement.otherAdditions.toString()) > 0 ? (
          <Row label="Other additions" amount={formatMoney(settlement.otherAdditions.toString())} />
        ) : null}
        {Number(settlement.recoveries.toString()) > 0 ? (
          <Row
            label="Less recoveries"
            detail="Salary advances still owed."
            amount={`−${formatMoney(settlement.recoveries.toString())}`}
          />
        ) : null}
        <Row label="Net payable" amount={formatMoney(settlement.netPayable.toString())} strong />
        <p className="mt-2 text-xs text-muted-foreground">
          Their salary up to the leaving date is paid by that month&apos;s payroll. Set aside so
          far: end-of-service {formatMoney(settlement.gratuityProvision.toString())}, annual leave{' '}
          {formatMoney(settlement.leaveProvision.toString())} — the settlement uses these and books
          only the difference.
        </p>
        {settlement.note ? <p className="text-sm">{settlement.note}</p> : null}
        <div className="mt-6 grid grid-cols-2 gap-6 pt-6 text-xs text-muted-foreground">
          <span className="border-t border-border pt-2">For the company</span>
          <span className="border-t border-border pt-2">
            Received in full and final settlement by the employee
          </span>
        </div>
      </Panel>

      <SettlementActions
        id={settlement.id}
        status={settlement.status}
        net={settlement.netPayable.toString()}
        today={localDateString()}
        accounts={accounts}
        canApprove={canApprove}
      />

      {settlement.status === 'DRAFT' && canPrepare ? (
        <Section title="Change it" description="Recalculates the draft from today's figures.">
          <Panel>
            <InlineForm
              label="Work it out again"
              hint="Change the date, notice, additions or recoveries."
            >
              <PrepareSettlementForm
                employeeId={settlement.employee.id}
                defaults={{
                  terminationDate: termination,
                  reason: settlement.reason,
                  noticePay: notice === '0.00' ? '' : notice,
                  otherAdditions: Number(settlement.otherAdditions.toString())
                    ? settlement.otherAdditions.toString()
                    : '',
                  recoveries: Number(settlement.recoveries.toString())
                    ? settlement.recoveries.toString()
                    : '',
                  note: settlement.note,
                }}
              />
            </InlineForm>
          </Panel>
        </Section>
      ) : null}

      <div className="flex flex-col gap-1 text-xs text-muted-foreground">
        <p>
          Worked out by {settlement.createdBy.fullName} on {formatDateTime(settlement.createdAt)}.
        </p>
        {settlement.approvedAt ? (
          <p>
            Approved by {settlement.approvedBy?.fullName} on {formatDateTime(settlement.approvedAt)}
            .
          </p>
        ) : null}
        {settlement.paidOn ? (
          <p>
            Paid on {formatCalendarDate(settlement.paidOn)}
            {settlement.paidFrom ? ` from ${settlement.paidFrom.accountName}` : ''}.
          </p>
        ) : null}
      </div>
    </Stack>
  );
}
