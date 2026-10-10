import { CalendarOff } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import {
  getLeaveFormOptions,
  LEAVE_STATUS_LABEL,
  LEAVE_TYPE_LABEL,
  listLeave,
  type LeaveRow,
} from '@/lib/hr/leave';
import { formatCalendarDate } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { InlineForm } from '@/components/shared/inline-form';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import { ListFilters } from '@/components/inventory/list-filters';
import { LeaveForm } from '@/components/hr/leave-form';
import { LeaveActions } from '@/components/hr/leave-actions';

export const dynamic = 'force-dynamic';

const STATUS_TONE: Record<string, PillTone> = {
  PENDING: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

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

function dates(row: LeaveRow) {
  return row.days === 1
    ? formatCalendarDate(row.startDate)
    : `${formatCalendarDate(row.startDate)} – ${formatCalendarDate(row.endDate)}`;
}

function Status({ row }: { row: LeaveRow }) {
  if (row.isCurrent) return <StatusPill tone="primary">Off today</StatusPill>;
  return <StatusPill tone={STATUS_TONE[row.status]}>{LEAVE_STATUS_LABEL[row.status]}</StatusPill>;
}

export default async function LeavePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; type?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, 'leave.view')) return <AccessDenied what="the team's leave" />;
  const params = await searchParams;

  const { rows, totals } = await listLeave(user, {
    query: params.q,
    status: params.status,
    type: params.type,
  });
  const canRecord = hasPermission(user, 'leave.create');
  const canApprove = hasPermission(user, 'leave.approve');
  const options = canRecord ? await getLeaveFormOptions(user) : null;
  const filtered = Boolean(params.q || params.status || params.type);

  const decidedBy = (row: LeaveRow) =>
    row.approvedBy && row.status !== 'PENDING'
      ? `${row.status === 'REJECTED' ? 'Rejected' : 'Decided'} by ${row.approvedBy.fullName}`
      : null;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="HR & Payroll"
        title="Leave"
        description="Who is off, and when. Requests wait for approval; unpaid leave is deducted in the payroll run."
      />

      <Panel className="grid grid-cols-2 gap-6 sm:grid-cols-3">
        <Figure
          label="Waiting for approval"
          value={String(totals.pending)}
          hint={totals.pending ? 'Needs a decision' : 'Nothing waiting'}
        />
        <Figure
          label="Off today"
          value={String(totals.offToday)}
          hint={totals.offTodayNames.slice(0, 3).join(', ') || 'Everyone is in'}
        />
        <Figure label="Starting in the next 30 days" value={String(totals.upcoming)} />
      </Panel>

      {options ? (
        <Panel padding="none" className="overflow-hidden">
          <InlineForm
            label="Record leave"
            hint="Annual, sick, unpaid or other time off."
            icon={<CalendarOff className="size-4" />}
            defaultOpen={rows.length === 0 && !filtered}
          >
            {options.employees.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Add someone to the team before recording leave.
              </p>
            ) : (
              <LeaveForm employees={options.employees} canApprove={options.canApprove} />
            )}
          </InlineForm>
        </Panel>
      ) : null}

      <Section title="Leave records" description="Most recent first. Nothing is ever deleted.">
        <Stack gap="base">
          <ListFilters
            placeholder="Employee name or code"
            selects={[
              {
                name: 'status',
                label: 'Status',
                options: [
                  { value: '', label: 'Any status' },
                  { value: 'PENDING', label: 'Waiting for approval' },
                  { value: 'APPROVED', label: 'Approved' },
                  { value: 'REJECTED', label: 'Rejected' },
                  { value: 'CANCELLED', label: 'Cancelled' },
                ],
              },
              {
                name: 'type',
                label: 'Kind',
                options: [
                  { value: '', label: 'Any kind' },
                  { value: 'ANNUAL', label: 'Annual' },
                  { value: 'SICK', label: 'Sick' },
                  { value: 'UNPAID', label: 'Unpaid' },
                  { value: 'OTHER', label: 'Other' },
                ],
              },
            ]}
          />

          {rows.length === 0 ? (
            <EmptyState
              icon={CalendarOff}
              title={filtered ? 'No leave matches those filters' : 'No leave recorded yet'}
              description={
                filtered
                  ? 'Try a different name, status or kind.'
                  : 'Record time off here so attendance and payroll can account for it.'
              }
            />
          ) : (
            <Panel padding="none" className="overflow-hidden">
              <RecordList>
                {rows.map((row) => (
                  <RecordCard
                    key={row.id}
                    className={
                      row.status === 'CANCELLED' || row.status === 'REJECTED'
                        ? 'opacity-70'
                        : undefined
                    }
                    title={row.employeeName}
                    subtitle={`${LEAVE_TYPE_LABEL[row.leaveType]} leave`}
                    amount={`${row.days} day${row.days === 1 ? '' : 's'}`}
                    status={<Status row={row} />}
                    details={[
                      { label: 'Dates', value: dates(row) },
                      { label: 'Pay', value: row.pay || null },
                      { label: 'Reason', value: row.reason },
                    ]}
                    footer={decidedBy(row)}
                  >
                    <LeaveActions
                      leaveId={row.id}
                      employeeName={row.employeeName}
                      status={row.status}
                      canApprove={canApprove}
                      canCancel={canRecord}
                    />
                  </RecordCard>
                ))}
              </RecordList>

              <TableWrap>
                <table className="w-full min-w-[760px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    <tr>
                      <th className="px-4 py-4 pl-6">Employee</th>
                      <th className="px-2 py-4">Kind</th>
                      <th className="px-2 py-4">Dates</th>
                      <th className="w-16 px-2 py-4 text-right">Days</th>
                      <th className="px-2 py-4">Status</th>
                      <th className="w-0 px-4 py-4 pr-6" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className={
                          row.status === 'CANCELLED' || row.status === 'REJECTED'
                            ? 'text-muted-foreground'
                            : undefined
                        }
                      >
                        <td className="px-4 py-4 pl-6">
                          <span className="font-medium">{row.employeeName}</span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            <span className="font-mono">{row.employee.employeeCode}</span>
                            {row.reason ? ` · ${row.reason}` : ''}
                          </span>
                        </td>
                        <td className="px-2 py-4">{LEAVE_TYPE_LABEL[row.leaveType]}</td>
                        <td className="px-2 py-4 tabular-nums whitespace-nowrap">{dates(row)}</td>
                        <td className="px-2 py-4 text-right tabular-nums">
                          {row.days}
                          {row.pay ? (
                            <span className="block text-xs whitespace-nowrap text-muted-foreground">
                              {row.pay}
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-4">
                          <span className="flex flex-col gap-1">
                            <Status row={row} />
                            {decidedBy(row) ? (
                              <span className="text-xs text-muted-foreground">
                                {decidedBy(row)}
                              </span>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-4 py-4 pr-6 text-right">
                          <LeaveActions
                            leaveId={row.id}
                            employeeName={row.employeeName}
                            status={row.status}
                            canApprove={canApprove}
                            canCancel={canRecord}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Panel>
          )}
        </Stack>
      </Section>
    </Stack>
  );
}
