import Link from 'next/link';
import { ArrowRight, FileText, Receipt } from 'lucide-react';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { getSalesOverview, type SalesOverview } from '@/lib/overview/sales';
import { formatDate, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { StatusPill } from '@/components/shared/status-pill';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import { SettlementPanel } from '@/components/finance/settlement-panel';
import { MonthlyColumns, RankedBars } from '@/components/reports/charts';
import { Kpi, KpiRow } from '@/components/overview/kpi';

export const metadata = { title: 'Sales overview' };
export const dynamic = 'force-dynamic';

/*
 * Sales overview: invoiced, collected and owed against the period before,
 * how quotations turn into work, where each invoice's money stands, the best
 * customers and twelve months of sales.
 */

const PRESETS = ['week', 'month', 'last-month', 'quarter', 'year'] as const;

const STATUS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  ISSUED: { label: 'Unpaid', tone: 'danger' },
  PARTIALLY_PAID: { label: 'Part paid', tone: 'warning' },
  PAID: { label: 'Paid', tone: 'success' },
};

export default async function SalesOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  let data: SalesOverview;
  try {
    data = await getSalesOverview(user, {
      period: params.period ?? 'month',
      from: params.from,
      to: params.to,
    });
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="the sales overview" />;
    throw error;
  }
  const scope = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  const { sales, receivables, quotations, credits } = data;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Customers & Sales"
        title="Sales overview"
        description="What was invoiced and collected, what customers owe, and how quotations turn into work."
        actions={
          <span className="flex flex-wrap gap-2">
            {hasPermission(user, 'quotation.create', scope) ? (
              <Link
                href="/quotations/new"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium hover:bg-muted"
              >
                <FileText className="size-4" />
                New quotation
              </Link>
            ) : null}
            {hasPermission(user, 'invoice.create', scope) ? (
              <Link
                href="/finance/invoices/new"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                <Receipt className="size-4" />
                New invoice
              </Link>
            ) : null}
          </span>
        }
      />

      <FinancePeriodPicker period={data.period} basePath="/sales" presets={[...PRESETS]} />

      <KpiRow>
        <Kpi
          label="Sales"
          value={formatMoney(sales.total)}
          change={sales.totalGrowth}
          compareLabel={data.compareLabel}
          hint={`Excl. VAT · ${formatMoney(data.gross)} with VAT`}
          href="/finance/invoices"
        />
        <Kpi
          label="Invoices issued"
          value={String(sales.count)}
          change={sales.countGrowth}
          compareLabel={data.compareLabel}
          hint={`${sales.customers} customer${sales.customers === 1 ? '' : 's'}`}
        />
        <Kpi
          label="Average invoice"
          value={formatMoney(sales.average)}
          change={sales.averageGrowth}
          compareLabel={data.compareLabel}
          hint="Excl. VAT"
        />
        <Kpi
          label="Collected"
          value={formatMoney(data.collected)}
          change={data.collectedGrowth}
          compareLabel={data.compareLabel}
          hint="Payments received in the period, on any invoice"
          href="/finance/payments"
        />
      </KpiRow>

      <KpiRow>
        {receivables ? (
          <Kpi
            label="Customers owe"
            value={formatMoney(receivables.balance)}
            tone={Number(receivables.overdue) > 0 ? 'bad' : 'default'}
            hint={
              Number(receivables.overdue) > 0
                ? `${formatMoney(receivables.overdue)} overdue on ${receivables.overdueCount} invoice${receivables.overdueCount === 1 ? '' : 's'}`
                : `${receivables.count} unpaid invoice${receivables.count === 1 ? '' : 's'}, none overdue`
            }
            href="/finance/outstanding"
          />
        ) : null}
        {quotations ? (
          <>
            <Kpi
              label="Quotations sent"
              value={String(quotations.sent)}
              hint={`${formatMoney(quotations.sentValue)} quoted, incl. VAT`}
              href="/quotations"
            />
            <Kpi
              label="Quotations won"
              value={quotations.conversion !== null ? `${quotations.conversion}%` : '—'}
              hint={
                quotations.approved + quotations.declined > 0
                  ? `${quotations.approved} approved (${formatMoney(quotations.approvedValue)}) · ${quotations.declined} declined`
                  : 'No customer decisions in the period'
              }
              href="/approvals"
            />
          </>
        ) : null}
        {credits ? (
          <Kpi
            label="Credit notes"
            value={formatMoney(credits.total)}
            hint={`${credits.count} issued in the period, incl. VAT`}
            href="/finance/credit-notes"
          />
        ) : null}
      </KpiRow>

      <Section title="Sales — last 12 months" description="Invoices issued each month, excl. VAT.">
        <Panel>
          <MonthlyColumns data={sales.monthly} caption="Sales by month, excl. VAT" />
        </Panel>
      </Section>

      {data.settlement && sales.count > 0 ? <SettlementPanel settlement={data.settlement} /> : null}

      <Grid gap="xl" className="items-start lg:grid-cols-2">
        <Section title="Top customers" description="By sales in the period, excl. VAT.">
          <Panel padding="none">
            {sales.topCustomers.length ? (
              <RankedBars
                rows={sales.topCustomers.map((row) => ({
                  key: row.id,
                  label: row.name,
                  detail: `${row.count} invoice${row.count === 1 ? '' : 's'}`,
                  value: formatMoney(row.value),
                  weight: row.valueFils,
                }))}
              />
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-6">
                No invoices in this period yet.
              </p>
            )}
          </Panel>
        </Section>
        <Section
          title="Latest invoices"
          action={
            <Link
              href="/finance/invoices"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover"
            >
              All invoices
              <ArrowRight className="size-4" />
            </Link>
          }
        >
          <Panel padding="none">
            {data.recent.length ? (
              <ul className="divide-y divide-border">
                {data.recent.map((invoice) => (
                  <li key={invoice.id}>
                    <Link
                      href={`/finance/invoices/${invoice.id}`}
                      className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 sm:px-6"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">{invoice.customer}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {invoice.number} · {formatDate(invoice.date)}
                        </span>
                      </span>
                      {STATUS[invoice.status] ? (
                        <StatusPill tone={STATUS[invoice.status].tone}>
                          {STATUS[invoice.status].label}
                        </StatusPill>
                      ) : null}
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatMoney(invoice.total)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-6">No invoices yet.</p>
            )}
          </Panel>
        </Section>
      </Grid>
    </Stack>
  );
}
