import Link from 'next/link';
import { Info, Scale } from 'lucide-react';
import type {
  AccountLedger,
  BalanceSheet,
  JournalList,
  LedgerProfitAndLoss,
  TrialBalance,
} from '@/lib/accounting/reports';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { Panel, Section, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill } from '@/components/shared/status-pill';
import { ReverseEntryButton } from '@/components/accounting/books-controls';
import { cn } from '@/lib/utils';

/*
 * The statements read from the general ledger (lib/accounting/reports.ts):
 * profit and loss, balance sheet, trial balance, one account's ledger and
 * the journal. Server-rendered; every amount is already worked out.
 */

const SOURCE_LABEL: Record<string, string> = {
  INVOICE: 'Invoice',
  PAYMENT: 'Payment',
  EXPENSE: 'Expense',
  STOCK_MOVEMENT: 'Stock',
  SUPPLIER_PAYMENT: 'Supplier payment',
  PAYROLL: 'Payroll',
  PAYROLL_PAYMENT: 'Payroll',
  CARD_COLLECTION: 'Payment voucher',
  PAYMENT_VOUCHER: 'Payment voucher',
  PRIOR_PERIOD: 'Before these books',
  FINAL_SETTLEMENT: 'Final settlement',
  FINAL_SETTLEMENT_PAYMENT: 'Final settlement',
  MANUAL: 'Manual',
};

/** One line of a statement: label, amount, and how much it stands out. */
function Row({
  label,
  detail,
  amount,
  href,
  tone = 'default',
  indent,
}: {
  label: string;
  detail?: string;
  amount: string;
  href?: string;
  tone?: 'default' | 'subtotal' | 'total';
  indent?: boolean;
}) {
  const negative = amount.startsWith('-');
  return (
    <li
      className={cn(
        'flex items-baseline justify-between gap-4 px-4 py-3 sm:px-6',
        tone === 'subtotal' && 'bg-muted/40 font-medium',
        tone === 'total' && 'bg-muted/60 text-base font-semibold',
      )}
    >
      <span className={cn('flex min-w-0 flex-col gap-0.5', indent && 'pl-4')}>
        {href ? (
          <Link href={href} className="text-sm hover:underline">
            {label}
          </Link>
        ) : (
          <span className={cn('text-sm', tone === 'total' && 'text-base')}>{label}</span>
        )}
        {detail ? <span className="text-xs text-muted-foreground">{detail}</span> : null}
      </span>
      <span
        className={cn(
          'shrink-0 tabular-nums',
          negative && tone !== 'default' && 'text-danger',
          negative && tone === 'default' && 'text-muted-foreground',
        )}
      >
        {negative ? `(${formatMoney(amount.slice(1))})` : formatMoney(amount)}
      </span>
    </li>
  );
}

/** A cost, shown as money going out: 120.00 → -120.00 (and a credit balance the other way). */
const negate = (amount: string) =>
  amount.startsWith('-') ? amount.slice(1) : amount === '0.00' ? amount : `-${amount}`;

const ledgerHref = (accountId: string, search: string) =>
  `/finance/accounting?view=ledger&account=${accountId}${search}`;

function Figure({
  label,
  amount,
  caption,
  tone,
}: {
  label: string;
  amount: string;
  caption: string;
  tone?: 'good' | 'bad';
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          'text-2xl leading-none font-semibold tabular-nums',
          tone === 'good' && 'text-success',
          tone === 'bad' && 'text-danger',
        )}
      >
        {formatMoney(amount)}
      </span>
      <span className="text-xs text-muted-foreground">{caption}</span>
    </div>
  );
}

// ─── Profit and loss ────────────────────────────────────────────────────────

