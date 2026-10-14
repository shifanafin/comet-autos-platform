import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getReconciliation } from '@/lib/accounting/reconciliation';
import { getStatementView } from '@/lib/accounting/statement-import';
import { formatCalendarDate, formatDateTime, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { StatusPill } from '@/components/shared/status-pill';
import { PrintButton } from '@/components/shared/print-button';
import { ReconciliationSheet } from '@/components/accounting/reconciliation-controls';
import { StatementLines } from '@/components/accounting/statement-lines';

const money = (value: string) =>
  value.startsWith('-') ? `−${formatMoney(value.slice(1))}` : formatMoney(value);

export default async function ReconciliationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let detail;
  let statement;
  try {
    [detail, statement] = await Promise.all([
      getReconciliation(user, id),
      getStatementView(user, id),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthError) return <AccessDenied what="bank reconciliation" />;
    throw error;
  }
  const completed = detail.status === 'COMPLETED';
  const canEdit = hasPermission(user, 'accounting.edit');

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/bank-reconciliation" className="text-primary hover:underline">
            Bank reconciliation
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {`${detail.account.accountCode} ${detail.account.accountName}`}
            {completed ? (
              <StatusPill tone="success">Reconciled</StatusPill>
            ) : (
              <StatusPill tone="warning">In progress</StatusPill>
            )}
          </span>
        }
        description={`Statement to ${formatCalendarDate(detail.statementDate)}, closing balance ${money(detail.statementBalance)}. Started by ${detail.createdBy}${
          completed && detail.completedAt
            ? `; completed by ${detail.completedBy ?? '—'} on ${formatDateTime(detail.completedAt)}`
            : ''
        }.`}
        actions={<PrintButton />}
      />

      <div className="print-sheet flex flex-col gap-6">
        <p className="hidden text-base font-semibold print:block">
          {`Bank reconciliation — ${detail.account.accountCode} ${detail.account.accountName} — to ${formatCalendarDate(detail.statementDate)}`}
        </p>
        {statement ? (
          <StatementLines
            reconciliationId={detail.id}
            editable={!completed && canEdit}
            view={statement}
            fileName={detail.statementFileName}
            books={detail.rows}
          />
        ) : null}
        {statement ? <p className="text-base font-semibold print:hidden">In the books</p> : null}
        <ReconciliationSheet
          key={`${detail.status}-${detail.rows.length}-${detail.tickVersion}`}
          detail={detail}
        />

        <Panel>
          <p className="mb-3 text-sm font-semibold">Reconciliation statement</p>
          <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">
              {`Balance in the books on ${formatCalendarDate(detail.statementDate)}`}
            </dt>
            <dd className="text-right tabular-nums">{money(detail.bookBalance)}</dd>
            <dt className="text-muted-foreground">Add: payments not yet presented to the bank</dt>
            <dd className="text-right tabular-nums">{formatMoney(detail.outstandingPayments)}</dd>
            <dt className="text-muted-foreground">Less: money in not yet credited by the bank</dt>
            <dd className="text-right tabular-nums">
              {`−${formatMoney(detail.depositsInTransit)}`}
            </dd>
            <dt className="font-semibold">Balance per bank statement</dt>
            <dd className="text-right font-semibold tabular-nums">
              {money(detail.statementBalance)}
            </dd>
          </dl>
          <p className="mt-3 text-xs text-muted-foreground">
            The two agree once the reconciliation is complete (difference nil). Unticked lines above
            are the payments and money in that make up the difference, and carry forward to the next
            statement.
          </p>
        </Panel>
      </div>
    </Stack>
  );
}
