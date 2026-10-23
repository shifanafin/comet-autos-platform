import Link from 'next/link';
import { notFound } from 'next/navigation';
import { HandCoins } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getPartnerContributions } from '@/lib/finance/partner-contributions';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { StatusPill } from '@/components/shared/status-pill';

export const metadata = { title: "Partner's investment" };

/** A signed stored figure ("-12.50") as money, with a real minus sign. */
const signedMoney = (value: string) =>
  value.startsWith('-') ? `−${formatMoney(value.slice(1))}` : formatMoney(value);

/** One partner's whole investment, every line of it — the investments sheet for one person. */
export default async function PartnerContributionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  let detail;
  try {
    detail = await getPartnerContributions(user, id);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="owner's money" />;
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { partner, lines, totals } = detail;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/finance/money/owner" className="text-primary hover:underline">
            Owner&apos;s money
          </Link>
        }
        title={partner.name}
        description={`Everything ${partner.name} has invested: money put into the company, which is in its books, and what they paid to buy it, which is not.`}
      />

      <Grid className="sm:grid-cols-2 xl:grid-cols-4">
        {[
          ['Put in (capital)', formatMoney(totals.capitalIn)],
          ['Lent to the business', formatMoney(totals.loansIn)],
          ['Taken out (drawings)', formatMoney(totals.drawings)],
          ['Bought the business', formatMoney(totals.bought)],
        ].map(([label, amount]) => (
          <Panel key={label}>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tabular-nums">{amount}</p>
          </Panel>
        ))}
      </Grid>
      <Panel>
        <p className="text-sm text-muted-foreground">Total invested</p>
        <p className="mt-2 text-3xl font-semibold tabular-nums">{signedMoney(totals.invested)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {`${signedMoney(totals.inBusiness)} in the business (put in and lent, less taken out) + ${formatMoney(totals.bought)} paid to buy it.`}
        </p>
      </Panel>

      <Section
        title="Every contribution"
        description="In date order, with the running total. Voided entries count for nothing and are left out."
      >
        {lines.length === 0 ? (
          <EmptyState
            icon={HandCoins}
            title="Nothing recorded yet"
            description={`Money ${partner.name} puts in or takes out, and what they paid to buy the business, shows here.`}
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-200 text-sm">
                <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  <tr>
                    <th className="w-28 px-4 py-3 pl-6">Date</th>
                    <th className="px-2 py-3">What</th>
                    <th className="w-36 px-2 py-3">In the books</th>
                    <th className="w-32 px-2 py-3 text-right">Amount</th>
                    <th className="w-36 px-4 py-3 pr-6 text-right">Running total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td className="px-4 py-3 pl-6 tabular-nums whitespace-nowrap">
                        {formatCalendarDate(line.date)}
                      </td>
                      <td className="px-2 py-3">
                        <span className="font-medium">{line.what}</span>
                        <span className="block text-xs text-muted-foreground">{line.detail}</span>
                        {line.notes ? (
                          <span className="block text-xs text-muted-foreground">{line.notes}</span>
                        ) : null}
                      </td>
                      <td className="px-2 py-3 text-xs">
                        {line.source === 'purchase' ? (
                          <StatusPill tone="neutral">Buying the business</StatusPill>
                        ) : line.journalEntry ? (
                          <Link
                            href="/finance/accounting?view=journal"
                            className="font-mono text-primary hover:underline"
                          >
                            {line.journalEntry}
                          </Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-2 py-3 text-right font-semibold tabular-nums">
                        {signedMoney(line.amount)}
                      </td>
                      <td className="px-4 py-3 pr-6 text-right tabular-nums">
                        {signedMoney(line.runningTotal)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-border bg-muted/30">
                  <tr>
                    <td className="px-4 py-3 pl-6 font-semibold" colSpan={4}>
                      Total invested
                    </td>
                    <td className="px-4 py-3 pr-6 text-right font-semibold tabular-nums">
                      {signedMoney(totals.invested)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Panel>
        )}
      </Section>
    </Stack>
  );
}