export function LedgerProfitView({ data, search }: { data: LedgerProfitAndLoss; search: string }) {
  const loss = data.netProfitFils < 0;
  return (
    <Stack gap="xl">
      <Panel className="grid gap-6 sm:grid-cols-3">
        <Figure label="Income" amount={data.income.total} caption="After discounts, excl. VAT" />
        <Figure
          label="Gross profit"
          amount={data.grossProfit}
          caption="Income less the cost of parts sold"
        />
        <Figure
          label="Net profit"
          amount={data.netProfit}
          caption={loss ? 'A loss for the period' : 'After every expense and salary'}
          tone={loss ? 'bad' : 'good'}
        />
      </Panel>
      <Section
        title="Statement"
        description="From the general ledger, accrual basis: counted when billed or incurred, not when paid."
      >
        <Panel padding="none" className="overflow-hidden">
          <ul className="divide-y divide-border">
            {data.income.rows.map((row) => (
              <Row
                key={row.id}
                label={row.name}
                detail={row.code}
                amount={row.amount}
                href={ledgerHref(row.id, search)}
                indent
              />
            ))}
            <Row label="Income" amount={data.income.total} tone="subtotal" />
            {data.costOfSales.rows.map((row) => (
              <Row
                key={row.id}
                label={row.name}
                detail={row.code}
                amount={negate(row.amount)}
                href={ledgerHref(row.id, search)}
                indent
              />
            ))}
            <Row label="Gross profit" amount={data.grossProfit} tone="subtotal" />
            {data.expenses.rows.map((row) => (
              <Row
                key={row.id}
                label={row.name}
                detail={row.code}
                amount={negate(row.amount)}
                href={ledgerHref(row.id, search)}
                indent
              />
            ))}
            <Row label="Total expenses" amount={data.expenses.total} tone="subtotal" />
            <Row label="Net profit" amount={data.netProfit} tone="total" />
          </ul>
        </Panel>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Tap an account to see every entry behind its figure.
        </p>
      </Section>
    </Stack>
  );
}

// ─── Balance sheet ──────────────────────────────────────────────────────────

export function BalanceSheetView({ data, search }: { data: BalanceSheet; search: string }) {
  return (
    <Stack gap="xl">
      {!data.balanced ? (
        <Panel className="border-danger/40 bg-danger/5 text-sm text-danger">
          The balance sheet does not balance. This should never happen — tell your accountant and
          check the trial balance.
        </Panel>
      ) : null}
      <div className="grid gap-8 lg:grid-cols-2">
        <Section
          title="Assets"
          description={`What the workshop has, on ${formatCalendarDate(data.asOf)}.`}
        >
          <Panel padding="none" className="overflow-hidden">
            <ul className="divide-y divide-border">
              {data.assets.rows.length === 0 ? (
                <li className="px-4 py-4 text-sm text-muted-foreground sm:px-6">Nothing yet.</li>
              ) : (
                data.assets.rows.map((row) => (
                  <Row
                    key={row.id}
                    label={row.name}
                    detail={row.code}
                    amount={row.amount}
                    href={ledgerHref(row.id, search)}
                  />
                ))
              )}
              <Row label="Total assets" amount={data.assets.total} tone="total" />
            </ul>
          </Panel>
        </Section>
        <Section
          title="Liabilities and equity"
          description="What it owes, and what belongs to the owner."
        >
          <Panel padding="none" className="overflow-hidden">
            <ul className="divide-y divide-border">
              {data.liabilities.rows.map((row) => (
                <Row
                  key={row.id}
                  label={row.name}
                  detail={row.code}
                  amount={row.amount}
                  href={ledgerHref(row.id, search)}
                />
              ))}
              <Row label="Total liabilities" amount={data.liabilities.total} tone="subtotal" />
              {data.equity.rows.map((row) => (
                <Row
                  key={row.id}
                  label={row.name}
                  detail={row.code}
                  amount={row.amount}
                  href={ledgerHref(row.id, search)}
                />
              ))}
              <Row
                label="Profit to date"
                detail="Income less expenses, not yet closed into retained earnings"
                amount={data.equity.earnings}
              />
              <Row label="Total equity" amount={data.equity.total} tone="subtotal" />
              <Row
                label="Total liabilities and equity"
                amount={data.liabilitiesAndEquity}
                tone="total"
              />
            </ul>
          </Panel>
        </Section>
      </div>
    </Stack>
  );
}

