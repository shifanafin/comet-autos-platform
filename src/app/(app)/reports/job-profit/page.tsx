import Link from 'next/link';
import { Receipt } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { getJobProfitReport, type JobProfitReport } from '@/lib/finance/job-costing';
import { formatCalendarDate, formatDate, formatMoney } from '@/lib/format';
import { filsToString } from '@/lib/money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { FinancePeriodPicker } from '@/components/finance/period-picker';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const money = (value: number) =>
  `${value < 0 ? '−' : ''}${formatMoney(filsToString(Math.abs(value)))}`;

/**
 * Every job invoiced in a period: what it sold for, what its parts and other
 * costs were, and what it made (lib/finance/job-costing.ts). Sort the eye to
 * the jobs that made little or lost money.
 */
export default async function JobProfitPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string; from?: string; to?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  let report: JobProfitReport;
  try {
    report = await getJobProfitReport(user, params);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="job profit" />;
    throw error;
  }
  const { period, jobs, totals } = report;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/reports" className="tracking-normal normal-case hover:text-foreground">
            Reports
          </Link>
        }
        title="Job profit"
        description={`What each job invoiced from ${formatDate(period.from)} to ${formatDate(period.to)} cost and made: sales before VAT, less the parts at cost and other costs entered against the job.`}
      />
      <FinancePeriodPicker
        period={period}
        basePath="/reports/job-profit"
        presets={['week', 'month', 'last-month', 'quarter', 'year']}
      />

      <Panel className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        {[
          ['Sales', formatMoney(totals.sales), `${jobs.length} job${jobs.length === 1 ? '' : 's'}`],
          ['Parts at cost', formatMoney(totals.parts), 'Cost of the parts sold'],
          ['Other job costs', formatMoney(totals.other), 'Outside work, towing, materials'],
          [
            totals.profitNegative ? 'Loss' : 'Profit',
            `${totals.profitNegative ? '−' : ''}${formatMoney(totals.profit)}`,
            totals.margin !== null ? `${totals.margin}% of sales` : '',
          ],
        ].map(([label, value, hint]) => (
          <div key={label} className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            <span className="truncate text-2xl leading-none font-semibold tabular-nums">{value}</span>
            <span className="text-xs text-muted-foreground">{hint}</span>
          </div>
        ))}
      </Panel>
      {totals.uncostedJobs > 0 ? (
        <p className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm sm:px-5">
          {totals.uncostedJobs} job{totals.uncostedJobs === 1 ? ' has' : 's have'} parts lines with
          no cost — typed before parts were tied to stock — so their profit is shown higher than it
          really was.{' '}
          <Link
            href="/reports/job-profit/old-parts"
            className="font-medium underline underline-offset-2"
          >
            Give them their cost
          </Link>
        </p>
      ) : null}

      {jobs.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="No jobs invoiced in this period"
          description="Choose a wider period to see more."
        />
      ) : (
        <Panel padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Job</TableHead>
                  <TableHead className="hidden md:table-cell">Customer</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Parts</TableHead>
                  <TableHead className="hidden text-right sm:table-cell">Other</TableHead>
                  <TableHead className="text-right">Profit</TableHead>
                  <TableHead className="text-right">Margin</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {jobs.map((job) => {
                  const loss = job.profitFils < 0;
                  const thin = !loss && job.margin !== null && job.margin < 20;
                  return (
                    <TableRow key={job.invoiceId} className="relative">
                      <TableCell>
                        <Link
                          href={`/finance/invoices/${job.invoiceId}`}
                          className="font-medium row-link hover:underline"
                        >
                          {job.invoiceNumber}
                        </Link>
                        <span className="block text-xs text-muted-foreground">
                          {formatCalendarDate(job.issueDate)}
                          {job.jobNumber ? ` · ${job.jobNumber}` : ''}
                          {job.vehicle ? ` · ${job.vehicle}` : ''}
                          {job.uncostedLines ? ' · some parts without cost' : ''}
                        </span>
                      </TableCell>
                      <TableCell className="hidden max-w-56 truncate md:table-cell">
                        {job.customerName}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{money(job.salesFils)}</TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">
                        {money(job.partsFils)}
                      </TableCell>
                      <TableCell className="hidden text-right tabular-nums sm:table-cell">
                        {job.otherFils ? money(job.otherFils) : '—'}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right font-medium tabular-nums',
                          loss && 'text-destructive',
                        )}
                      >
                        {money(job.profitFils)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          loss ? 'text-destructive' : thin ? 'text-warning' : 'text-muted-foreground',
                        )}
                      >
                        {job.margin !== null ? `${job.margin}%` : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </Panel>
      )}
    </Stack>
  );
}
