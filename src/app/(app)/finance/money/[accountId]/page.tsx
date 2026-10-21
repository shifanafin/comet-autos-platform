import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getMoneyAccountActivity } from '@/lib/finance/money';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import { SearchField } from '@/components/shared/search-field';
import { MonthByMonth } from '@/components/accounting/month-by-month';

const money = (value: string) =>
  value.startsWith('-') ? `−${formatMoney(value.slice(1))}` : formatMoney(value);

/**
 * One money account for a period: what it held when the period began, every
 * movement in and out, newest first, with the balance after each, and what it
 * held at the end.
 */
export default async function MoneyAccountPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountId: string }>;
  searchParams: Promise<{ period?: string; from?: string; to?: string; q?: string }>;
}) {
  const user = await requireUser();
  const { accountId } = await params;
  const { q, ...query } = await searchParams;
  const search = (q ?? '').trim().toLowerCase();
  let activity;
  try {
    activity = await getMoneyAccountActivity(user, accountId, {
      ...query,
      period: query.period ?? 'month',
    });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof AuthError) return <AccessDenied what="money" />;
    throw error;
  }
  const { account, statement, months } = activity;
  const period = activity.period!;
  const isCard = account.kind === 'company-card';
  // A search narrows the lines shown; the figures stay those of the whole period.
  const rows = search
    ? activity.rows.filter((row) =>
        [row.description, row.entryNumber ?? '', row.moneyIn, row.moneyOut].some((text) =>
          text.toLowerCase().includes(search),
        ),
      )
    : activity.rows;
  /** The period chosen, kept while searching. */
  const keep = Object.fromEntries(
    Object.entries(query).filter((entry): entry is [string, string] => Boolean(entry[1])),
  );

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/money" className="text-primary hover:underline">
            {`Money · ${account.kindLabel}`}
          </Link>
        }
        title={account.name}
        description={`${isCard ? 'Owed on it' : 'In it'} now: ${money(account.balance)}. Every movement in the period, newest first.`}
      />

      <FinancePeriodPicker
        period={period}
        basePath={`/finance/money/${account.id}`}
        presets={['today', 'week', 'month', 'last-month', 'quarter', 'last-quarter', 'year']}
      />

      <Panel className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        {[
          {
            label: `${isCard ? 'Owed' : 'Balance'} on ${formatCalendarDate(period.from)}`,
            value: money(statement.opening),
          },
          { label: isCard ? 'Paid off' : 'Money in', value: formatMoney(statement.moneyIn) },
          { label: isCard ? 'Spent' : 'Money out', value: formatMoney(statement.moneyOut) },
          {
            label: `${isCard ? 'Owed' : 'Balance'} on ${formatCalendarDate(period.to)}`,
            value: money(statement.closing),
            strong: true,
          },
        ].map((figure) => (
          <div key={figure.label} className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{figure.label}</span>
            <span
              className={
                figure.strong
                  ? 'text-xl leading-none font-semibold text-primary tabular-nums'
                  : 'text-xl leading-none font-semibold tabular-nums'
              }
            >
              {figure.value}
            </span>
          </div>
        ))}
      </Panel>

      {account.belowZero ? (
        <p className="flex items-start gap-2 rounded-xl border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-warning sm:px-6">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          Below zero: more has been paid out of it than was ever recorded going in. What it held at
          the start (its opening balance), or money put into it, has not been entered yet.
        </p>
      ) : null}

      <MonthByMonth
        months={months}
        columns={isCard ? ['Paid off', 'Spent'] : ['Money in', 'Money out']}
        balanceLabel={isCard ? 'Owed' : 'Balance'}
      />

      <Stack gap="sm">
        <SearchField
          initialQuery={q ?? ''}
          placeholder="What, entry number or amount"
          keep={keep}
        />
        {search ? (
          <p className="text-sm text-muted-foreground">
            {`${rows.length} movement${rows.length === 1 ? '' : 's'} in this period match “${q?.trim()}”. The figures above are for the whole period.`}
          </p>
        ) : null}
      </Stack>

      {rows.length === 0 ? (
        <EmptyState
          title={search ? 'Nothing matches' : 'Nothing in this period'}
          description={
            search
              ? 'Try another word or amount, or a wider period.'
              : 'No money went into or out of this account in these dates. Choose another period.'
          }
        />
      ) : (
        <Panel padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <tr>
                  <th className="w-28 px-4 py-3 pl-6">Date</th>
                  <th className="px-2 py-3">What</th>
                  <th className="w-32 px-2 py-3 text-right">{isCard ? 'Paid off' : 'Money in'}</th>
                  <th className="w-32 px-2 py-3 text-right">{isCard ? 'Spent' : 'Money out'}</th>
                  <th className="w-36 px-4 py-3 pr-6 text-right">{isCard ? 'Owed' : 'Balance'}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-2.5 pl-6 tabular-nums whitespace-nowrap">
                      {formatCalendarDate(row.date)}
                    </td>
                    <td className="px-2 py-2.5">
                      {row.href ? (
                        <Link href={row.href} className="hover:underline">
                          {row.description}
                        </Link>
                      ) : (
                        row.description
                      )}
                      {row.entryNumber ? (
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {row.entryNumber}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {row.moneyIn ? formatMoney(row.moneyIn) : ''}
                    </td>
                    <td className="px-2 py-2.5 text-right tabular-nums">
                      {row.moneyOut ? formatMoney(row.moneyOut) : ''}
                    </td>
                    <td className="px-4 py-2.5 pr-6 text-right font-medium tabular-nums">
                      {money(row.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </Stack>
  );
}