// ─── Trial balance ──────────────────────────────────────────────────────────

export function TrialBalanceView({ data, search }: { data: TrialBalance; search: string }) {
  if (data.rows.length === 0) {
    return (
      <EmptyState
        icon={Scale}
        title="Nothing in the books yet"
        description="Once invoices, payments and expenses are booked, every account with a balance is listed here."
      />
    );
  }
  return (
    <Section
      title="Trial balance"
      description={`Every account's balance on ${formatCalendarDate(data.asOf)}. Debits and credits must be equal.`}
    >
      <Panel padding="none" className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="w-20 px-4 py-3">Code</th>
              <th className="px-2 py-3">Account</th>
              <th className="w-36 px-2 py-3 text-right">Debit</th>
              <th className="w-36 px-4 py-3 text-right">Credit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-3 font-mono text-xs">{row.code}</td>
                <td className="px-2 py-3">
                  <Link href={ledgerHref(row.id, search)} className="hover:underline">
                    {row.name}
                  </Link>
                </td>
                <td className="px-2 py-3 text-right tabular-nums">
                  {row.debit !== '0.00' ? formatMoney(row.debit) : ''}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">
                  {row.credit !== '0.00' ? formatMoney(row.credit) : ''}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t-2 border-border font-semibold">
            <tr>
              <td className="px-4 py-3" colSpan={2}>
                Total{' '}
                {data.balanced ? (
                  <StatusPill tone="success">Balanced</StatusPill>
                ) : (
                  <StatusPill tone="danger">Out of balance</StatusPill>
                )}
              </td>
              <td className="px-2 py-3 text-right tabular-nums">{formatMoney(data.totalDebit)}</td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(data.totalCredit)}</td>
            </tr>
          </tfoot>
        </table>
      </Panel>
    </Section>
  );
}

// ─── One account's ledger ───────────────────────────────────────────────────

export function AccountLedgerView({ data }: { data: AccountLedger }) {
  return (
    <Section
      title={`${data.account.code} · ${data.account.name}`}
      description={`Every entry from ${formatCalendarDate(data.period.from)} to ${formatCalendarDate(data.period.to)}, with the running balance.`}
    >
      <Panel padding="none" className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="w-28 px-4 py-3">Date</th>
              <th className="w-28 px-2 py-3">Entry</th>
              <th className="px-2 py-3">Description</th>
              <th className="w-28 px-2 py-3 text-right">Debit</th>
              <th className="w-28 px-2 py-3 text-right">Credit</th>
              <th className="w-32 px-4 py-3 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            <tr className="bg-muted/20">
              <td className="px-4 py-3 text-muted-foreground" colSpan={5}>
                Opening balance
              </td>
              <td className="px-4 py-3 text-right font-medium tabular-nums">
                {formatMoney(data.opening)}
              </td>
            </tr>
            {data.rows.map((row) => (
              <tr key={row.id} className={cn(row.reversal && 'text-muted-foreground')}>
                <td className="px-4 py-3 whitespace-nowrap">{formatCalendarDate(row.date)}</td>
                <td className="px-2 py-3 font-mono text-xs">{row.entryNumber}</td>
                <td className="px-2 py-3">
                  {row.source.href ? (
                    <Link href={row.source.href} className="hover:underline">
                      {row.description}
                    </Link>
                  ) : (
                    row.description
                  )}
                  <span className="block text-xs text-muted-foreground">
                    {SOURCE_LABEL[row.source.type]}
                    {row.reversal ? ' · reversal' : ''}
                  </span>
                </td>
                <td className="px-2 py-3 text-right tabular-nums">
                  {row.debit ? formatMoney(row.debit) : ''}
                </td>
                <td className="px-2 py-3 text-right tabular-nums">
                  {row.credit ? formatMoney(row.credit) : ''}
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{formatMoney(row.balance)}</td>
              </tr>
            ))}
            {data.rows.length === 0 ? (
              <tr>
                <td className="px-4 py-4 text-muted-foreground" colSpan={6}>
                  No entries in this period.
                </td>
              </tr>
            ) : null}
          </tbody>
          <tfoot className="border-t-2 border-border font-semibold">
            <tr>
              <td className="px-4 py-3" colSpan={5}>
                Closing balance
              </td>
              <td className="px-4 py-3 text-right tabular-nums">{formatMoney(data.closing)}</td>
            </tr>
          </tfoot>
        </table>
      </Panel>
    </Section>
  );
}

