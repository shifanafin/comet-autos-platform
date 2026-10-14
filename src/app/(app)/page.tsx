import Link from 'next/link';
import { Suspense } from 'react';
import {
  ArrowRight,
  CalendarPlus,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  FileText,
  Hourglass,
  KeyRound,
  PackageMinus,
  PauseCircle,
  Receipt,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { formatMoney, WORKSHOP_LOCALE, WORKSHOP_TIME_ZONE } from '@/lib/format';
import { getGarageSummary, type GarageSummary } from '@/lib/overview/garage';
import { getWorkshopPreferences } from '@/lib/organization/settings';
import { isMenuShown } from '@/lib/nav';
import { Grid, Panel, Section, Stack } from '@/components/layout/primitives';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import { OwedToOwnerLine } from '@/components/finance/owed-to-owner-line';
import { MyDayStrip } from '@/components/team/my-day-strip';
import { RankedBars } from '@/components/reports/charts';
import { Kpi } from '@/components/overview/kpi';
import { GarageNumbers } from '@/components/overview/garage-numbers';
import { AttentionList, WorkshopNow, type AttentionItem } from '@/components/overview/workshop-now';
import { RevenueCostTrend } from '@/components/overview/trend-chart';
import { cn } from '@/lib/utils';

/*
 * The dashboard, in the order the day asks its questions:
 *
 *   1. where every car is right now, stage by stage;
 *   2. what needs someone to act — overdue money, approvals, cars ready;
 *   3. how the garage is doing in the period picked — earned, kept, owed,
 *      in hand — each against the period before;
 *   4. twelve months of revenue against costs, then the workshop and sales
 *      for the period.
 *
 * Starting a job card, quotation or invoice is a small row of buttons at
 * the top; the detail lives in each section's own overview.
 */

export const dynamic = 'force-dynamic';

function greeting(): string {
  const hour = Number(
    new Date().toLocaleString('en-GB', {
      timeZone: WORKSHOP_TIME_ZONE,
      hour: 'numeric',
      hour12: false,
    }),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

const PRESETS = ['month', 'last-month', 'quarter', 'year'] as const;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const input = { period: params.period ?? 'month', from: params.from, to: params.to };
  const scope = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  const preferences = await getWorkshopPreferences(user.organizationId);
  const menu = (href: string) => isMenuShown(href, preferences);
  const today = new Date().toLocaleDateString(WORKSHOP_LOCALE, {
    timeZone: WORKSHOP_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  const actions: { href: string; label: string; icon: LucideIcon; primary?: boolean }[] = [
    ...(hasPermission(user, 'job_card.create', scope)
      ? [{ href: '/check-in', label: 'New job card', icon: ClipboardList, primary: true }]
      : []),
    ...(hasPermission(user, 'quotation.create', scope) && menu('/quotations')
      ? [{ href: '/quotations/new', label: 'Quotation', icon: FileText }]
      : []),
    ...(hasPermission(user, 'invoice.create', scope) && menu('/finance/invoices')
      ? [{ href: '/finance/invoices/new', label: 'Invoice', icon: Receipt }]
      : []),
    ...(hasPermission(user, 'appointment.create', scope) && menu('/appointments')
      ? [{ href: '/appointments/new', label: 'Appointment', icon: CalendarPlus }]
      : []),
  ];

  const summary = await getGarageSummary(user, input);
  const anything =
    summary.profit || summary.money.invoiced !== null || summary.jobs || summary.money.inHand;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      {/* Greeting, and the day's starting points kept small. */}
      <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{today}</p>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            {greeting()}, {user.fullName.split(' ')[0]}
          </h1>
          <p className="text-sm text-muted-foreground">
            {summary.workshopNow
              ? `${plural(summary.workshopNow.inNow, 'car')} in the workshop · ${plural(summary.workshopNow.appointmentsToday, 'appointment')} today`
              : `How the garage is doing — ${summary.period.label.toLowerCase()}.`}
          </p>
        </div>
        {actions.length ? (
          <nav aria-label="Start" className="flex flex-wrap gap-2">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <Link
                  key={action.href}
                  href={action.href}
                  className={cn(
                    'inline-flex h-10 items-center gap-2 rounded-lg border px-3.5 text-sm font-medium whitespace-nowrap transition-colors',
                    action.primary
                      ? 'border-primary bg-primary text-primary-foreground hover:bg-primary-hover'
                      : 'border-border bg-card hover:bg-muted',
                  )}
                >
                  <Icon className="size-4" />
                  {action.label}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </header>

      <Suspense fallback={null}>
        <MyDayStrip user={user} />
      </Suspense>

      {summary.workshopNow ? (
        <Section
          title="In the workshop now"
          description={
            summary.workshopNow.onHold
              ? `Every open job card by stage — ${summary.workshopNow.onHold} on hold besides.`
              : 'Every open job card by stage. Tap one to see the cars in it.'
          }
          action={<SectionLink href="/live">Workshop today</SectionLink>}
        >
          <WorkshopNow
            stages={summary.workshopNow.stages}
            detailed={preferences.detailedJobCards}
          />
        </Section>
      ) : null}

      <Attention summary={summary} menu={menu} />

      {summary.profit || summary.money.invoiced !== null || summary.money.inHand !== null ? (
        <Section
          title="How the garage is doing"
          description={`${summary.period.label} · ${
            comparable(summary)
              ? `changes are ${summary.compareLabel}`
              : 'nothing earlier in the books to compare with yet'
          }`}
        >
          <Stack gap="lg">
            <FinancePeriodPicker period={summary.period} basePath="/" presets={[...PRESETS]} />
            <GarageNumbers summary={summary} />
            {hasPermission(user, 'accounting.view') ? (
              <Suspense fallback={null}>
                <OwedToOwnerLine organizationId={user.organizationId} />
              </Suspense>
            ) : null}
          </Stack>
        </Section>
      ) : null}

      {summary.trend ? (
        <Section
          title="Revenue against costs — last 12 months"
          description="From the books: revenue excl. VAT, against cost of parts and every expense. The gap between the two is the profit."
          action={
            <SectionLink href="/finance/accounting?view=profit">Profit &amp; loss</SectionLink>
          }
        >
          <Panel>
            <RevenueCostTrend data={summary.trend} />
          </Panel>
        </Section>
      ) : null}

      {summary.jobs || summary.sales ? (
        <Grid gap="xl" className="items-start lg:grid-cols-2">
          {summary.jobs ? <WorkshopSummary summary={summary} /> : null}
          {summary.sales ? <SalesSummary summary={summary} /> : null}
        </Grid>
      ) : null}

      {!anything ? (
        <Panel>
          <p className="text-sm text-muted-foreground">
            Your role has no figures to show here. Use the menu to open your work.
          </p>
        </Panel>
      ) : null}
    </Stack>
  );
}

/** "1 car", "3 cars". */
function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function SectionLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:text-primary-hover"
    >
      {children}
      <ArrowRight className="size-4" />
    </Link>
  );
}

/** Whether any figure has an earlier period to be compared with. */
function comparable(summary: GarageSummary) {
  const { profit, money } = summary;
  return [
    profit?.revenueGrowth,
    profit?.netGrowth,
    money.collectedGrowth,
    money.invoicedGrowth,
  ].some((change) => change !== null && change !== undefined);
}

/** The few things worth acting on now, most urgent first, each a tap from its list. */
function Attention({ summary, menu }: { summary: GarageSummary; menu: (href: string) => boolean }) {
  const actions = summary.jobs?.actions;
  const receivables = summary.money.receivables;
  const candidates: (AttentionItem | null)[] = [
    receivables && receivables.overdueCount > 0
      ? {
          href: '/finance/outstanding',
          icon: CircleAlert,
          value: formatMoney(receivables.overdue),
          label: `overdue from customers · ${plural(receivables.overdueCount, 'invoice')}`,
          tone: 'danger',
        }
      : null,
    actions && actions.ready > 0
      ? {
          href: '/job-cards?status=READY',
          icon: Receipt,
          value: plural(actions.ready, 'car'),
          label: 'finished — not invoiced yet',
          tone: 'warning',
        }
      : null,
    actions && actions.toDeliver > 0
      ? {
          href: '/job-cards?status=PAID',
          icon: KeyRound,
          value: plural(actions.toDeliver, 'car'),
          label: 'paid — ready to hand over',
          tone: 'warning',
        }
      : null,
    actions && actions.waitingApproval > 0 && menu('/approvals')
      ? {
          href: '/approvals',
          icon: Hourglass,
          value: plural(actions.waitingApproval, 'quotation'),
          label: 'waiting for the customer to approve',
          tone: 'info',
        }
      : null,
    actions && actions.awaitingPayment > 0
      ? {
          href: '/job-cards?status=INVOICED',
          icon: Wallet,
          value: plural(actions.awaitingPayment, 'car'),
          label: 'invoiced — awaiting payment',
          tone: 'info',
        }
      : null,
    actions && actions.onHold > 0
      ? {
          href: '/job-cards?status=ON_HOLD',
          icon: PauseCircle,
          value: plural(actions.onHold, 'job'),
          label: 'on hold',
          tone: 'warning',
        }
      : null,
    summary.lowStock && menu('/inventory/parts')
      ? {
          href: '/inventory/parts?stock=low',
          icon: PackageMinus,
          value: plural(summary.lowStock, 'part'),
          label: 'low on stock — time to reorder',
          tone: 'warning',
        }
      : null,
  ];
  const items = candidates.filter((item) => item !== null);
  if (items.length === 0) {
    // Only worth saying to someone who would otherwise see items here.
    if (!actions && !receivables) return null;
    return (
      <p className="flex items-center gap-2 rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-sm">
        <CircleCheck className="size-4 shrink-0 text-success" />
        Nothing needs attention — every job is moving and nothing is overdue.
      </p>
    );
  }
  return (
    <Section title="Needs attention" description="Most urgent first. Open one to act on it.">
      <AttentionList items={items} />
    </Section>
  );
}

function WorkshopSummary({ summary }: { summary: GarageSummary }) {
  const jobs = summary.jobs!;
  const figures = [
    { label: 'Average days in', value: jobs.averageDays !== null ? `${jobs.averageDays}` : '—' },
    { label: 'Technician hours', value: jobs.totalHours || '0' },
    { label: 'Cancelled', value: String(jobs.cancelled) },
  ];
  return (
    <Section
      title="Workshop"
      description="Job cards opened and vehicles handed back in the period."
      action={<SectionLink href="/workshop">Workshop overview</SectionLink>}
    >
      <Panel padding="none" className="flex flex-col">
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-t-xl bg-border">
          <div className="bg-card">
            <Kpi
              label="Job cards opened"
              value={String(jobs.opened)}
              change={jobs.openedGrowth}
              compareLabel={summary.compareLabel}
              href="/job-cards"
            />
          </div>
          <div className="bg-card">
            <Kpi
              label="Vehicles delivered"
              value={String(jobs.delivered)}
              change={jobs.deliveredGrowth}
              compareLabel={summary.compareLabel}
            />
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-6 gap-y-3 border-t border-border px-4 py-4 sm:px-5">
          {figures.map((figure) => (
            <div key={figure.label} className="flex flex-col">
              <dt className="text-xs text-muted-foreground">{figure.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{figure.value}</dd>
            </div>
          ))}
        </dl>
        {jobs.makes.length ? (
          <div className="border-t border-border pt-2">
            <p className="px-4 pt-2 text-xs font-medium text-muted-foreground sm:px-6">
              Vehicles by make
            </p>
            <RankedBars
              rows={jobs.makes.slice(0, 5).map((row) => ({
                key: row.make,
                label: row.make,
                value: `${row.count} job${row.count === 1 ? '' : 's'}`,
                weight: row.count,
              }))}
            />
          </div>
        ) : null}
      </Panel>
    </Section>
  );
}

function SalesSummary({ summary }: { summary: GarageSummary }) {
  const sales = summary.sales!;
  return (
    <Section
      title="Sales"
      description="Invoices issued in the period and the customers behind them."
      action={<SectionLink href="/sales">Sales overview</SectionLink>}
    >
      <Panel padding="none" className="flex flex-col">
        <dl className="grid grid-cols-3 gap-x-4 gap-y-3 px-4 py-4 sm:px-5">
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Invoices</dt>
            <dd className="text-lg font-semibold tabular-nums">{sales.count}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Average invoice</dt>
            <dd className="text-lg font-semibold tabular-nums">{formatMoney(sales.average)}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Customers</dt>
            <dd className="text-lg font-semibold tabular-nums">{sales.customers}</dd>
          </div>
        </dl>
        {sales.topCustomers.length ? (
          <div className="border-t border-border pt-2">
            <p className="px-4 pt-2 text-xs font-medium text-muted-foreground sm:px-6">
              Top customers (excl. VAT)
            </p>
            <RankedBars
              rows={sales.topCustomers.slice(0, 5).map((row) => ({
                key: row.id,
                label: row.name,
                detail: `${row.count} invoice${row.count === 1 ? '' : 's'}`,
                value: formatMoney(row.value),
                weight: row.valueFils,
              }))}
            />
          </div>
        ) : (
          <p className="border-t border-border px-4 py-6 text-sm text-muted-foreground sm:px-6">
            No invoices in this period yet.
          </p>
        )}
      </Panel>
    </Section>
  );
}
