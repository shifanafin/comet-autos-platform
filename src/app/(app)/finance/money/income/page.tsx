import Link from 'next/link';
import { Banknote } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { getOtherIncomeForm, listOtherIncome } from '@/lib/finance/other-income';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { Pagination } from '@/components/shared/pagination';
import { pageFrom, slicePage } from '@/lib/pagination';
import { StatusPill } from '@/components/shared/status-pill';
import { OtherIncomeForm, VoidOtherIncomeButton } from '@/components/finance/other-income-form';

export const metadata = { title: 'Rent & other income' };

/** Money received outside the workshop's sales — rent of its space and the like. */
export default async function OtherIncomePage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  let list;
  let options;
  try {
    [list, options] = await Promise.all([listOtherIncome(user), getOtherIncomeForm(user)]);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="rent & other income" />;
    throw error;
  }
  const { rows, info } = slicePage(list.rows, pageFrom(params.page));

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/money" className="text-primary hover:underline">
            Money
          </Link>
        }
        title="Rent & other income"
        description="Money received that is not from workshop work — the rent of the workshop's space, a commission, scrap sold. Kept apart from your invoices, each with a receipt of its own."
      />

      {list.totals.length ? (
        <Grid className="sm:grid-cols-3">
          {list.totals.map((total) => (
            <Panel key={total.name}>
              <p className="text-sm text-muted-foreground">{total.name}</p>
              <p className="mt-2 text-2xl font-semibold tabular-nums">{formatMoney(total.net)}</p>
              <p className="mt-1 text-xs text-muted-foreground">Before VAT, all recorded</p>
            </Panel>
          ))}
        </Grid>
      ) : null}

      {list.canRecord ? (
        <Section title="Record income received">
          <Panel>
            <OtherIncomeForm options={options} />
          </Panel>
        </Section>
      ) : null}

      <Section title="Recorded">
        {list.rows.length === 0 ? (
          <EmptyState
            icon={Banknote}
            title="Nothing recorded yet"
            description="Each time rent or other income is received, it is listed here with its receipt."
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-180 text-sm">
                <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  <tr>
                    <th className="w-28 px-4 py-3 pl-6">Date</th>
                    <th className="px-2 py-3">From · for</th>
                    <th className="w-28 px-2 py-3 text-right">VAT</th>
                    <th className="w-32 px-2 py-3 text-right">Received</th>
                    <th className="w-0 px-4 py-3 pr-6" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => {
                    const isVoid = row.status === 'VOID';
                    return (
                      <tr key={row.id} className={isVoid ? 'text-muted-foreground' : undefined}>
                        <td className="px-4 py-3 pl-6 tabular-nums whitespace-nowrap">
                          {formatCalendarDate(row.receivedOn)}
                        </td>
                        <td className="px-2 py-3">
                          <Link
                            href={`/finance/money/income/${row.id}`}
                            className="font-medium hover:underline"
                          >
                            {row.receivedFrom}
                          </Link>{' '}
                          {isVoid ? <StatusPill tone="neutral">Void</StatusPill> : null}
                          <span className="block text-xs text-muted-foreground">
                            {`${row.incomeNumber} · ${row.description} · into ${row.account.accountName}`}
                          </span>
                          {isVoid && row.voidReason ? (
                            <span className="block text-xs">{`Voided: ${row.voidReason}`}</span>
                          ) : null}
                        </td>
                        <td className="px-2 py-3 text-right tabular-nums">
                          {formatMoney(row.vatAmount.toString())}
                        </td>
                        <td
                          className={
                            isVoid
                              ? 'px-2 py-3 text-right tabular-nums line-through'
                              : 'px-2 py-3 text-right font-semibold tabular-nums'
                          }
                        >
                          {formatMoney(row.amount.toString())}
                        </td>
                        <td className="px-4 py-3 pr-6 text-right">
                          {list.canVoid && !isVoid ? (
                            <VoidOtherIncomeButton id={row.id} label={row.incomeNumber} />
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination
              info={info}
              basePath="/finance/money/income"
              params={params}
              noun="receipts"
            />
          </Panel>
        )}
      </Section>
    </Stack>
  );
}