// ─── The journal ────────────────────────────────────────────────────────────

export function JournalView({ data, canEdit }: { data: JournalList; canEdit: boolean }) {
  if (data.entries.length === 0) {
    return (
      <EmptyState
        icon={Scale}
        title="No entries in this period"
        description="Every invoice, payment, expense, stock delivery, supplier payment and payroll run is booked here automatically, with anything your accountant enters by hand."
      />
    );
  }
  return (
    <Stack gap="base">
      {data.entries.map((entry) => {
        const reversed = entry.reversals.length > 0;
        return (
          <Panel key={entry.id} padding="none" className="overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                  <span className="font-mono text-xs">{entry.entryNumber}</span>
                  <span>{formatCalendarDate(entry.entryDate)}</span>
                  <StatusPill tone="neutral">{SOURCE_LABEL[entry.sourceType]}</StatusPill>
                  {entry.reversalOf ? (
                    <StatusPill tone="warning">Reverses {entry.reversalOf.entryNumber}</StatusPill>
                  ) : null}
                  {reversed ? (
                    <StatusPill tone="danger">
                      Reversed by {entry.reversals[0].entryNumber}
                    </StatusPill>
                  ) : null}
                </span>
                <span className="text-sm text-muted-foreground">
                  {entry.source.href ? (
                    <Link href={entry.source.href} className="hover:underline">
                      {entry.description}
                    </Link>
                  ) : (
                    entry.description
                  )}{' '}
                  · by {entry.createdBy.fullName}
                </span>
              </div>
              {canEdit && entry.sourceType === 'MANUAL' && !entry.reversalOf && !reversed ? (
                <ReverseEntryButton entryId={entry.id} entryNumber={entry.entryNumber ?? ''} />
              ) : null}
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border">
                {entry.lines.map((line) => {
                  const debit = line.debitAmount.toString();
                  const credit = line.creditAmount.toString();
                  return (
                    <tr key={line.id}>
                      <td className="px-4 py-2 sm:px-6">
                        <span className={cn(Number(credit) > 0 && 'pl-6')}>
                          <span className="font-mono text-xs text-muted-foreground">
                            {line.chartOfAccount.accountCode}
                          </span>{' '}
                          {line.chartOfAccount.accountName}
                        </span>
                        {line.customer || line.supplier ? (
                          <span className="block text-xs font-medium">
                            {line.customer
                              ? `Customer: ${line.customer.name}`
                              : `Supplier: ${line.supplier?.name ?? ''}`}
                          </span>
                        ) : null}
                        {line.description ? (
                          <span className="block text-xs text-muted-foreground">
                            {line.description}
                          </span>
                        ) : null}
                      </td>
                      <td className="w-32 px-2 py-2 text-right tabular-nums">
                        {Number(debit) > 0 ? formatMoney(debit) : ''}
                      </td>
                      <td className="w-32 px-4 py-2 text-right tabular-nums sm:px-6">
                        {Number(credit) > 0 ? formatMoney(credit) : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        );
      })}
    </Stack>
  );
}
