import Link from 'next/link';
import { Suspense } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Info,
  KeyRound,
  Receipt,
  ReceiptText,
  ShieldCheck,
  Wallet,
  Wrench,
} from 'lucide-react';
import { requireUser } from '@/lib/auth/authorize';
import { AuthError } from '@/lib/auth/authorize';
import { getFinanceDashboard, type FinanceDashboard } from '@/lib/finance/dashboard';
import { getWorkshopFlow } from '@/lib/data/dashboard';
import { formatDate, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill } from '@/components/shared/status-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import { cn } from '@/lib/utils';

const METHOD_LABEL: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  BANK_TRANSFER: 'Bank transfer',
  CHEQUE: 'Cheque',
  ONLINE: 'Online',
};

/**
 * One figure in the summary strip. Deliberately not a card each: the whole
 * strip is one surface, so the eye compares numbers instead of boxes.
 */
function Figure({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'strong' | 'muted';
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={cn(
          'leading-none font-semibold tracking-[-0.02em] tabular-nums',
          tone === 'strong' ? 'text-2xl sm:text-[28px]' : 'text-xl',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

/** A compact row in one of the "owed" panels. */
function OwedRow({
  href,
  party,
  reference,
  amount,
  meta,
  flagged,
}: {
  href: string;
  party: string;
  reference: string;
  amount: string;
  meta: string;
  flagged?: boolean;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-3 px-4 py-3 hover:bg-muted/60 active:bg-muted sm:px-6"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{party}</span>
          <span className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{reference}</span> · {meta}
          </span>
        </span>
        <span className="shrink-0 text-sm font-semibold tabular-nums">{amount}</span>
        {flagged ? <StatusPill tone="danger">Overdue</StatusPill> : null}
      </Link>
    </li>
  );
}

export default async function FinanceOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  let data: FinanceDashboard;
  try {
    data = await getFinanceDashboard(user, params);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="the workshop's finances" />;
    throw error;
  }
  const { period, access, revenue, expenses, vat, position, receivables, payables, recent } = data;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Finance"
        title="Overview"
        description={`Money in, money owed and what the workshop spent. Every figure below covers ${
          period.key === 'today'
            ? 'today'
            : `${formatDate(period.from)} to ${formatDate(period.to)}`
        }.`}
      />

      <FinancePeriodPicker period={period} />

      {/* Money summary — the first thing on any screen size. */}
      {revenue || expenses ? (
        <Panel className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {revenue ? (
            <>
              <Figure
                label="Invoiced"
                value={formatMoney(revenue.net)}
                hint={`${revenue.count} invoice${revenue.count === 1 ? '' : 's'} · excl. VAT`}
                tone="strong"
              />
              <Figure
                label="Collected"
                value={formatMoney(revenue.collected)}
                hint="Payments received in this period"
                tone="strong"
              />
            </>
          ) : null}
          {expenses ? (
            <Figure
              label="Expenses"
              value={formatMoney(expenses.net)}
              hint={`${expenses.count} recorded · excl. VAT`}
              tone="strong"
            />
          ) : null}
          {position ? (
            <Figure
              label="Revenue less expenses"
              value={formatMoney(position.net)}
              hint="Operating margin for the period"
              tone="strong"
            />
          ) : null}
        </Panel>
      ) : null}

      {/* Warnings worth acting on, before the detail. */}
      {receivables && receivables.overdueCount > 0 ? (
        <Link
          href="/finance/outstanding"
          className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/5 px-4 py-4 text-sm transition-colors hover:bg-danger/10 sm:px-6"
        >
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-medium text-danger">
              {formatMoney(receivables.overdue)} is overdue
            </span>
            <span className="text-muted-foreground">
              {receivables.overdueCount} invoice{receivables.overdueCount === 1 ? '' : 's'} past the
              due date. Open the outstanding list to chase them.
            </span>
          </span>
          <ArrowRight className="mt-0.5 size-4 shrink-0 text-danger" />
        </Link>
      ) : null}

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Stack gap="2xl" className="xl:col-span-7">
          {/* Receivables */}
          {receivables ? (
            <Section
              title="Customers owe"
              description="Issued invoices with a balance. Cancelled invoices and reversed payments never count."
              action={
                <Link
                  href="/finance/outstanding"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary-hover"
                >
                  View all
                  <ArrowRight className="size-4" />
                </Link>
              }
            >
              <Panel padding="none" className="overflow-hidden">
                <div className="grid gap-6 px-4 py-5 sm:grid-cols-3 sm:px-6">
                  <Figure
                    label="Outstanding"
                    value={formatMoney(receivables.balance)}
                    tone="strong"
                  />
                  <Figure
                    label="Unpaid invoices"
                    value={String(receivables.count)}
                    hint={`${receivables.parties} customer${receivables.parties === 1 ? '' : 's'}`}
                  />
                  <Figure
                    label="Overdue"
                    value={formatMoney(receivables.overdue)}
                    hint={`${receivables.overdueCount} past due`}
                    tone={receivables.overdueCount > 0 ? 'default' : 'muted'}
                  />
                </div>
                {receivables.recent.length === 0 ? (
                  <p className="flex items-center gap-2 border-t border-border px-4 py-5 text-sm text-success sm:px-6">
                    <BadgeCheck className="size-4" />
                    Every invoice is settled.
                  </p>
                ) : (
                  <ul className="divide-y divide-border border-t border-border">
                    {receivables.recent.map((row) => (
                      <OwedRow
                        key={row.id}
                        href={row.jobCard ? `/job-cards/${row.jobCard.id}` : '/finance/outstanding'}
                        party={row.party.name}
                        reference={row.number}
                        amount={formatMoney(row.balance)}
                        meta={`${row.ageDays} days old`}
                        flagged={Boolean(
                          row.dueDate && row.ageDays > 0 && row.dueDate < new Date(),
                        )}
                      />
                    ))}
                  </ul>
                )}
              </Panel>
            </Section>
          ) : null}

          {/* Payables */}
          {payables ? (
            <Section
              title="Owed to suppliers"
              description="From purchases actually received — not from stock on hand."
              action={
                <Link
                  href="/finance/outstanding?view=suppliers"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary-hover"
                >
                  View all
                  <ArrowRight className="size-4" />
                </Link>
              }
            >
              <Panel padding="none" className="overflow-hidden">
                <div className="grid gap-6 px-4 py-5 sm:grid-cols-3 sm:px-6">
                  <Figure label="Outstanding" value={formatMoney(payables.balance)} tone="strong" />
                  <Figure label="Unpaid purchases" value={String(payables.count)} />
                  <Figure
                    label="Suppliers"
                    value={String(payables.parties)}
                    hint="With a balance"
                  />
                </div>
                {payables.recent.length === 0 ? (
                  <p className="flex items-center gap-2 border-t border-border px-4 py-5 text-sm text-success sm:px-6">
                    <BadgeCheck className="size-4" />
                    Every purchase is settled.
                  </p>
                ) : (
                  <ul className="divide-y divide-border border-t border-border">
                    {payables.recent.map((row) => (
                      <OwedRow
                        key={row.id}
                        href={`/inventory/purchases/${row.id}`}
                        party={row.party.name}
                        reference={row.number}
                        amount={formatMoney(row.balance)}
                        meta={`${row.ageDays} days old`}
                      />
                    ))}
                  </ul>
                )}
              </Panel>
            </Section>
          ) : null}

          {/* Expenses */}
          {expenses ? (
            <Section
              title="Expenses"
              description="What the workshop spent in this period. Voided expenses are excluded."
              action={
                <Link
                  href="/finance/expenses"
                  className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary-hover"
                >
                  View all
                  <ArrowRight className="size-4" />
                </Link>
              }
            >
              <Panel padding="none" className="overflow-hidden">
                <div className="grid gap-6 px-4 py-5 sm:grid-cols-3 sm:px-6">
                  <Figure label="Net" value={formatMoney(expenses.net)} tone="strong" />
                  <Figure label="VAT" value={formatMoney(expenses.vat)} />
                  <Figure
                    label="Total paid"
                    value={formatMoney(expenses.gross)}
                    hint={`${expenses.count} expense${expenses.count === 1 ? '' : 's'}`}
                  />
                </div>
                {expenses.topCategories.length === 0 ? (
                  <p className="flex items-center gap-3 border-t border-border px-4 py-5 text-sm text-muted-foreground sm:px-6">
                    <ReceiptText className="size-4" />
                    Nothing recorded in this period.
                  </p>
                ) : (
                  <ul className="divide-y divide-border border-t border-border">
                    {expenses.topCategories.map((category) => (
                      <li
                        key={category.id ?? 'uncategorised'}
                        className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6"
                      >
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="truncate text-sm">{category.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {category.count} expense{category.count === 1 ? '' : 's'}
                          </span>
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">
                          {formatMoney(category.net)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </Section>
          ) : null}
        </Stack>

        <Stack gap="xl" className="xl:col-span-5">
          {/* VAT */}
          <Section title="VAT" description={`For ${period.label.toLowerCase()}.`}>
            <Panel className="flex flex-col gap-5">
              {vat.isRegistered ? (
                <>
                  <dl className="flex flex-col gap-3 text-sm">
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">Output VAT (invoiced)</dt>
                      <dd className="font-medium tabular-nums">{formatMoney(vat.output)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <dt className="text-muted-foreground">Input VAT (expenses)</dt>
                      <dd className="font-medium tabular-nums">{formatMoney(vat.input)}</dd>
                    </div>
                    <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
                      <dt className="font-medium">Net VAT</dt>
                      <dd className="text-base font-semibold tabular-nums">
                        {formatMoney(vat.net)}
                      </dd>
                    </div>
                  </dl>
                  <p className="flex items-start gap-2 text-xs text-muted-foreground">
                    <Info className="mt-0.5 size-3.5 shrink-0" />
                    At {vat.rate.replace(/\.?0+$/, '')}%
                    {vat.taxNumber ? ` · TRN ${vat.taxNumber}` : ''}. Input VAT on supplier
                    purchases is not included yet.
                  </p>
                </>
              ) : (
                <div className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                  <div className="flex flex-col gap-1">
                    <p className="text-sm font-medium">This workshop is not VAT-registered</p>
                    <p className="text-sm text-muted-foreground">
                      No VAT is charged on invoices or reported here. New quotation and invoice
                      lines default to 0%.
                    </p>
                  </div>
                </div>
              )}
            </Panel>
          </Section>

          {/* Workshop snapshot — streams separately so money never waits on it. */}
          <Section
            title="In the workshop"
            description="Where the work is right now."
            action={
              <Link
                href="/job-cards"
                className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary-hover"
              >
                Job cards
                <ArrowRight className="size-4" />
              </Link>
            }
          >
            <Suspense fallback={<Skeleton className="h-44 rounded-xl" />}>
              <WorkshopSnapshot organizationId={user.organizationId} />
            </Suspense>
          </Section>

          {/* Recent activity */}
          <Section title="Recent activity" description="The latest money in and out.">
            <Panel padding="none" className="overflow-hidden">
              {recent.payments.length === 0 &&
              recent.invoices.length === 0 &&
              recent.expenses.length === 0 ? (
                <EmptyState
                  icon={Receipt}
                  title="Nothing recorded yet"
                  description="Invoices, payments and expenses will appear here."
                />
              ) : (
                <ul className="divide-y divide-border">
                  {recent.payments.map((payment) => (
                    <li
                      key={`p-${payment.id}`}
                      className="flex items-center gap-3 px-4 py-3 sm:px-6"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
                        <Wallet className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm">
                          Payment from {payment.invoice.customer.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          <span className="font-mono">{payment.invoice.invoiceNumber}</span> ·{' '}
                          {METHOD_LABEL[payment.method] ?? payment.method} ·{' '}
                          {formatDate(payment.receivedAt)}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatMoney(payment.amount)}
                      </span>
                    </li>
                  ))}
                  {recent.invoices.map((invoice) => (
                    <li
                      key={`i-${invoice.id}`}
                      className="flex items-center gap-3 px-4 py-3 sm:px-6"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-info/10 text-info">
                        <Receipt className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm">Invoiced {invoice.customer.name}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          <span className="font-mono">{invoice.invoiceNumber}</span> ·{' '}
                          {formatDate(invoice.issueDate)}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatMoney(invoice.totalAmount)}
                      </span>
                    </li>
                  ))}
                  {recent.expenses.map((expense) => (
                    <li
                      key={`e-${expense.id}`}
                      className="flex items-center gap-3 px-4 py-3 sm:px-6"
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <ReceiptText className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm">{expense.description}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {expense.chartOfAccount?.accountName ?? 'Uncategorised'} ·{' '}
                          {formatDate(expense.expenseDate)}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatMoney(expense.amount)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Section>
        </Stack>
      </Grid>

      {!access.sales || !access.expenses || !access.payables ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Some sections are hidden because your role does not include them.
        </p>
      ) : null}
    </Stack>
  );
}

/** Operational counts, so the owner can connect the money to the floor. */
async function WorkshopSnapshot({ organizationId }: { organizationId: string }) {
  const flow = await getWorkshopFlow(organizationId);
  const rows = [
    {
      label: 'Vehicles in the workshop',
      value: flow.vehiclesCurrentlyIn,
      href: '/job-cards',
      icon: Wrench,
    },
    {
      label: 'Waiting for customer approval',
      value: flow.actions.waitingApproval,
      href: '/approvals',
      icon: BadgeCheck,
    },
    {
      label: 'Under repair',
      value: flow.actions.inRepair,
      href: '/job-cards?status=REPAIR',
      icon: Wrench,
    },
    {
      label: 'Waiting for quality check',
      value: flow.actions.qualityCheck,
      href: '/job-cards?status=QUALITY_CHECK',
      icon: ShieldCheck,
    },
    {
      label: 'Ready for collection',
      value: flow.actions.ready + flow.actions.toDeliver,
      href: '/job-cards?status=READY',
      icon: KeyRound,
    },
    {
      label: "Today's appointments",
      value: flow.todaysAppointments,
      href: '/appointments',
      icon: CalendarDays,
    },
  ];
  return (
    <Panel padding="none" className="overflow-hidden">
      <ul className="divide-y divide-border">
        {rows.map((row) => {
          const Icon = row.icon;
          return (
            <li key={row.label}>
              <Link
                href={row.href}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/60 active:bg-muted sm:px-6"
              >
                <Icon
                  className={cn(
                    'size-4 shrink-0',
                    row.value > 0 ? 'text-primary' : 'text-muted-foreground/50',
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{row.label}</span>
                <span
                  className={cn(
                    'shrink-0 text-sm font-semibold tabular-nums',
                    row.value === 0 && 'text-muted-foreground/50',
                  )}
                >
                  {row.value}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
