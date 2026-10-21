import { formatMoney } from '@/lib/format';
import { filsToString } from '@/lib/money';
import type { MonthTotals } from '@/lib/accounting/months';
import { Panel, Section } from '@/components/layout/primitives';

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

const signed = (fils: number) =>
  fils < 0 ? `−${formatMoney(filsToString(-fils))}` : formatMoney(filsToString(fils));

/**
 * The period month by month: each month's opening, what went in and out,
 * and its closing — which is the next month's opening. Shown when the period
 * spans more than one month.
 */
export function MonthByMonth({
  months,
  columns,
  balanceLabel = 'Balance',
}: {
  months: MonthTotals[];
  /** The two movement columns: ['Money in', 'Money out'] or ['Debit', 'Credit']. */
  columns: [string, string];
  balanceLabel?: string;
}) {
  if (months.length < 2) return null;
  const total = months.reduce((sum, m) => ({ a: sum.a + m.a, b: sum.b + m.b }), { a: 0, b: 0 });
  return (
    <Section
      title="Month by month"
      description={`Each month opens on the last one's ${balanceLabel.toLowerCase()} at its close.`}
    >
      <Panel padding="none" className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="px-4 py-3 pl-6">Month</th>
              <th className="w-36 px-2 py-3 text-right">Opening</th>
              <th className="w-32 px-2 py-3 text-right">{columns[0]}</th>
              <th className="w-32 px-2 py-3 text-right">{columns[1]}</th>
              <th className="w-36 px-4 py-3 pr-6 text-right">Closing</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {months.map((m) => (
              <tr key={m.month}>
                <td className="px-4 py-2.5 pl-6 font-medium whitespace-nowrap">
                  {MONTH.format(new Date(`${m.month}-01T00:00:00Z`))}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">{signed(m.opening)}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {m.a ? formatMoney(filsToString(m.a)) : '—'}
                </td>
                <td className="px-2 py-2.5 text-right tabular-nums">
                  {m.b ? formatMoney(filsToString(m.b)) : '—'}
                </td>
                <td className="px-4 py-2.5 pr-6 text-right font-semibold tabular-nums">
                  {signed(m.closing)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border bg-muted/20 font-semibold">
            <tr>
              <td className="px-4 py-2.5 pl-6">Whole period</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{signed(months[0].opening)}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">
                {formatMoney(filsToString(total.a))}
              </td>
              <td className="px-2 py-2.5 text-right tabular-nums">
                {formatMoney(filsToString(total.b))}
              </td>
              <td className="px-4 py-2.5 pr-6 text-right tabular-nums">
                {signed(months[months.length - 1].closing)}
              </td>
            </tr>
          </tfoot>
        </table>
      </Panel>
    </Section>
  );
}
