import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Pencil } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getExpenseDetail } from '@/lib/finance/expenses';
import { METHOD_LABEL } from '@/lib/accounting/payment-modes';
import { formatCalendarDate, formatDateTime, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { VoidExpenseButton } from '@/components/finance/void-expense';
import { ExpenseBills } from '@/components/finance/expense-bills';

/** What each change in the history means, in words. */
const ACTION_LABEL: Record<string, string> = {
  'expense.recorded': 'Recorded',
  'expense.updated': 'Changed',
  'expense.voided': 'Voided',
  'expense.filled_from_scan': 'Filled from a scanned bill',
  'expense.bill_attached': 'Bill attached',
  'expense.bill_removed': 'Bill removed',
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right break-words">{children}</dd>
    </>
  );
}

/** One expense: every detail, the bill, how it was booked, and what changed. */
export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let expense;
  try {
    expense = await getExpenseDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthError) return <AccessDenied what="expenses" />;
    throw error;
  }
  const isVoid = expense.status === 'VOID';
  // Input VAT is claimed only on a tax invoice, which shows the supplier's TRN.
  const awaitingTrn =
    !isVoid && !expense.supplierTrn && Number(expense.taxAmount?.toString() ?? 0) > 0;
  const paid = expense.paidByUser
    ? `Personally by ${expense.paidByUser.fullName}`
    : expense.paymentMethod
      ? METHOD_LABEL[expense.paymentMethod]
      : 'Not paid yet';

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/expenses" className="text-primary hover:underline">
            {`Expenses & bills${expense.expenseNumber ? ` · ${expense.expenseNumber}` : ''}`}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {expense.description}
            {isVoid ? (
              <StatusPill tone="danger">Void</StatusPill>
            ) : !expense.paymentMethod && !expense.paidByUser ? (
              <StatusPill tone="warning">Unpaid</StatusPill>
            ) : (
              <StatusPill tone="success">Paid</StatusPill>
            )}
          </span>
        }
        description={`${expense.vendorName ?? 'No supplier recorded'} · ${formatCalendarDate(expense.expenseDate)} · ${formatMoney(expense.total)}`}
        actions={
          <span className="flex flex-wrap items-center gap-2">
            {expense.canEdit ? (
              <LinkButton href={`/finance/expenses/${expense.id}/edit`} variant="outline" size="lg">
                <Pencil />
                Edit
              </LinkButton>
            ) : null}
            {expense.canVoid ? (
              <VoidExpenseButton expenseId={expense.id} description={expense.description} />
            ) : null}
          </span>
        }
      />

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Stack gap="xl" className="xl:col-span-7">
          <Panel className="grid gap-6 sm:grid-cols-3">
            <Figure label="Amount excl. VAT" value={formatMoney(expense.amount.toString())} />
            <Figure
              label={
                expense.taxRate ? `VAT ${expense.taxRate.toString().replace(/\.?0+$/, '')}%` : 'VAT'
              }
              value={expense.taxAmount ? formatMoney(expense.taxAmount.toString()) : '—'}
            />
            <Figure label="Total" value={formatMoney(expense.total)} strong />
          </Panel>

          <Section title="Details">
            <Panel>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <Row label="Voucher number">{expense.expenseNumber ?? '—'}</Row>
                <Row label="Date">{formatCalendarDate(expense.expenseDate)}</Row>
                <Row label="Category">
                  {expense.chartOfAccount
                    ? `${expense.chartOfAccount.accountName} (${expense.chartOfAccount.accountCode})`
                    : 'Uncategorised'}
                </Row>
                {expense.jobCard || expense.invoice ? (
                  <Row label="For job">
                    {expense.jobCard ? (
                      <Link href={`/job-cards/${expense.jobCard.id}`} className="text-primary hover:underline">
                        {expense.jobCard.jobNumber}
                      </Link>
                    ) : (
                      <Link href={`/finance/invoices/${expense.invoice!.id}`} className="text-primary hover:underline">
                        {expense.invoice!.invoiceNumber}
                      </Link>
                    )}
                  </Row>
                ) : null}
                <Row label="Supplier">{expense.vendorName ?? '—'}</Row>
                <Row label="Supplier TRN">
                  {expense.supplierTrn ? (
                    <span className="font-mono">{expense.supplierTrn}</span>
                  ) : awaitingTrn ? (
                    <span className="text-warning">
                      None — its VAT waits, unclaimed, until the TRN from the tax invoice is entered
                    </span>
                  ) : (
                    '—'
                  )}
                </Row>
                <Row label="Bill number">{expense.billNumber ?? '—'}</Row>
                <Row label="Tax code">
                  {expense.taxCode ? `${expense.taxCode.code}, ${expense.taxCode.name}` : '—'}
                </Row>
                <Row label="Paid">{paid}</Row>
                {expense.paidFrom ? (
                  <Row label="Paid from">
                    {`${expense.paidFrom.accountName} (${expense.paidFrom.accountCode})`}
                  </Row>
                ) : null}
                {expense.paymentReference ? (
                  <Row label="Payment reference">{expense.paymentReference}</Row>
                ) : null}
                {expense.dueDate ? (
                  <Row label="Due">{formatCalendarDate(expense.dueDate)}</Row>
                ) : null}
                <Row label="Branch">{expense.branch.name}</Row>
                <Row label="Recorded">
                  {`${formatDateTime(expense.createdAt)} by ${expense.recordedBy.fullName}`}
                </Row>
              </dl>
              {expense.notes ? (
                <p className="mt-4 border-t border-border pt-4 text-sm whitespace-pre-wrap">
                  {expense.notes}
                </p>
              ) : null}
            </Panel>
          </Section>

          <Section
            title="In the books"
            description="How this expense was booked. A change books a reversal and a new entry; nothing booked is ever altered."
          >
            <Panel padding="none" className="overflow-hidden">
              {expense.entries.length === 0 ? (
                <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">
                  Not booked yet. Use “Book records” on the Accounting page.
                </p>
              ) : (
                <div className="divide-y divide-border">
                  {expense.entries.map((entry) => (
                    <div
                      key={entry.id}
                      className={entry.superseded ? 'bg-muted/30 text-muted-foreground' : ''}
                    >
                      <p className="flex flex-wrap items-center gap-2 px-4 pt-3 text-xs sm:px-6">
                        <span className="font-mono">{entry.entryNumber}</span>
                        <span>{formatCalendarDate(entry.entryDate)}</span>
                        {entry.reversalOfJournalEntryId ? (
                          <StatusPill tone="neutral">Reversal</StatusPill>
                        ) : entry.superseded ? (
                          <StatusPill tone="neutral">Replaced</StatusPill>
                        ) : null}
                      </p>
                      <table className="w-full text-sm">
                        <tbody>
                          {entry.lines.map((line, index) => (
                            <tr key={index}>
                              <td className="px-4 py-1.5 sm:px-6">
                                {`${line.chartOfAccount.accountCode} ${line.chartOfAccount.accountName}`}
                              </td>
                              <td className="w-28 px-2 py-1.5 text-right tabular-nums">
                                {Number(line.debitAmount.toString()) > 0
                                  ? formatMoney(line.debitAmount.toString())
                                  : ''}
                              </td>
                              <td className="w-28 px-4 py-1.5 text-right tabular-nums sm:pr-6">
                                {Number(line.creditAmount.toString()) > 0
                                  ? formatMoney(line.creditAmount.toString())
                                  : ''}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="h-2" />
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </Section>
        </Stack>

        <Stack gap="xl" className="xl:col-span-5">
          <Section
            title="The bill"
            description="The supplier’s invoice or receipt, kept as evidence for the VAT reclaimed."
          >
            <Panel>
              <ExpenseBills
                expenseId={expense.id}
                bills={expense.bills}
                canAttach={expense.canAttach}
                canRemove={expense.canEdit}
              />
            </Panel>
          </Section>

          <Section title="History">
            <Panel padding="none">
              {expense.history.length === 0 ? (
                <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">Nothing yet.</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {expense.history.map((row) => (
                    <li key={row.id} className="flex flex-col gap-0.5 px-4 py-3 sm:px-6">
                      <span className="font-medium">{ACTION_LABEL[row.action] ?? row.action}</span>
                      <span className="text-xs text-muted-foreground">
                        {`${formatDateTime(row.createdAt)}${row.actorUser ? ` by ${row.actorUser.fullName}` : ''}`}
                        {row.action === 'expense.voided' &&
                        row.metadata &&
                        typeof row.metadata === 'object' &&
                        'reason' in row.metadata
                          ? `: ${String((row.metadata as { reason?: unknown }).reason)}`
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Section>
        </Stack>
      </Grid>
    </Stack>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={
          strong
            ? 'text-2xl leading-none font-semibold tabular-nums'
            : 'text-2xl leading-none tabular-nums'
        }
      >
        {value}
      </span>
    </div>
  );
}
