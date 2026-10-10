import Link from 'next/link';
import { Building2, Plus } from 'lucide-react';
import { AuthError, hasPermission, requireUser } from '@/lib/auth/authorize';
import { lastEndedMonth, listFixedAssets } from '@/lib/accounting/fixed-assets';
import { formatCalendarDate, formatMoney, localDateString } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { PrintButton } from '@/components/shared/print-button';
import { RunDepreciationForm } from '@/components/accounting/fixed-asset-forms';

export const metadata = { title: 'Fixed assets' };

export default async function FixedAssetsPage() {
  const user = await requireUser();
  let register;
  try {
    register = await listFixedAssets(user);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="the fixed asset register" />;
    throw error;
  }
  const canEdit = hasPermission(user, 'accounting.edit');
  const { rows, totals } = register;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Accounting"
        title="Fixed assets"
        description="The register of equipment, vehicles, furniture and computers the workshop owns: what each cost, the depreciation charged so far and its book value. Depreciation is straight-line, monthly, and booked automatically when you run it."
        actions={
          <span className="flex flex-wrap gap-2">
            <PrintButton />
            {canEdit ? (
              <LinkButton href="/finance/fixed-assets/new" size="lg">
                <Plus />
                Add asset
              </LinkButton>
            ) : null}
          </span>
        }
      />

      {canEdit && rows.some((row) => row.status === 'ACTIVE') ? (
        <Panel>
          <RunDepreciationForm month={lastEndedMonth()} />
          <p className="mt-3 text-xs text-muted-foreground">
            Run it each month (or before closing a period). Months already charged are skipped, so
            running it twice never charges twice.
          </p>
        </Panel>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No fixed assets yet"
          description="Add the lifts, tools, vehicles and equipment the workshop owns — including those bought before these books began."
        />
      ) : (
        <Panel padding="none" className="print-sheet overflow-hidden">
          <p className="hidden px-4 pt-4 text-base font-semibold print:block">
            {`Fixed asset register — ${formatCalendarDate(localDateString())}`}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3 pl-6">Asset</th>
                  <th className="w-28 px-2 py-3">Acquired</th>
                  <th className="w-20 px-2 py-3 text-right">Life</th>
                  <th className="w-32 px-2 py-3 text-right">Cost</th>
                  <th className="w-32 px-2 py-3 text-right">Depreciation</th>
                  <th className="w-32 px-4 py-3 pr-6 text-right">Book value</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className={row.status === 'DISPOSED' ? 'text-muted-foreground' : undefined}
                  >
                    <td className="px-4 py-3 pl-6">
                      <Link
                        href={`/finance/fixed-assets/${row.id}`}
                        className="font-medium hover:underline"
                      >
                        {row.name}
                      </Link>{' '}
                      {row.status === 'DISPOSED' ? (
                        <StatusPill tone="neutral">Disposed</StatusPill>
                      ) : null}
                      <span className="block text-xs text-muted-foreground">
                        {`${row.assetNumber} · ${row.assetAccount.accountName}${
                          row.chargedTo ? ` · charged to ${formatCalendarDate(row.chargedTo)}` : ''
                        }`}
                      </span>
                    </td>
                    <td className="px-2 py-3 tabular-nums">{formatCalendarDate(row.acquiredOn)}</td>
                    <td className="px-2 py-3 text-right tabular-nums">{`${row.usefulLifeMonths} mo`}</td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(row.cost.toString())}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {formatMoney(row.accumulated)}
                    </td>
                    <td className="px-4 py-3 pr-6 text-right font-medium tabular-nums">
                      {row.status === 'DISPOSED' ? '—' : formatMoney(row.bookValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-border font-semibold">
                <tr>
                  <td className="px-4 py-3 pl-6" colSpan={3}>
                    In use
                  </td>
                  <td className="px-2 py-3 text-right tabular-nums">{formatMoney(totals.cost)}</td>
                  <td className="px-2 py-3 text-right tabular-nums">
                    {formatMoney(totals.accumulated)}
                  </td>
                  <td className="px-4 py-3 pr-6 text-right tabular-nums">
                    {formatMoney(totals.bookValue)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        </Panel>
      )}
    </Stack>
  );
}
