import Link from 'next/link';
import { Suspense } from 'react';
import { ArrowRight, Cog, ShoppingCart } from 'lucide-react';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { getInventoryOverview, type InventoryOverview } from '@/lib/overview/inventory';
import { PURCHASE_STATUS_LABEL } from '@/lib/inventory/labels';
import { formatDate, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import { MonthlyColumns, RankedBars } from '@/components/reports/charts';
import { Kpi, KpiRow } from '@/components/overview/kpi';
import { LowStock } from '@/components/dashboard/today-sections';
import { Skeleton } from '@/components/ui/skeleton';

export const metadata = { title: 'Inventory overview' };
export const dynamic = 'force-dynamic';

/*
 * Inventory overview: what the stock is worth, what is low or gone, what was
 * bought and fitted against the period before, the margin on parts, what is
 * owed to suppliers, and twelve months of purchases.
 */

const PRESETS = ['month', 'last-month', 'quarter', 'year'] as const;

export default async function InventoryOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  let data: InventoryOverview;
  try {
    data = await getInventoryOverview(user, {
      period: params.period ?? 'month',
      from: params.from,
      to: params.to,
    });
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="the inventory overview" />;
    throw error;
  }
  const scope = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  const { stock, fitted, purchases, payables } = data;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Parts & Stock"
        title="Inventory overview"
        description="What the stock is worth, what is running low, what was bought and what went into jobs."
        actions={
          <span className="flex flex-wrap gap-2">
            <Link
              href="/inventory/parts"
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium hover:bg-muted"
            >
              <Cog className="size-4" />
              Parts
            </Link>
            {hasPermission(user, 'purchase.create', scope) ? (
              <Link
                href="/inventory/purchases/new"
                className="inline-flex h-10 items-center gap-2 rounded-lg border border-primary bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                <ShoppingCart className="size-4" />
                New purchase
              </Link>
            ) : null}
          </span>
        }
      />

      <FinancePeriodPicker period={data.period} basePath="/inventory" presets={[...PRESETS]} />

      <KpiRow>
        <Kpi
          label="Stock value"
          value={formatMoney(stock.value)}
          hint={`At cost · ${stock.inStock} of ${stock.parts} parts in stock`}
          href="/inventory/parts"
        />
        <Kpi
          label="Low on stock"
          value={String(stock.low)}
          tone={stock.low > 0 ? 'bad' : 'default'}
          hint="At or below their minimum"
          href="/inventory/parts?stock=low"
        />
        <Kpi
          label="Out of stock"
          value={String(stock.out)}
          tone={stock.out > 0 ? 'bad' : 'default'}
          hint="None left on the shelf"
          href="/inventory/parts?stock=out"
        />
        {payables ? (
          <Kpi
            label="We owe suppliers"
            value={formatMoney(payables.balance)}
            hint={`${payables.parties} supplier${payables.parties === 1 ? '' : 's'} · ${payables.count} bill${payables.count === 1 ? '' : 's'}`}
            href="/finance/payables"
          />
        ) : null}
      </KpiRow>

      <KpiRow>
        {purchases ? (
          <Kpi
            label="Bought"
            value={formatMoney(purchases.total)}
            change={purchases.totalGrowth}
            compareLabel={data.compareLabel}
            hint={`${purchases.count} purchase${purchases.count === 1 ? '' : 's'} received, incl. VAT`}
            href="/inventory/purchases"
          />
        ) : null}
        <Kpi
          label="Parts fitted to jobs"
          value={formatMoney(fitted.value)}
          change={fitted.valueGrowth}
          compareLabel={data.compareLabel}
          hint={`At selling price · ${fitted.distinct} different part${fitted.distinct === 1 ? '' : 's'}`}
        />
        <Kpi label="Cost of parts fitted" value={formatMoney(fitted.cost)} hint="At cost price" />
        <Kpi
          label="Margin on parts"
          value={fitted.margin !== null ? `${fitted.margin}%` : '—'}
          tone={fitted.margin !== null && fitted.margin < 0 ? 'bad' : 'default'}
          hint="Selling price over cost, for parts fitted"
        />
      </KpiRow>

      {purchases ? (
        <Section
          title="Purchases — last 12 months"
          description="Supplier bills received each month, incl. VAT."
        >
          <Panel>
            <MonthlyColumns
              data={purchases.monthly}
              caption="Purchases received by month"
              noun="purchase"
              valueHeading="Bought"
            />
          </Panel>
        </Section>
      ) : null}

      <Grid gap="xl" className="items-start lg:grid-cols-2">
        <Section
          title="Parts used most"
          description="Fitted to jobs in the period, at selling price."
        >
          <Panel padding="none">
            {fitted.top.length ? (
              <RankedBars
                rows={fitted.top.map((row) => ({
                  key: row.id,
                  label: row.name,
                  detail: `${row.sku} · ${row.quantity} used · cost ${formatMoney(row.cost)}`,
                  value: formatMoney(row.value),
                  weight: row.valueFils,
                }))}
              />
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-6">
                No parts fitted to jobs in this period. Parts appear when they are recorded on a job
                card.
              </p>
            )}
          </Panel>
        </Section>
        <Section
          title="Running low"
          action={
            <Link
              href="/inventory/parts?stock=low"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover"
            >
              All low stock
              <ArrowRight className="size-4" />
            </Link>
          }
        >
          <Suspense fallback={<Skeleton className="h-24 rounded-xl" />}>
            <LowStock user={user} />
          </Suspense>
        </Section>
      </Grid>

      {data.recent ? (
        <Section
          title="Latest purchases"
          action={
            <Link
              href="/inventory/purchases"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover"
            >
              All purchases
              <ArrowRight className="size-4" />
            </Link>
          }
        >
          <Panel padding="none">
            {data.recent.length ? (
              <ul className="divide-y divide-border">
                {data.recent.map((purchase) => (
                  <li key={purchase.id}>
                    <Link
                      href={`/inventory/purchases/${purchase.id}`}
                      className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 sm:px-6"
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm font-medium">
                          {purchase.supplier.name}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {purchase.purchaseNumber} ·{' '}
                          {PURCHASE_STATUS_LABEL[purchase.status] ?? purchase.status} ·{' '}
                          {formatDate(purchase.receivedAt ?? purchase.createdAt)}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {purchase.totalAmount ? formatMoney(purchase.totalAmount.toString()) : '—'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground sm:px-6">No purchases yet.</p>
            )}
          </Panel>
        </Section>
      ) : null}
    </Stack>
  );
}
