import Link from 'next/link';
import { ArrowRight, ChevronRight, HandCoins, Receipt, TriangleAlert } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { AuthError } from '@/lib/auth/authorize';
import { getPayables, type Payables } from '@/lib/finance/supplier-payments';
import { formatCalendarDate, formatDate, formatMoney } from '@/lib/format';
import { payableAgeLabel } from '@/lib/finance/supplier-balance';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill } from '@/components/shared/status-pill';
import { TableWrap } from '@/components/shared/record-card';
import { PayableFilters } from '@/components/finance/payable-filters';
import { SupplierPaymentHistory } from '@/components/finance/supplier-payment-history';

export const dynamic = 'force-dynamic';

/** One figure in the summary strip — the eye compares numbers, not boxes. */
function Figure({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'danger';
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <span
        className={`text-2xl leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-[28px] ${
          tone === 'danger' ? 'text-danger' : ''
        }`}
      >
        {value}
      </span>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function AgeBadge({
  days,
  dueDate,
  daysOverdue,
}: {
  days: number;
  dueDate: Date | null;
  daysOverdue: number | null;
}) {
  // A bill with a due date reads against it: "due …" until then, then overdue.
  if (dueDate) {
    if (!daysOverdue) {
      return <StatusPill tone="neutral">{payableAgeLabel({ ageDays: days, dueDate, daysOverdue })}</StatusPill>;
    }
    return (
      <StatusPill tone={daysOverdue <= 30 ? 'warning' : 'danger'}>{daysOverdue}d overdue</StatusPill>
    );
  }
  if (days <= 30) return <StatusPill tone="neutral">{days}d</StatusPill>;
  if (days <= 60) return <StatusPill tone="warning">{days}d</StatusPill>;
  return <StatusPill tone="danger">{days}d</StatusPill>;
}

export default async function PayablesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; supplierId?: string; olderThanDays?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  let data: Payables;
  try {
    data = await getPayables(user, params);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="what the workshop owes" />;
    throw error;
  }
  const canPay = hasPermission(user, 'supplier_payment.create');
  const canReverse = hasPermission(user, 'supplier_payment.delete');
  const filtered = Boolean(params.q || params.supplierId || params.olderThanDays);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Suppliers & Bills"
        title="Payables"
        description="What the workshop owes its suppliers on stock it has already received, and what has been paid."
      />

      {/* The money, first, at every width. */}
      <Panel className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        <Figure
          label="Total outstanding"
          value={formatMoney(data.totals.balance)}
          hint={`${data.totals.purchases} purchase${data.totals.purchases === 1 ? '' : 's'}`}
        />
        <Figure
          label="Suppliers owed"
          value={String(data.totals.suppliers)}
          hint={data.totals.suppliers === 1 ? 'supplier with a balance' : 'suppliers with a balance'}
        />
        <Figure
          label="Over 30 days"
          value={formatMoney(data.totals.overdue)}
          hint={`${data.totals.overdueCount} bill${data.totals.overdueCount === 1 ? '' : 's'}`}
          tone={data.totals.overdueCount > 0 ? 'danger' : undefined}
        />
        <Figure
          label="Oldest bracket"
          value={formatMoney(data.totals.ageing.ninety)}
          hint="Over 90 days"
        />
      </Panel>

      {data.totals.overdueCount > 0 ? (
        <p className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/5 px-4 py-4 text-sm sm:px-6">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          <span className="flex min-w-0 flex-col gap-1">
            <span className="font-medium text-warning">
              {formatMoney(data.totals.overdue)} has been owed for more than 30 days
            </span>
            <span className="text-muted-foreground">
              Suppliers have no agreed terms recorded in the system, so this is measured from the
              supplier invoice date.
            </span>
          </span>
        </p>
      ) : null}

      <PayableFilters
        suppliers={data.suppliers}
        current={{
          q: params.q ?? '',
          supplierId: params.supplierId ?? '',
          olderThanDays: params.olderThanDays ?? '',
        }}
      />

      <Grid gap="xl" className="items-start xl:grid-cols-12">
        <Stack gap="2xl" className="xl:col-span-8">
          <Section
            title="Bills to pay"
            description="Received purchases with a balance, oldest first."
          >
            {data.rows.length === 0 ? (
              <EmptyState
                icon={HandCoins}
                title={filtered ? 'Nothing matches those filters' : 'Nothing owed'}
                description={
                  filtered
                    ? 'Try a different search, or clear the filters to see everything owed.'
                    : 'Every purchase the workshop has received has been paid for.'
                }
              />
            ) : (
              <>
                {/* Phone & tablet: one tappable row per bill. */}
                <ul className="flex flex-col gap-2 lg:hidden">
                  {data.rows.map((row) => (
                    <li key={row.id}>
                      <Link
                        href={`/finance/payables/${row.supplier.id}`}
                        className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-4 transition-colors active:bg-muted"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="truncate font-medium">{row.supplier.name}</span>
                          <span className="truncate text-xs text-muted-foreground">
                            <span className="font-mono">{row.number}</span>
                            {row.supplierInvoiceNumber ? ` · ${row.supplierInvoiceNumber}` : ''} ·{' '}
                            {formatDate(row.date)}
                          </span>
                          {row.state === 'PARTIALLY_PAID' ? (
                            <span className="text-xs text-muted-foreground">
                              {formatMoney(row.paid)} of {formatMoney(row.received)} paid
                            </span>
                          ) : null}
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          <span className="text-base font-semibold tabular-nums">
                            {formatMoney(row.balance)}
                          </span>
                          <AgeBadge days={row.ageDays} dueDate={row.dueDate} daysOverdue={row.daysOverdue} />
                        </span>
                        <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>

                {/* Desktop: denser. */}
                <Panel padding="none" className="hidden overflow-hidden lg:block">
                  <TableWrap>
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                        <tr>
                          <th className="min-w-36 px-6 py-4">Supplier</th>
                          <th className="px-2 py-4">Purchase</th>
                          <th className="px-2 py-4">Date</th>
                          <th className="w-24 px-2 py-4 text-right">Received</th>
                          <th className="w-24 px-2 py-4 text-right">Paid</th>
                          <th className="w-32 px-2 py-4 text-right">Outstanding</th>
                          <th className="w-20 px-6 py-4">Age</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {data.rows.map((row) => (
                          <tr key={row.id} className="transition-colors hover:bg-muted/40">
                            <td className="px-6 py-4">
                              <Link
                                href={`/finance/payables/${row.supplier.id}`}
                                className="font-medium text-balance hover:text-primary"
                              >
                                {row.supplier.name}
                              </Link>
                            </td>
                            <td className="px-2 py-4 text-muted-foreground">
                              <span className="font-mono text-xs">{row.number}</span>
                              {row.supplierInvoiceNumber ? (
                                <span className="block text-xs">{row.supplierInvoiceNumber}</span>
                              ) : null}
                            </td>
                            <td className="px-2 py-4 whitespace-nowrap text-muted-foreground">
                              {formatDate(row.date)}
                              {row.dueDate ? (
                                <span className="block text-xs">
                                  due {formatCalendarDate(row.dueDate)}
                                </span>
                              ) : null}
                            </td>
                            <td className="px-2 py-4 text-right tabular-nums text-muted-foreground">
                              {formatMoney(row.received)}
                            </td>
                            <td className="px-2 py-4 text-right tabular-nums text-muted-foreground">
                              {formatMoney(row.paid)}
                            </td>
                            <td className="px-2 py-4 text-right font-semibold tabular-nums">
                              {formatMoney(row.balance)}
                            </td>
                            <td className="px-6 py-4">
                              <AgeBadge days={row.ageDays} dueDate={row.dueDate} daysOverdue={row.daysOverdue} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableWrap>
                </Panel>
              </>
            )}
          </Section>
        </Stack>

        <Stack gap="2xl" className="xl:col-span-4">
          <Section
            title="Suppliers owed"
            description="Open the supplier to see the bills and record a payment."
          >
            {data.suppliers.length === 0 ? (
              <Panel>
                <p className="text-sm text-muted-foreground">No supplier has a balance.</p>
              </Panel>
            ) : (
              <Panel padding="none" className="overflow-hidden">
                <ul className="divide-y divide-border">
                  {data.suppliers.map((supplier) => (
                    <li key={supplier.id}>
                      <Link
                        href={`/finance/payables/${supplier.id}`}
                        className="flex items-center gap-3 px-4 py-4 transition-colors hover:bg-muted/50 active:bg-muted sm:px-6"
                      >
                        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                          <span className="truncate font-medium">{supplier.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {supplier.count} bill{supplier.count === 1 ? '' : 's'}
                          </span>
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums">
                          {formatMoney(supplier.balance)}
                        </span>
                        <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            )}
          </Section>

          <Section
            title="Recent payments"
            description="The last supplier payments recorded."
          >
            {data.recentPayments.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No supplier payments yet"
                description={
                  canPay
                    ? 'Open a supplier above to record the first one.'
                    : 'Payments recorded here will appear in this list.'
                }
              />
            ) : (
              <SupplierPaymentHistory
                payments={data.recentPayments}
                canReverse={canReverse}
                showSupplier
              />
            )}
          </Section>
        </Stack>
      </Grid>
    </Stack>
  );
}
