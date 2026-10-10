import Link from 'next/link';
import { CheckCircle2, History, TriangleAlert } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { getPriorPeriods } from '@/lib/accounting/prior-periods';
import { addDays } from '@/lib/compliance/rules';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { RecordCard, RecordList, TableWrap } from '@/components/shared/record-card';
import {
  PriorPeriodForm,
  RemovePriorPeriodButton,
} from '@/components/accounting/prior-period-forms';

export const metadata = { title: 'Months before these books' };

const date = (value: string) => formatCalendarDate(value);
const range = (from: string, to: string) => `${date(from)} – ${date(to)}`;

export default async function PriorPeriodsPage() {
  const user = await requireUser();
  if (!hasPermission(user, 'accounting.view')) {
    return <AccessDenied what="the months before these books" />;
  }
  const data = await getPriorPeriods(user);
  const canAdd = hasPermission(user, 'accounting.create');
  const canRemove = hasPermission(user, 'accounting.delete');
  const lastMonth = data.booksStart ? addDays(data.booksStart, -1).slice(0, 7) : '';

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/calendar" className="text-primary hover:underline">
            Tax & accounting calendar
          </Link>
        }
        title="Months before these books"
        description={
          data.booksStart
            ? `These books begin on ${date(data.booksStart)}, but your first tax year and your VAT quarters began earlier. Enter each earlier month's totals here, so the VAT returns and the year's profit include them.`
            : 'Set the opening balances first: these are the months before them.'
        }
      />

      <Section title="How it works" description="In plain words.">
        <Panel className="flex flex-col gap-2 text-sm leading-relaxed text-muted-foreground">
          <p>
            One row a month. Take the figures from your invoice book (sales), the supplier tax
            invoices (parts and costs) and the bank statement (salaries, fees). For the month the
            books began in, enter only the days before.
          </p>
          <p>
            Each month is booked as one summary: its sales and costs go into the profit and loss,
            and its VAT into that quarter&apos;s VAT return. Nothing is added to the bank or the
            cash — the opening balances already hold what those months left behind. Parts still in
            stock when the books began are taken off the cost of parts automatically.
          </p>
          <p>
            Start from the first month of your first tax year (on the corporate tax registration) —
            and at least from the month VAT began{data.vatStart ? ` (${date(data.vatStart)})` : ''}.
          </p>
        </Panel>
      </Section>

      {data.openingVat ? (
        <Section
          title="VAT owed when the books began"
          description={`The VAT quarter ${range(data.openingVat.periodFrom, data.openingVat.periodTo)} was running on the first day of the books. Its VAT so far must be in the opening balances, so the return comes out right.`}
        >
          <Panel className="flex flex-col gap-4">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[1fr_auto_auto]">
              <dt className="text-muted-foreground">Output VAT payable (VAT on sales)</dt>
              <dd className="tabular-nums">
                From the months: {formatMoney(data.openingVat.expectedOutput)}
              </dd>
              <dd className="tabular-nums">
                In the opening balances: {formatMoney(data.openingVat.openingOutput)}
              </dd>
              <dt className="text-muted-foreground">Input VAT recoverable (VAT on costs)</dt>
              <dd className="tabular-nums">
                From the months: {formatMoney(data.openingVat.expectedInput)}
              </dd>
              <dd className="tabular-nums">
                In the opening balances: {formatMoney(data.openingVat.openingInput)}
              </dd>
            </dl>
            {data.openingVat.matches ? (
              <p className="flex items-center gap-2 text-sm text-success">
                <CheckCircle2 className="size-4 shrink-0" />
                They match.
              </p>
            ) : (
              <p className="flex items-start gap-2 text-sm text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                <span>
                  They differ. Once every month of this quarter is entered, put the figures from the
                  months into{' '}
                  <Link
                    href="/finance/accounting/opening-balances"
                    className="font-medium underline"
                  >
                    the opening balances
                  </Link>{' '}
                  (Output VAT payable and Input VAT recoverable).
                </span>
              </p>
            )}
          </Panel>
        </Section>
      ) : null}

      <Section
        title="Months entered"
        description={data.months.length ? 'Oldest first.' : undefined}
      >
        {data.months.length === 0 ? (
          <Panel>
            <EmptyState
              icon={History}
              title="No months entered yet"
              description="Add the first month below."
            />
          </Panel>
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <RecordList>
              {data.months.map((row) => (
                <RecordCard
                  key={row.id}
                  title={range(row.from, row.to)}
                  subtitle={row.note ?? `Entered by ${row.recordedBy}`}
                  amount={formatMoney(row.sales)}
                  details={[
                    { label: 'VAT on sales', value: formatMoney(row.salesVat) },
                    { label: 'Parts bought', value: formatMoney(row.partsBought) },
                    { label: 'Costs with VAT', value: formatMoney(row.costsWithVat) },
                    { label: 'VAT on costs', value: formatMoney(row.purchasesVat) },
                    { label: 'Costs without VAT', value: formatMoney(row.costsWithoutVat) },
                    { label: 'Salaries', value: formatMoney(row.salaries) },
                    { label: 'Profit', value: formatMoney(row.profit) },
                  ]}
                >
                  {canRemove ? (
                    <RemovePriorPeriodButton id={row.id} label={range(row.from, row.to)} />
                  ) : null}
                </RecordCard>
              ))}
            </RecordList>
            <TableWrap>
              <table className="w-full min-w-[960px] text-sm">
                <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  <tr>
                    <th className="px-4 py-4 pl-6">Month</th>
                    <th className="w-28 px-2 py-4 text-right">Sales</th>
                    <th className="w-24 px-2 py-4 text-right">VAT</th>
                    <th className="w-28 px-2 py-4 text-right">Parts</th>
                    <th className="w-28 px-2 py-4 text-right">Costs + VAT</th>
                    <th className="w-24 px-2 py-4 text-right">VAT</th>
                    <th className="w-28 px-2 py-4 text-right">No VAT</th>
                    <th className="w-28 px-2 py-4 text-right">Salaries</th>
                    <th className="w-28 px-4 py-4 text-right">Profit</th>
                    {canRemove ? <th className="w-0 px-2 py-4" /> : null}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.months.map((row) => (
                    <tr key={row.id}>
                      <td className="px-4 py-3 pl-6">
                        <span className="font-medium tabular-nums">{range(row.from, row.to)}</span>
                        {row.note ? (
                          <span className="block text-xs text-muted-foreground">{row.note}</span>
                        ) : null}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        {formatMoney(row.sales)}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        {formatMoney(row.salesVat)}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        {formatMoney(row.partsBought)}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        {formatMoney(row.costsWithVat)}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        {formatMoney(row.purchasesVat)}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        {formatMoney(row.costsWithoutVat)}
                      </td>
                      <td className="px-2 py-3 text-right tabular-nums">
                        {formatMoney(row.salaries)}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold tabular-nums">
                        {formatMoney(row.profit)}
                      </td>
                      {canRemove ? (
                        <td className="px-2 py-3 text-right">
                          <RemovePriorPeriodButton id={row.id} label={range(row.from, row.to)} />
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-border bg-muted/30 font-semibold">
                  <tr>
                    <td className="px-4 py-3 pl-6">Total</td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(data.totals.sales)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(data.totals.salesVat)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(data.totals.partsBought)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(data.totals.costsWithVat)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(data.totals.purchasesVat)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(data.totals.costsWithoutVat)}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(data.totals.salaries)}
                    </td>
                    <td className="px-4 py-3" />
                    {canRemove ? <td /> : null}
                  </tr>
                </tfoot>
              </table>
            </TableWrap>
          </Panel>
        )}
      </Section>

      {canAdd && data.booksStart ? (
        <Section title="Add a month" description="Leave a box empty when there was nothing.">
          <Panel className="@container">
            <PriorPeriodForm latestMonth={lastMonth} />
          </Panel>
        </Section>
      ) : null}
    </Stack>
  );
}
