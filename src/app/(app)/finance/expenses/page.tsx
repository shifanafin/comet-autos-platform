import Link from 'next/link';
import { ReceiptText } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getExpenseFormOptions, listExpenses, toExpenseDraft } from '@/lib/finance/expenses';
import { formatDate, formatMoney } from '@/lib/format';
import { loadPage, pageFrom } from '@/lib/pagination';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { Pagination } from '@/components/shared/pagination';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { SearchField } from '@/components/shared/search-field';
import { StatusPill } from '@/components/shared/status-pill';
import { ScanExpense } from '@/components/finance/scan-expense';
import { VoidExpenseButton } from '@/components/finance/void-expense';
import { EditExpenseButton } from '@/components/finance/edit-expense';
import { ExpenseBills } from '@/components/finance/expense-bills';
import { listExpenseBills } from '@/lib/finance/expense-bills';
import { canImport, importColumns, importNote } from '@/lib/data-transfer/imports';
import { ListDataActions } from '@/components/shared/list-data-actions';

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
    page?: string;
  }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, 'expense.view')) return <AccessDenied what="workshop expenses" />;

  const params = await searchParams;
  const filters = {
    query: (params.q ?? '').trim(),
    categoryId: params.category || undefined,
    from: params.from || undefined,
    to: params.to || undefined,
    show: params.show === 'all' ? ('all' as const) : ('recorded' as const),
  };
  const {
    result: { expenses, totals },
    info,
  } = await loadPage(pageFrom(params.page), (skip, take) =>
    listExpenses(user, filters, take, skip),
  );
  const canRecord = hasPermission(user, 'expense.create');
  const canEdit = hasPermission(user, 'expense.edit');
  const canVoid = hasPermission(user, 'expense.delete');
  const canChange = canEdit || canVoid;
  const formOptions = canRecord || canEdit ? await getExpenseFormOptions(user) : null;
  // The supplier's bill behind each expense, kept as evidence for the VAT reclaimed.
  const bills = await listExpenseBills(
    user,
    expenses.map((expense) => expense.id),
  );
  const billsCell = (expense: (typeof expenses)[number]) => (
    <ExpenseBills
      expenseId={expense.id}
      bills={bills.get(expense.id) ?? []}
      canAttach={canRecord && expense.status === 'RECORDED'}
      canRemove={canEdit && expense.status === 'RECORDED'}
    />
  );
  const draft = (expense: (typeof expenses)[number]) => toExpenseDraft(expense);
  /** How it was paid, in words: an account's method, an owner personally, or not yet. */
  const paidBy = (expense: (typeof expenses)[number]) =>
    expense.paidByUser
      ? `Paid personally by ${expense.paidByUser.fullName}`
      : expense.paymentMethod
        ? METHOD_LABEL[expense.paymentMethod]
        : 'Not settled';
  const filtered = Boolean(filters.query || filters.categoryId || filters.from || filters.to);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Suppliers & Bills"
        title="Expenses & bills"
        description="What the workshop spends to keep running — rent, utilities, supplies. Parts bought for a job are purchases, not expenses."
        actions={
          canImport(user, 'expenses') ? (
            <ListDataActions
              entity="expenses"
              label="expenses"
              canImport
              columns={importColumns('expenses')}
              note={importNote('expenses')}
            />
          ) : undefined
        }
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
        <ScanExpense
          categories={formOptions.categories}
          defaultVatRate={formOptions.defaultVatRate}
          taxCodes={formOptions.taxCodes}
          modes={formOptions.modes}
          people={formOptions.people}
          jobs={formOptions.jobs}
          moneyAccounts={formOptions.moneyAccounts}
        />
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
                    title={
                      <Link href={`/finance/expenses/${expense.id}`} className="hover:underline">
                        {expense.description}
                      </Link>
                    }
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
                        value: paidBy(expense),
                      },
                    ]}
                    footer={`${expense.vendorName ? `${expense.vendorName} · ` : ''}Recorded by ${expense.recordedBy.fullName}`}
                  >
                    {billsCell(expense)}
                    {canChange && expense.status === 'RECORDED' ? (
                      <span className="flex flex-wrap gap-2">
                        {canEdit && formOptions ? (
                          <EditExpenseButton
                            expense={draft(expense)}
                            categories={formOptions.categories}
                            defaultVatRate={formOptions.defaultVatRate}
                            taxCodes={formOptions.taxCodes}
                            modes={formOptions.modes}
                            people={formOptions.people}
                            jobs={formOptions.jobs}
                            moneyAccounts={formOptions.moneyAccounts}
                          />
                        ) : null}
                        {canVoid ? (
                          <VoidExpenseButton
                            expenseId={expense.id}
                            description={expense.description}
                          />
                        ) : null}
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
                      <th className="px-2 py-4">Bill</th>
                      {canChange ? <th className="w-0 px-2 py-4" /> : null}
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
                          <Link
                            href={`/finance/expenses/${expense.id}`}
                            className="font-medium hover:underline"
                          >
                            {expense.description}
                          </Link>
                          {expense.expenseNumber ? (
                            <span className="ml-2 font-mono text-xs text-muted-foreground">
                              {expense.expenseNumber}
                            </span>
                          ) : null}
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
                        <td className="px-2 py-4 text-muted-foreground">{paidBy(expense)}</td>
                        <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                          {formatMoney(expense.amount)}
                        </td>
                        <td className="px-2 py-4 text-right text-muted-foreground tabular-nums whitespace-nowrap">
                          {expense.taxAmount ? formatMoney(expense.taxAmount) : '—'}
                        </td>
                        <td className="px-4 py-4 pr-6 text-right font-semibold tabular-nums whitespace-nowrap">
                          {formatMoney(expense.total)}
                        </td>
                        <td className="px-2 py-4">{billsCell(expense)}</td>
                        {canChange ? (
                          <td className="px-2 py-4 text-right">
                            {expense.status === 'RECORDED' ? (
                              <span className="inline-flex gap-1">
                                {canEdit && formOptions ? (
                                  <EditExpenseButton
                                    expense={draft(expense)}
                                    categories={formOptions.categories}
                                    defaultVatRate={formOptions.defaultVatRate}
                                    taxCodes={formOptions.taxCodes}
                                    modes={formOptions.modes}
                                    people={formOptions.people}
                                    jobs={formOptions.jobs}
                                    moneyAccounts={formOptions.moneyAccounts}
                                  />
                                ) : null}
                                {canVoid ? (
                                  <VoidExpenseButton
                                    expenseId={expense.id}
                                    description={expense.description}
                                  />
                                ) : null}
                              </span>
                            ) : null}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              <Pagination
                info={info}
                basePath="/finance/expenses"
                params={params}
                noun="expenses"
              />
            </Panel>
          )}
        </Stack>
      </Section>
    </Stack>
  );
}
