import { BarChart3, Car, Cog, Info, Receipt, Users, Wrench } from 'lucide-react';
import { canSeeJobProfit } from '@/lib/finance/job-costing';
import { LinkButton } from '@/components/shared/link-button';
import { requireUser } from '@/lib/auth/authorize';
import { AuthError } from '@/lib/auth/authorize';
import { getWorkshopReport, type WorkshopReport } from '@/lib/reports/workshop';
import { formatDate, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import { MonthlyColumns, RankedBars } from '@/components/reports/charts';

export const dynamic = 'force-dynamic';

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

function Empty({ icon, text }: { icon: typeof Car; text: string }) {
  return <EmptyState icon={icon} title={text} description="Choose a wider period to see more." />;
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  let report: WorkshopReport;
  try {
    report = await getWorkshopReport(user, params);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="reports" />;
    throw error;
  }
  const { period, access, sales, workshop, parts } = report;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Reports"
        title="Reports"
        description={`How the workshop did from ${formatDate(period.from)} to ${formatDate(period.to)}: sales, jobs, the team's hours and the parts fitted.`}
        actions={
          canSeeJobProfit(user) ? (
            <LinkButton href="/reports/job-profit" variant="outline" size="lg">
              <Receipt />
              Job profit
            </LinkButton>
          ) : undefined
        }
      />

      <FinancePeriodPicker
        period={period}
        basePath="/reports"
        presets={['week', 'month', 'last-month', 'quarter', 'year']}
      />

      {sales ? (
        <Section
          title="Sales"
          description="Tax invoices issued, excluding VAT. Drafts, voided and cancelled invoices never count."
        >
          <Panel className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            <Figure label="Sales" value={formatMoney(sales.total)} />
            <Figure label="Invoices" value={String(sales.count)} />
            <Figure label="Average invoice" value={formatMoney(sales.average)} />
            <Figure label="Customers billed" value={String(sales.customers)} />
          </Panel>
          <Grid gap="xl" className="items-start xl:grid-cols-12">
            <Panel className="flex flex-col gap-4 xl:col-span-7">
              <div className="flex flex-col gap-1">
                <h3 className="text-sm font-medium">Sales by month</h3>
                <p className="text-xs text-muted-foreground">
                  The twelve months to {sales.monthly[11].label}, excluding VAT.
                </p>
              </div>
              <MonthlyColumns data={sales.monthly} caption="Sales by month, excluding VAT" />
            </Panel>
            <Stack gap="md" className="xl:col-span-5">
              <h3 className="text-sm font-medium">Top customers</h3>
              {sales.topCustomers.length === 0 ? (
                <Empty icon={Users} text="No sales in this period" />
              ) : (
                <Panel padding="none" className="overflow-hidden">
                  <RankedBars
                    rows={sales.topCustomers.map((row) => ({
                      key: row.id,
                      label: row.name,
                      detail: `${row.count} invoice${row.count === 1 ? '' : 's'}`,
                      value: formatMoney(row.value),
                      weight: row.valueFils,
                    }))}
                  />
                </Panel>
              )}
            </Stack>
          </Grid>
        </Section>
      ) : null}

      {workshop ? (
        <Section title="Workshop" description="Jobs opened and handed back in the period.">
          <Panel className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            <Figure
              label="Jobs opened"
              value={String(workshop.opened)}
              hint={workshop.cancelled ? `${workshop.cancelled} since cancelled` : undefined}
            />
            <Figure label="Vehicles delivered" value={String(workshop.delivered)} />
            <Figure
              label="Average turnaround"
              value={workshop.averageDays === null ? '—' : `${workshop.averageDays} days`}
              hint="Check-in to delivery"
            />
            <Figure label="Open right now" value={String(workshop.openNow)} />
          </Panel>
          <Grid gap="xl" className="items-start lg:grid-cols-2">
            <Stack gap="md">
              <h3 className="text-sm font-medium">Technician hours</h3>
              {workshop.technicians.length === 0 ? (
                <Empty icon={Wrench} text="No labour recorded in this period" />
              ) : (
                <Panel padding="none" className="overflow-hidden">
                  <RankedBars
                    rows={workshop.technicians.map((row) => ({
                      key: row.id,
                      label: row.name,
                      detail: `${formatMoney(row.billed)} labour · ${row.entries} entr${row.entries === 1 ? 'y' : 'ies'}`,
                      value: `${row.hours} h`,
                      weight: row.valueFils,
                    }))}
                  />
                </Panel>
              )}
            </Stack>
            <Stack gap="md">
              <h3 className="text-sm font-medium">Makes serviced</h3>
              {workshop.makes.length === 0 ? (
                <Empty icon={Car} text="No jobs opened in this period" />
              ) : (
                <Panel padding="none" className="overflow-hidden">
                  <RankedBars
                    rows={workshop.makes.map((row) => ({
                      key: row.make,
                      label: row.make,
                      value: `${row.count} job${row.count === 1 ? '' : 's'}`,
                      weight: row.count,
                    }))}
                  />
                </Panel>
              )}
            </Stack>
          </Grid>
        </Section>
      ) : null}

      {parts ? (
        <Section
          title="Parts fitted"
          description="Parts used on jobs in the period, after any taken back."
        >
          <Panel className="grid grid-cols-2 gap-6 lg:grid-cols-4">
            <Figure label="Charged at" value={formatMoney(parts.value)} />
            <Figure label="Cost" value={formatMoney(parts.cost)} />
            <Figure label="Parts margin" value={parts.margin === null ? '—' : `${parts.margin}%`} />
            <Figure label="Different parts" value={String(parts.distinct)} />
          </Panel>
          {parts.top.length === 0 ? (
            <Empty icon={Cog} text="No parts fitted in this period" />
          ) : (
            <Panel padding="none" className="overflow-hidden">
              <RankedBars
                rows={parts.top.map((row) => ({
                  key: row.id,
                  label: row.name,
                  detail: `${row.sku} · ${row.quantity} fitted · cost ${formatMoney(row.cost)}`,
                  value: formatMoney(row.value),
                  weight: row.valueFils,
                }))}
              />
            </Panel>
          )}
        </Section>
      ) : null}

      {!access.sales || !access.workshop || !access.parts ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          Some reports are hidden because your role does not include them.
        </p>
      ) : null}

      {!sales && !workshop && !parts ? (
        <EmptyState icon={BarChart3} title="No reports available for your role" />
      ) : null}
    </Stack>
  );
}
