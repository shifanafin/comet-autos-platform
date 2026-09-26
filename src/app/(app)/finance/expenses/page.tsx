import { ReceiptText } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getExpenseFormOptions, listExpenses } from '@/lib/finance/expenses';
import { formatDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { SearchField } from '@/components/shared/search-field';
import { StatusPill } from '@/components/shared/status-pill';
import { InlineForm } from '@/components/shared/inline-form';
import { ExpenseForm } from '@/components/finance/expense-form';
import { VoidExpenseButton } from '@/components/finance/void-expense';
import { EditExpenseButton } from '@/components/finance/edit-expense';

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  ONLINE: 'Online',
};

export default async function ExpensesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    category?: string;
    from?: string;
    to?: string;
    show?: string;
  }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, 'accounting.view')) return <AccessDenied what="workshop expenses" />;

  const params = await searchParams;
  const filters = {
    query: (params.q ?? '').trim(),
    categoryId: params.category || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
    show: params.show === 'all' ? ('all' as const) : ('recorded' as const),
  };
  const { expenses, totals } = await listExpenses(user, filters);
  const canRecord = hasPermission(user, 'accounting.create');
  const canVoid = hasPermission(user, 'accounting.edit');
  const formOptions = canRecord || canVoid ? await getExpenseFormOptions(user) : null;
  const draft = (expense: (typeof expenses)[number]) => ({
    id: expense.id,
    description: expense.description,
    amount: expense.amount.toString(),
    // "5.00" → "5"; a whole number like "10" is left alone.
    taxRate: expense.taxRate ? trimDecimal(expense.taxRate.toString()) : '',
    expenseDate: expense.expenseDate.toISOString().slice(0, 10),
    vendorName: expense.vendorName ?? '',
    paymentMethod: expense.paymentMethod ?? '',
    categoryId: expense.chartOfAccount?.id ?? '',
  });
  const filtered = Boolean(filters.query || filters.categoryId || filters.from || filters.to);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Finance"
        title="Expenses"
        description="What the workshop spends to keep running — rent, utilities, supplies. Parts bought for a job are purchases, not expenses."
      />

      {/* Totals for exactly the expenses listed below. */}
      <Panel className="grid gap-6 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Net</span>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {formatMoney(totals.net)}
          </span>
          <span className="text-xs text-muted-foreground">
            {totals.count} expense{totals.count === 1 ? '' : 's'}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">VAT</span>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {formatMoney(totals.tax)}
          </span>
          <span className="text-xs text-muted-foreground">Recoverable input tax</span>
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Total paid</span>
          <span className="text-2xl font-semibold tracking-tight tabular-nums">
            {formatMoney(totals.total)}
          </span>
          <span className="text-xs text-muted-foreground">Net plus VAT</span>
        </div>
      </Panel>

      {canRecord && formOptions ? (
        <Panel padding="none" className="overflow-hidden">
          <InlineForm
            label="Record an expense"
            hint="Rent, utilities, supplies — anything not bought for a specific job."
            icon={<ReceiptText className="size-4" />}
            defaultOpen={expenses.length === 0}
          >
            <ExpenseForm
              categories={formOptions.categories}
              defaultVatRate={formOptions.defaultVatRate}
            />
          </InlineForm>
        </Panel>
      ) : null}

      <Section
        title="Recorded"
        description="Newest first. Voided expenses are kept but excluded from totals."
      >
        <Stack gap="base">
          <SearchField initialQuery={filters.query} placeholder="Description, payee or number" />

          {expenses.length === 0 ? (
            <EmptyState
              icon={ReceiptText}
              title={filtered ? 'No expense matches those filters' : 'No expenses recorded yet'}
              description={
                filtered
                  ? 'Try a different search or a wider date range.'
                  : 'Record what the workshop spends so the month can be explained.'
              }
            />
          ) : (
            <Panel padding="none" className="overflow-hidden">
              <RecordList>
                {expenses.map((expense) => (
                  <RecordCard
                    key={expense.id}
                    className={expense.status === 'VOID' ? 'opacity-60' : undefined}
                    title={expense.description}
                    subtitle={expense.chartOfAccount?.accountName ?? 'Uncategorised'}
                    amount={formatMoney(expense.total)}
                    status={
                      expense.status === 'VOID' ? (
                        <StatusPill tone="neutral">Void</StatusPill>
                      ) : null
                    }
                    details={[
                      { label: 'Date', value: formatDate(expense.expenseDate) },
                      {
                        label: 'VAT',
                        value: expense.taxAmount ? formatMoney(expense.taxAmount) : '—',
                      },
                      {
                        label: 'Paid by',
                        value: expense.paymentMethod
                          ? METHOD_LABEL[expense.paymentMethod]
                          : 'Not settled',
                      },
                    ]}
                    footer={`${expense.vendorName ? `${expense.vendorName} · ` : ''}Recorded by ${expense.recordedBy.fullName}`}
                  >
                    {canVoid && expense.status === 'RECORDED' ? (
                      <span className="flex flex-wrap gap-2">
                        {formOptions ? (
                          <EditExpenseButton
                            expense={draft(expense)}
                            categories={formOptions.categories}
                            defaultVatRate={formOptions.defaultVatRate}
                          />
                        ) : null}
                        <VoidExpenseButton
                          expenseId={expense.id}
                          description={expense.description}
                        />
                      </span>
                    ) : null}
                  </RecordCard>
                ))}
              </RecordList>

              <TableWrap>
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    <tr>
                      <th className="w-28 px-4 py-4 pl-6">Date</th>
                      <th className="min-w-[14rem] px-2 py-4">Expense</th>
                      <th className="px-2 py-4">Paid by</th>
                      <th className="w-24 px-2 py-4 text-right">Net</th>
                      <th className="w-24 px-2 py-4 text-right">VAT</th>
                      <th className="w-28 px-4 py-4 pr-6 text-right">Total</th>
                      {canVoid ? <th className="w-0 px-2 py-4" /> : null}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {expenses.map((expense) => (
                      <tr
                        key={expense.id}
                        className={expense.status === 'VOID' ? 'text-muted-foreground' : undefined}
                      >
                        <td className="px-4 py-4 pl-6 tabular-nums whitespace-nowrap">
                          {formatDate(expense.expenseDate)}
                        </td>
                        <td className="px-2 py-4">
                          <span className="font-medium">{expense.description}</span>
                          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <span>{expense.chartOfAccount?.accountName ?? 'Uncategorised'}</span>
                            {expense.vendorName ? (
                              <>
                                <span aria-hidden>·</span>
                                <span>{expense.vendorName}</span>
                              </>
                            ) : null}
                            {expense.status === 'VOID' ? (
                              <StatusPill tone="neutral">Void</StatusPill>
                            ) : null}
                          </span>
                        </td>
                        <td className="px-2 py-4 text-muted-foreground">
                          {expense.paymentMethod
                            ? METHOD_LABEL[expense.paymentMethod]
                            : 'Not settled'}
                        </td>
                        <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                          {formatMoney(expense.amount)}
                        </td>
                        <td className="px-2 py-4 text-right text-muted-foreground tabular-nums whitespace-nowrap">
                          {expense.taxAmount ? formatMoney(expense.taxAmount) : '—'}
                        </td>
                        <td className="px-4 py-4 pr-6 text-right font-semibold tabular-nums whitespace-nowrap">
                          {formatMoney(expense.total)}
                        </td>
                        {canVoid ? (
                          <td className="px-2 py-4 text-right">
                            {expense.status === 'RECORDED' ? (
                              <span className="inline-flex gap-1">
                                {formOptions ? (
                                  <EditExpenseButton
                                    expense={draft(expense)}
                                    categories={formOptions.categories}
                                    defaultVatRate={formOptions.defaultVatRate}
                                  />
                                ) : null}
                                <VoidExpenseButton
                                  expenseId={expense.id}
                                  description={expense.description}
                                />
                              </span>
                            ) : null}
                          </td>
                        ) : null}
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

function trimDecimal(value: string) {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
