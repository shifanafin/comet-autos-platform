import Link from 'next/link';
import { ArrowRight, HandCoins, Receipt, Truck } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getCustomerOutstanding, getSupplierOutstanding } from '@/lib/finance/outstanding';
import { formatDate, formatMoney } from '@/lib/format';
import { payableAgeLabel } from '@/lib/finance/supplier-balance';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import { SearchField } from '@/components/shared/search-field';
import { StatusPill } from '@/components/shared/status-pill';

const JOURNAL_HREF = '/finance/accounting?view=journal';

/**
 * A row's pill: paid / part paid / unpaid for a document, "Journal" for the
 * net of a party's manual journal entries (settled by another entry, not paid).
 */
function RowPill({ row }: { row: { kind: string; state: keyof typeof STATE } }) {
  if (row.kind === 'journal') return <StatusPill tone="info">Journal</StatusPill>;
  return <StatusPill tone={STATE[row.state].tone}>{STATE[row.state].label}</StatusPill>;
}

const STATE = {
  UNPAID: { tone: 'danger', label: 'Unpaid' },
  PARTIALLY_PAID: { tone: 'warning', label: 'Part paid' },
  PAID: { tone: 'success', label: 'Settled' },
} as const;

const AGE_FILTERS = [
  { key: '', label: 'All' },
  { key: '31', label: '31+ days' },
  { key: '61', label: '61+ days' },
  { key: '91', label: '91+ days' },
];

