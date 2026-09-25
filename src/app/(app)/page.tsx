import Link from 'next/link';
import { Suspense, cache } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  CalendarPlus,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  FileText,
  KeyRound,
  LogIn,
  PackageCheck,
  Plus,
  PauseCircle,
  Receipt,
  ShieldCheck,
  Wallet,
  Wrench,
} from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import type { AuthenticatedUser } from '@/lib/auth/session';
import {
  getDocumentCounts,
  getFinanceSnapshot as fetchFinance,
  getLowStockParts as fetchLowStock,
  getRecentJobCards,
  getTodaysActivity,
  getTodaysAppointments,
  getWorkshopFlow as fetchWorkshopFlow,
  type ActivityKind,
} from '@/lib/data/dashboard';
import { formatMoney, formatTime, WORKSHOP_TIME_ZONE } from '@/lib/format';
import { formatMilli } from '@/lib/money';
import { Grid, Panel, Section, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { QuickAction } from '@/components/shared/quick-action';
import { WorkshopFlowRow } from '@/components/shared/workshop-flow-row';
import { JobStatusBadge } from '@/components/shared/job-status-badge';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { StockPill } from '@/components/inventory/stock-level';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { getWorkshopPreferences } from '@/lib/organization/settings';
import { isMenuShown } from '@/lib/nav';
import { visibleStages } from '@/lib/workshop/stages';

// Several independently-streamed sections read the same queries; cache()
// dedupes them to one database round-trip per request.
const getWorkshopFlow = cache(fetchWorkshopFlow);
const getLowStock = cache(fetchLowStock);
const getFinanceSnapshot = cache(fetchFinance);

function dubaiHour() {
  return Number(
    new Date().toLocaleString('en-GB', {
      timeZone: WORKSHOP_TIME_ZONE,
      hour: 'numeric',
      hour12: false,
    }),
  );
}

function greeting(): string {
  const hour = dubaiHour();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default async function DashboardPage() {
  const user = await requireUser();
  const firstName = user.fullName.split(' ')[0];
  const today = new Date().toLocaleDateString('en-AE', {
    timeZone: WORKSHOP_TIME_ZONE,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const org = user.organizationId;
  const scope = user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined;
  const canFinance = hasPermission(user, 'invoice.view', scope);
  const canInventory = hasPermission(user, 'inventory.view', scope);
  const canCheckIn = hasPermission(user, 'job_card.create', scope);
  const canQuote = hasPermission(user, 'job_card.edit', scope);
  const canInvoice = hasPermission(user, 'invoice.create', scope);
  const preferences = await getWorkshopPreferences(user.organizationId);
  const standardJobCards = preferences.detailedJobCards;
  // A menu the workshop chose to hide takes its dashboard pieces with it:
  // hiding Parts hides Low stock, hiding Quotations hides their tile, etc.
  const menu = (href: string) => isMenuShown(href, preferences);
  const show = {
    quotations: menu('/quotations'),
    invoices: canFinance && menu('/finance/invoices'),
    payments: canFinance && menu('/finance/payments'),
    appointments: menu('/appointments'),
    lowStock: canInventory && menu('/inventory/parts'),
  };
  const sideColumn = show.appointments || show.lowStock;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{today}</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          {greeting()}, {firstName}
        </h1>
        <p className="text-base text-muted-foreground">What do you need?</p>
      </header>

      {/* The three things done every day, first and biggest. */}
      <StartActions
        canCheckIn={canCheckIn}
        canQuote={canQuote && show.quotations}
        canInvoice={canInvoice && menu('/finance/invoices')}
      />

      <Suspense fallback={<CountsSkeleton />}>
        <DocumentCounts
          organizationId={org}
          quotations={show.quotations}
          invoices={show.invoices}
          payments={show.payments}
        />
      </Suspense>

      <Section
        title="Today"
        description="Work orders opened, quotations started, invoices issued and payments taken today."
      >
        <Suspense fallback={<Skeleton className="h-40 rounded-xl" />}>
          <TodaysActivity
            organizationId={org}
            canFinance={canFinance}
            kinds={[
              'work_order',
              ...(show.quotations ? (['quotation'] as const) : []),
              ...(menu('/finance/invoices') ? (['invoice'] as const) : []),
              ...(show.payments ? (['payment'] as const) : []),
            ]}
          />
        </Suspense>
      </Section>

      {/*
       * The detailed workshop lifecycle — inspection, diagnosis, approval,
       * repair, quality check, delivery — stays here for the jobs that go
       * through it. It is below the daily work, not in front of it, and only
       * shown when the workshop uses the standard job card.
       */}
      {standardJobCards ? (
        <Section
          title="Detailed workflow"
          description="Work orders that are going through inspection, repair and quality check."
          action={
            <span className="flex flex-wrap gap-2">
              {canCheckIn && show.appointments ? (
                <QuickAction href="/appointments/new" icon={CalendarPlus} label="New appointment" />
              ) : null}
            </span>
          }
        >
          <Suspense fallback={<ActionsSkeleton />}>
            <ActionBoard organizationId={org} />
          </Suspense>
        </Section>
      ) : null}

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Section
          title="Workshop"
          description="Every work order by stage, and the latest ones opened."
          action={
            <Link
              href="/job-cards"
              className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary-hover"
            >
              All work orders
              <ArrowRight className="size-4" />
            </Link>
          }
          className={sideColumn ? 'xl:col-span-8' : 'xl:col-span-12'}
        >
          <Suspense fallback={<Skeleton className="h-80 rounded-xl" />}>
            <WorkshopActivity organizationId={org} detailed={standardJobCards} />
          </Suspense>
        </Section>

        {sideColumn ? (
          <Stack gap="xl" className="xl:col-span-4">
            {show.appointments ? (
              <Section
                title="Today's appointments"
                action={
                  <Link
                    href="/appointments"
                    className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary-hover"
                  >
                    All
                    <ArrowRight className="size-4" />
                  </Link>
                }
              >
                <Suspense fallback={<Skeleton className="h-40 rounded-xl" />}>
                  <TodaysAppointments organizationId={org} canCheckIn={canCheckIn} />
                </Suspense>
              </Section>
            ) : null}
            {show.lowStock ? (
              <Section
                title="Low stock"
                action={
                  <Link
                    href="/inventory/parts?stock=low"
                    className="inline-flex items-center gap-1 font-medium text-primary hover:text-primary-hover"
                  >
                    Parts
                    <ArrowRight className="size-4" />
                  </Link>
                }
              >
                <Suspense fallback={<Skeleton className="h-24 rounded-xl" />}>
                  <LowStock user={user} />
                </Suspense>
              </Section>
            ) : null}
          </Stack>
        ) : null}
      </Grid>
    </Stack>
  );
}

/* ------------------------------------------------------------------------ */

/**
 * "What do you need?" — the three documents, as the biggest things on the
 * screen. A full-width stack on a phone, three across once there is room.
 */
function StartActions({
  canCheckIn,
  canQuote,
  canInvoice,
}: {
  canCheckIn: boolean;
  canQuote: boolean;
  canInvoice: boolean;
}) {
  const actions = [
    canCheckIn
      ? {
          href: '/check-in',
          icon: ClipboardList,
          label: 'Work order',
          hint: 'Customer, vehicle and what needs doing',
        }
      : null,
    canQuote
      ? {
          href: '/quotations/new',
          icon: FileText,
          label: 'Quotation',
          hint: 'Price the work — no work order needed',
        }
      : null,
    canInvoice
      ? {
          href: '/finance/invoices/new',
          icon: Receipt,
          label: 'Invoice',
          hint: 'Bill the customer and take payment',
        }
      : null,
  ].filter((action) => action !== null);
  if (actions.length === 0) return null;

  return (
    <ul className="grid gap-3 sm:grid-cols-3">
      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <li key={action.href}>
            <Link
              href={action.href}
              className="group flex min-h-20 items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-card outline-none transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-raised focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-0 motion-reduce:transition-none sm:min-h-28 sm:flex-col sm:items-start sm:justify-between sm:p-5"
            >
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground">
                <Icon className="size-6" />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
                  <Plus className="size-4" aria-hidden />
                  New {action.label.toLowerCase()}
                </span>
                <span className="text-sm text-muted-foreground">{action.hint}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** What is open right now: the numbers behind "is there anything I've forgotten?" */
async function DocumentCounts({
  organizationId,
  quotations,
  invoices,
  payments,
}: {
  organizationId: string;
  /** Which tiles to show — each follows its menu (and money, the finance permission). */
  quotations: boolean;
  invoices: boolean;
  payments: boolean;
}) {
  const [counts, finance] = await Promise.all([
    getDocumentCounts(organizationId),
    invoices || payments ? getFinanceSnapshot(organizationId) : Promise.resolve(null),
  ]);
  const tiles = [
    {
      label: 'Open work orders',
      value: String(counts.openWorkOrders),
      hint: 'Still in the workshop',
      href: '/job-cards',
      warn: false,
    },
    quotations && {
      label: 'Quotations awaiting approval',
      value: String(counts.quotationsAwaiting),
      hint:
        counts.draftQuotations > 0
          ? `${counts.draftQuotations} draft${counts.draftQuotations === 1 ? '' : 's'} not sent`
          : 'Sent, not yet answered',
      href: '/quotations?status=awaiting',
      warn: false,
    },
    finance &&
      invoices && {
        label: 'Unpaid invoices',
        value: String(counts.unpaidInvoices),
        hint: `${formatMoney(finance.customerOutstanding)} owed`,
        href: '/finance/invoices?status=unpaid',
        warn: counts.unpaidInvoices > 0,
      },
    finance &&
      payments && {
        label: 'Collected today',
        value: formatMoney(finance.todaysCollections),
        hint: `${formatMoney(finance.todaysSales)} invoiced today`,
        href: '/finance/payments',
        warn: false,
      },
  ].filter((tile) => tile !== false && tile !== null);

  return (
    <ul
      className={cn(
        'grid grid-cols-2 gap-3',
        tiles.length === 3 && 'lg:grid-cols-3',
        tiles.length === 4 && 'lg:grid-cols-4',
      )}
    >
      {tiles.map((tile) => (
        <li key={tile.label}>
          <Link
            href={tile.href}
            className="group flex h-full min-h-24 flex-col justify-between gap-2 rounded-xl border border-border/70 bg-card p-4 transition-colors hover:border-primary/40 hover:bg-muted/40 sm:p-5"
          >
            <span className="text-sm text-muted-foreground">{tile.label}</span>
            <span
              className={cn(
                'text-2xl leading-none font-semibold tracking-tight tabular-nums sm:text-3xl',
                tile.warn && 'text-warning',
              )}
            >
              {tile.value}
            </span>
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground group-hover:text-foreground">
              {tile.hint}
              <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

const ACTIVITY: Record<ActivityKind, { label: string; icon: LucideIcon }> = {
  work_order: { label: 'Work order', icon: ClipboardList },
  quotation: { label: 'Quotation', icon: FileText },
  invoice: { label: 'Invoice', icon: Receipt },
  payment: { label: 'Payment', icon: Wallet },
};

/** Today's documents, newest first, each a tap away. */
async function TodaysActivity({
  organizationId,
  canFinance,
  kinds,
}: {
  organizationId: string;
  canFinance: boolean;
  /** Only the kinds whose menu is shown. */
  kinds: readonly ActivityKind[];
}) {
  const items = (await getTodaysActivity(organizationId, { includeMoney: canFinance })).filter(
    (item) => kinds.includes(item.kind),
  );
  if (items.length === 0) {
    return (
      <Panel>
        <EmptyState
          variant="inline"
          icon={CalendarDays}
          title="Nothing yet today"
          description="Work orders, quotations, invoices and payments you create today appear here."
        />
      </Panel>
    );
  }
  return (
    <Panel padding="none">
      <ul className="divide-y divide-border">
        {items.map((item) => {
          const meta = ACTIVITY[item.kind];
          const Icon = meta.icon;
          return (
            <li key={`${item.kind}-${item.id}`}>
              <Link
                href={item.href}
                className="flex min-h-16 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/60 sm:gap-4 sm:px-6"
              >
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Icon className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">
                    {meta.label} {item.number}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.customer}
                    {item.plateNumber ? ` · ${item.plateNumber}` : ''} · {formatTime(item.at)}
                  </span>
                </span>
                {item.amount ? (
                  <span
                    className={cn(
                      'shrink-0 text-sm font-semibold tabular-nums',
                      item.kind === 'payment' && 'text-success',
                    )}
                  >
                    {formatMoney(item.amount)}
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

function CountsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}

interface ActionTile {
  key: string;
  count: number;
  label: string;
  next: string;
  href: string;
  icon: LucideIcon;
}

/** One tile per next step in the workflow. Tiles with nothing waiting stay in place, dimmed, so the layout never jumps. */
async function ActionBoard({ organizationId }: { organizationId: string }) {
  const { actions } = await getWorkshopFlow(organizationId);
  const tiles: ActionTile[] = [
    {
      key: 'approval',
      count: actions.waitingApproval,
      label: 'Waiting for customer approval',
      next: 'Follow up the quotation',
      href: '/approvals',
      icon: BadgeCheck,
    },
    {
      key: 'approved',
      count: actions.approved,
      label: 'Approved',
      next: 'Start the repair',
      href: '/job-cards?status=APPROVED',
      icon: Wrench,
    },
    {
      key: 'repair',
      count: actions.inRepair,
      label: 'Under repair',
      next: 'Record parts and labour',
      href: '/job-cards?status=REPAIR',
      icon: Wrench,
    },
    {
      key: 'qc',
      count: actions.qualityCheck,
      label: 'Quality check',
      next: 'Check and pass the work',
      href: '/job-cards?status=QUALITY_CHECK',
      icon: ShieldCheck,
    },
    {
      key: 'ready',
      count: actions.ready,
      label: 'Ready — not invoiced',
      next: 'Create the invoice',
      href: '/job-cards?status=READY',
      icon: Receipt,
    },
    {
      key: 'payment',
      count: actions.awaitingPayment,
      label: 'Awaiting payment',
      next: 'Take payment',
      href: '/job-cards?status=INVOICED',
      icon: Wallet,
    },
    {
      key: 'deliver',
      count: actions.toDeliver,
      label: 'Paid — ready to hand over',
      next: 'Deliver the vehicle',
      href: '/job-cards?status=PAID',
      icon: KeyRound,
    },
    {
      key: 'quote',
      count: actions.toQuote,
      label: 'To diagnose or quote',
      next: 'Prepare the estimate',
      href: '/estimates',
      icon: FileText,
    },
  ];
  const extras = [
    actions.toInspect > 0
      ? { label: `${actions.toInspect} to inspect`, href: '/inspections', icon: ClipboardCheck }
      : null,
    actions.onHold > 0
      ? { label: `${actions.onHold} on hold`, href: '/job-cards?status=ON_HOLD', icon: PauseCircle }
      : null,
  ].filter((item) => item !== null);

  return (
    <div className="flex flex-col gap-3">
      <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((tile) => {
          const active = tile.count > 0;
          const Icon = tile.icon;
          return (
            <li key={tile.key}>
              <Link
                href={tile.href}
                className={cn(
                  'group relative flex h-full min-h-28 flex-col justify-between gap-3 overflow-hidden rounded-xl border p-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50 sm:p-5',
                  'transition-[transform,box-shadow,border-color] duration-200 ease-out motion-reduce:transition-none',
                  active
                    ? 'border-border/70 bg-card shadow-card hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-raised'
                    : 'border-dashed border-border bg-transparent hover:bg-card/60',
                )}
              >
                {/* A tile with work waiting wears the accent; an empty one stays quiet. */}
                {active ? (
                  <span
                    aria-hidden
                    className="absolute inset-y-0 left-0 w-[3px] bg-primary opacity-70 transition-opacity group-hover:opacity-100"
                  />
                ) : null}
                <div className="flex items-start justify-between gap-3">
                  <span
                    className={cn(
                      'text-[32px] leading-none font-semibold tracking-[-0.02em] tabular-nums',
                      active ? 'text-foreground' : 'text-foreground/25',
                    )}
                  >
                    {tile.count}
                  </span>
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
                      active
                        ? 'bg-accent text-primary group-hover:bg-primary group-hover:text-primary-foreground'
                        : 'text-muted-foreground/40',
                    )}
                  >
                    <Icon className="size-[18px]" />
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className={cn('text-sm font-medium', !active && 'text-muted-foreground')}>
                    {tile.label}
                  </span>
                  {active ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-primary">
                      {tile.next}
                      <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground/70">Nothing waiting</span>
                  )}
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
      {extras.length ? (
        <div className="flex flex-wrap gap-2">
          {extras.map((extra) => {
            const Icon = extra.icon;
            return (
              <Link
                key={extra.href}
                href={extra.href}
                className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-card px-3.5 text-sm hover:bg-muted"
              >
                <Icon className="size-4 text-muted-foreground" />
                {extra.label}
              </Link>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

async function WorkshopActivity({
  organizationId,
  detailed,
}: {
  organizationId: string;
  /** Whether the workshop uses the standard job card, with every step. */
  detailed: boolean;
}) {
  const [flow, recent] = await Promise.all([
    getWorkshopFlow(organizationId),
    getRecentJobCards(organizationId),
  ]);

  return (
    <Panel padding="none">
      <div className="p-4 sm:p-6">
        <WorkshopFlowRow stages={visibleStages(flow.workflowStages, detailed)} />
      </div>
      <div className="border-t border-border">
        <p className="px-4 pt-5 pb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase sm:px-6">
          Latest work orders
        </p>
        {recent.length === 0 ? (
          <div className="px-4 pb-6 sm:px-6">
            <EmptyState
              variant="inline"
              icon={ClipboardList}
              title="No open work orders"
              description="A work order appears here as soon as it is created."
              action={<QuickAction href="/check-in" icon={LogIn} label="New work order" />}
            />
          </div>
        ) : (
          <ul className="divide-y divide-border pb-1">
            {recent.map((job) => (
              <li key={job.id}>
                <Link
                  href={`/job-cards/${job.id}`}
                  className="flex min-h-14 items-center gap-4 px-4 py-2.5 transition-colors hover:bg-muted/60 sm:px-6"
                >
                  <VehiclePlate
                    plateNumber={job.vehicle.plateNumber}
                    className="w-28 justify-center px-2 py-0.5 text-xs"
                  />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <p className="truncate text-sm font-medium">
                      {job.vehicle.make} {job.vehicle.model}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/70">{job.jobNumber}</span> ·{' '}
                      {job.customer.name}
                    </p>
                  </div>
                  <JobStatusBadge status={job.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}

async function TodaysAppointments({
  organizationId,
  canCheckIn,
}: {
  organizationId: string;
  canCheckIn: boolean;
}) {
  const appointments = await getTodaysAppointments(organizationId);
  if (appointments.length === 0) {
    return (
      <Panel>
        <EmptyState
          variant="inline"
          icon={CalendarDays}
          title="No appointments today"
          description="Walk-ins can have a work order opened any time."
          action={
            canCheckIn ? (
              <QuickAction href="/appointments/new" icon={CalendarPlus} label="Book one" />
            ) : undefined
          }
        />
      </Panel>
    );
  }
  return (
    <Panel padding="none">
      <ul className="divide-y divide-border">
        {appointments.map((appointment) => (
          <li key={appointment.id} className="flex items-center gap-3 px-4 py-3 sm:px-5">
            <span className="w-16 shrink-0 text-sm font-semibold tabular-nums">
              {formatTime(appointment.scheduledAt)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {appointment.customer.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {appointment.vehicle
                  ? `${appointment.vehicle.plateNumber} · ${appointment.vehicle.make} ${appointment.vehicle.model}`
                  : 'Vehicle not recorded'}
              </span>
            </span>
            {appointment.status === 'CHECKED_IN' || appointment.status === 'COMPLETED' ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                <CheckCircle2 className="size-3.5" />
                In
              </span>
            ) : canCheckIn ? (
              <Link
                href={`/check-in?appointment=${appointment.id}`}
                className="inline-flex h-9 shrink-0 items-center rounded-lg border border-border px-3 text-xs font-medium hover:bg-muted"
              >
                Check in
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

async function LowStock({ user }: { user: AuthenticatedUser }) {
  const parts = await getLowStock(user);
  if (parts.length === 0) {
    return (
      <Panel>
        <EmptyState
          variant="inline"
          tone="success"
          icon={PackageCheck}
          title="Stock levels are healthy"
          description="No part is at or below its minimum."
        />
      </Panel>
    );
  }
  return (
    <Panel padding="none">
      <ul className="divide-y divide-border">
        {parts.slice(0, 5).map((part) => (
          <li key={part.id}>
            <Link
              href={`/inventory/parts/${part.id}`}
              className="flex items-center gap-3 px-4 py-3 hover:bg-muted/60 sm:px-5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{part.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{part.sku}</span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-sm font-semibold tabular-nums">
                  {formatMilli(part.onHandMilli)}{' '}
                  <span className="text-xs font-normal text-muted-foreground">
                    {part.unitOfMeasure}
                  </span>
                </span>
                <StockPill state={part.state} className="mt-0.5" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {parts.length > 5 ? (
        <Link
          href="/inventory/parts?stock=low"
          className="block border-t border-border px-4 py-2.5 text-sm font-medium text-primary sm:px-5"
        >
          {parts.length - 5} more
        </Link>
      ) : null}
    </Panel>
  );
}

function ActionsSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-28 rounded-xl" />
      ))}
    </div>
  );
}