/** Ageing is the same story on both sides, so it is rendered once. */
function Ageing({
  totals,
  owedLabel,
}: {
  totals: {
    balance: string;
    count: number;
    parties: number;
    ageing: { current: string; thirty: string; sixty: string; ninety: string };
  };
  owedLabel: string;
}) {
  const buckets = [
    ['Up to 30 days', totals.ageing.current],
    ['31–60 days', totals.ageing.thirty],
    ['61–90 days', totals.ageing.sixty],
    ['Over 90 days', totals.ageing.ninety],
  ] as const;
  return (
    <Panel className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">{owedLabel}</span>
        <span className="text-3xl leading-none font-semibold tracking-[-0.02em] tabular-nums">
          {formatMoney(totals.balance)}
        </span>
        <span className="text-xs text-muted-foreground">
          {totals.count} document{totals.count === 1 ? '' : 's'} · {totals.parties}{' '}
          {totals.parties === 1 ? 'party' : 'parties'}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-4 border-t border-border pt-5 sm:grid-cols-4">
        {buckets.map(([label, amount]) => (
          <div key={label} className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="text-sm font-semibold tabular-nums">{formatMoney(amount)}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

export default async function OutstandingPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; q?: string; age?: string }>;
}) {
  const user = await requireUser();
  const canSeeCustomers = hasPermission(user, 'invoice.view');
  const canSeeSuppliers = hasPermission(user, 'supplier_payment.view');
  if (!canSeeCustomers && !canSeeSuppliers) return <AccessDenied what="outstanding balances" />;

  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const age = AGE_FILTERS.some((f) => f.key === params.age) ? (params.age ?? '') : '';
  const olderThanDays = age ? Number(age) : undefined;
  // Fall back to whichever side this user may actually see.
  const view =
    params.view === 'suppliers' || !canSeeCustomers
      ? ('suppliers' as const)
      : ('customers' as const);
  if (view === 'suppliers' && !canSeeSuppliers) return <AccessDenied what="supplier balances" />;

  const customers =
    view === 'customers' ? await getCustomerOutstanding(user, { query, olderThanDays }) : null;
  const suppliers =
    view === 'suppliers' ? await getSupplierOutstanding(user, { query, olderThanDays }) : null;
  // The Advance / credit column only when some invoice was settled that way.
  const customerOtherCredits = customers?.rows.some((row) => row.otherCreditsFils > 0) ?? false;

  const href = (next: { view?: string; q?: string; age?: string }) =>
    `/finance/outstanding?${new URLSearchParams({
      view: next.view ?? view,
      ...((next.q ?? query) ? { q: next.q ?? query } : {}),
      ...((next.age ?? age) ? { age: next.age ?? age } : {}),
    })}`;

  const filtered = Boolean(query || age);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Customers & Sales"
        title="Receivables & payables ageing"
        description="What customers still owe the workshop, and what the workshop still owes its suppliers. Cancelled documents and reversed payments never count."
      />

      {canSeeCustomers && canSeeSuppliers ? (
        <nav aria-label="Which side" className="flex gap-1 self-start rounded-lg bg-muted p-1">
          {(
            [
              ['customers', 'Customers owe us'],
              ['suppliers', 'We owe suppliers'],
            ] as const
          ).map(([key, label]) => (
            <Link
              key={key}
              href={href({ view: key })}
              aria-current={view === key ? 'page' : undefined}
              className={
                view === key
                  ? 'rounded-md bg-card px-3 py-2 text-sm font-medium shadow-card'
                  : 'rounded-md px-3 py-2 text-sm text-muted-foreground hover:text-foreground'
              }
            >
              {label}
            </Link>
          ))}
        </nav>
      ) : null}

      <Ageing
        totals={(customers ?? suppliers)!.totals}
        owedLabel={view === 'customers' ? 'Customers owe' : 'Owed to suppliers'}
      />

      <Section
        title={view === 'customers' ? 'Unpaid invoices' : 'Unpaid purchases'}
        description={
          view === 'customers'
            ? 'Issued invoices with a balance, oldest first.'
            : 'Purchases already received but not fully paid, oldest first. Based on what was received, not on stock on hand.'
        }
      >
        <Stack gap="base">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <SearchField
                initialQuery={query}
                placeholder={
                  view === 'customers'
                    ? 'Customer, invoice number or phone'
                    : 'Supplier or purchase number'
                }
              />
            </div>
            <nav aria-label="Filter by age" className="flex gap-1 rounded-lg bg-muted p-1">
              {AGE_FILTERS.map((option) => (
                <Link
                  key={option.key || 'all'}
                  href={href({ age: option.key })}
                  aria-current={age === option.key ? 'page' : undefined}
                  className={
                    age === option.key
                      ? 'rounded-md bg-card px-3 py-1.5 text-sm font-medium shadow-card'
                      : 'rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground'
                  }
                >
                  {option.label}
                </Link>
              ))}
            </nav>
          </div>

          {customers ? (
            customers.rows.length === 0 ? (
              <EmptyState
                icon={HandCoins}
                title={filtered ? 'Nothing matches those filters' : 'Every invoice is settled'}
                description={
                  filtered
                    ? 'Try a different search, or widen the age filter.'
                    : 'No customer owes the workshop anything right now.'
                }
              />
            ) : (
              <Panel padding="none" className="overflow-hidden">
                <RecordList>
                  {customers.rows.map((row) => (
                    <RecordCard
                      key={row.id}
                      title={row.party.name}
                      subtitle={
                        <span className="font-mono">
                          {row.number}
                          {row.jobCard ? ` · ${row.jobCard.jobNumber}` : ''}
                        </span>
                      }
                      amount={formatMoney(row.balance)}
                      status={<RowPill row={row} />}
                      details={[
                        { label: 'Invoiced', value: formatDate(row.date) },
                        { label: 'Total', value: formatMoney(row.total) },
                        { label: 'Paid', value: formatMoney(row.paid) },
                        ...(row.otherCreditsFils > 0
                          ? [{ label: 'Advance / credit', value: formatMoney(row.otherCredits) }]
                          : []),
                        { label: 'Age', value: `${row.ageDays} days` },
                      ]}
                    >
                      {row.kind === 'journal' ? (
                        <Link
                          href={JOURNAL_HREF}
                          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary md:min-h-0"
                        >
                          Open journal
                          <ArrowRight className="size-4" />
                        </Link>
                      ) : row.jobCard ? (
                        <Link
                          href={`/job-cards/${row.jobCard.id}`}
                          className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary md:min-h-0"
                        >
                          Open job
                          <ArrowRight className="size-4" />
                        </Link>
                      ) : null}
                    </RecordCard>
                  ))}
                </RecordList>

                <TableWrap>
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                      <tr>
                        <th className="min-w-[12rem] px-4 py-4 pl-6">Customer</th>
                        <th className="px-2 py-4">Invoice</th>
                        <th className="w-28 px-2 py-4">Invoiced</th>
                        <th className="w-20 px-2 py-4 text-right">Age</th>
                        <th className="w-28 px-2 py-4 text-right">Total</th>
                        <th className="w-28 px-2 py-4 text-right">Paid</th>
                        {customerOtherCredits ? (
                          <th
                            className="w-32 px-2 py-4 text-right"
                            title="Paid from an advance, a credit note, or a discount given after the invoice"
                          >
                            Advance / credit
                          </th>
                        ) : null}
                        <th className="w-28 px-4 py-4 pr-6 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {customers.rows.map((row) => (
                        <tr key={row.id}>
                          <td className="px-4 py-4 pl-6">
                            <Link
                              href={`/customers/${row.party.id}`}
                              className="font-medium hover:underline"
                            >
                              {row.party.name}
                            </Link>
                            <span className="block text-xs text-muted-foreground tabular-nums">
                              {row.party.phone}
                            </span>
                          </td>
                          <td className="px-2 py-4">
                            {row.jobCard ? (
                              <Link
                                href={`/job-cards/${row.jobCard.id}`}
                                className="font-mono text-sm hover:underline"
                              >
                                {row.number}
                              </Link>
                            ) : row.kind === 'journal' ? (
                              <Link
                                href={JOURNAL_HREF}
                                className="font-mono text-sm hover:underline"
                              >
                                {row.number}
                              </Link>
                            ) : (
                              <span className="font-mono text-sm">{row.number}</span>
                            )}
                            <span className="mt-0.5 block">
                              <RowPill row={row} />
                            </span>
                          </td>
                          <td className="px-2 py-4 tabular-nums whitespace-nowrap">
                            {formatDate(row.date)}
                          </td>
                          <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                            {row.ageDays}d
                          </td>
                          <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                            {formatMoney(row.total)}
                          </td>
                          <td className="px-2 py-4 text-right text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatMoney(row.paid)}
                          </td>
                          {customerOtherCredits ? (
                            <td className="px-2 py-4 text-right text-muted-foreground tabular-nums whitespace-nowrap">
                              {row.otherCreditsFils > 0 ? formatMoney(row.otherCredits) : '—'}
                            </td>
                          ) : null}
                          <td className="px-4 py-4 pr-6 text-right font-semibold tabular-nums whitespace-nowrap">
                            {formatMoney(row.balance)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Panel>
            )
          ) : null}

          {suppliers ? (
            suppliers.rows.length === 0 ? (
              <EmptyState
                icon={Truck}
                title={filtered ? 'Nothing matches those filters' : 'Every purchase is settled'}
                description={
                  filtered
                    ? 'Try a different search, or widen the age filter.'
                    : 'The workshop does not owe any supplier for received stock.'
                }
              />
            ) : (
              <Panel padding="none" className="overflow-hidden">
                <RecordList>
                  {suppliers.rows.map((row) => (
                    <RecordCard
                      key={row.id}
                      title={row.party.name}
                      subtitle={
                        <span className="font-mono">
                          {row.number}
                          {row.supplierInvoiceNumber ? ` · ${row.supplierInvoiceNumber}` : ''}
                        </span>
                      }
                      amount={formatMoney(row.balance)}
                      status={<RowPill row={row} />}
                      details={[
                        { label: 'Received', value: formatDate(row.date) },
                        { label: 'Total', value: formatMoney(row.total) },
                        { label: 'Paid', value: formatMoney(row.paid) },
                        {
                          label: 'Age',
                          value: row.dueDate ? payableAgeLabel(row) : `${row.ageDays} days`,
                        },
                      ]}
                    >
                      <Link
                        href={
                          row.kind === 'journal' ? JOURNAL_HREF : `/inventory/purchases/${row.id}`
                        }
                        className="inline-flex min-h-11 items-center gap-1 text-sm font-medium text-primary md:min-h-0"
                      >
                        {row.kind === 'journal' ? 'Open journal' : 'Open purchase'}
                        <ArrowRight className="size-4" />
                      </Link>
                    </RecordCard>
                  ))}
                </RecordList>

                <TableWrap>
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                      <tr>
                        <th className="min-w-[12rem] px-4 py-4 pl-6">Supplier</th>
                        <th className="px-2 py-4">Purchase</th>
                        <th className="w-28 px-2 py-4">Received</th>
                        <th className="w-20 px-2 py-4 text-right">Age</th>
                        <th className="w-28 px-2 py-4 text-right">Total</th>
                        <th className="w-28 px-2 py-4 text-right">Paid</th>
                        <th className="w-28 px-4 py-4 pr-6 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {suppliers.rows.map((row) => (
                        <tr key={row.id}>
                          <td className="px-4 py-4 pl-6">
                            <Link
                              href={`/inventory/suppliers/${row.party.id}`}
                              className="font-medium hover:underline"
                            >
                              {row.party.name}
                            </Link>
                            {row.party.phone ? (
                              <span className="block text-xs text-muted-foreground tabular-nums">
                                {row.party.phone}
                              </span>
                            ) : null}
                          </td>
                          <td className="px-2 py-4">
                            <Link
                              href={
                                row.kind === 'journal'
                                  ? JOURNAL_HREF
                                  : `/inventory/purchases/${row.id}`
                              }
                              className="font-mono text-sm hover:underline"
                            >
                              {row.number}
                            </Link>
                            <span className="mt-0.5 block">
                              <RowPill row={row} />
                            </span>
                          </td>
                          <td className="px-2 py-4 tabular-nums whitespace-nowrap">
                            {formatDate(row.date)}
                          </td>
                          <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                            {row.dueDate ? payableAgeLabel(row) : `${row.ageDays}d`}
                          </td>
                          <td className="px-2 py-4 text-right tabular-nums whitespace-nowrap">
                            {formatMoney(row.total)}
                          </td>
                          <td className="px-2 py-4 text-right text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatMoney(row.paid)}
                          </td>
                          <td className="px-4 py-4 pr-6 text-right font-semibold tabular-nums whitespace-nowrap">
                            {formatMoney(row.balance)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </Panel>
            )
          ) : null}
        </Stack>
      </Section>

      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <Receipt className="mt-0.5 size-3.5 shrink-0" />
        Balances come from the same calculation the invoice and purchase screens use, so a figure
        here always matches its document.
      </p>
    </Stack>
  );
}
