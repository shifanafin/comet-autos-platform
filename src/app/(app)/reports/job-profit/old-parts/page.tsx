import Link from 'next/link';
import { PackageCheck } from 'lucide-react';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { getOldPartLines, type OldPartLines } from '@/lib/inventory/old-part-lines';
import { formatCalendarDate, formatDate, formatMoney } from '@/lib/format';
import { filsToString } from '@/lib/money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { OldPartLineForm, UndoWriteOffCost } from '@/components/finance/old-part-line-form';

export const dynamic = 'force-dynamic';

/**
 * The Parts lines of invoices issued before parts were tied to stock: no
 * part, no cost, so their job's profit is shown too high. Each is settled
 * here once (lib/inventory/old-part-lines.ts). `?invoice=` shows one
 * invoice's lines first, coming from its page.
 */
export default async function OldPartsLinesPage({
  searchParams,
}: {
  searchParams: Promise<{ invoice?: string }>;
}) {
  const user = await requireUser();
  const { invoice: focus } = await searchParams;
  let data: OldPartLines;
  try {
    data = await getOldPartLines(user);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="old parts lines" />;
    throw error;
  }
  const open = [...data.open].sort(
    (a, b) => Number(b.invoiceId === focus) - Number(a.invoiceId === focus),
  );
  const invoices = new Set(data.open.map((line) => line.invoiceId)).size;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link href="/reports/job-profit" className="tracking-normal normal-case hover:text-foreground">
            Job profit
          </Link>
        }
        title="Old parts lines"
        description={
          open.length
            ? `${open.length} Parts line${open.length === 1 ? '' : 's'} on ${invoices} invoice${invoices === 1 ? '' : 's'} typed before parts were tied to stock — no part, no cost, so those jobs show more profit than they made. Say what each one was.`
            : 'Parts lines typed before parts were tied to stock appear here until each is given its cost.'
        }
      />

      {open.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="Every parts line has its cost"
          description="Job profit now counts what every part sold cost."
        />
      ) : (
        <Stack gap="lg">
          {open.map((line) => (
            <Panel key={line.id} className="flex flex-col gap-4">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <div className="min-w-0">
                  <p className="font-medium">{line.description}</p>
                  <p className="text-xs text-muted-foreground">
                    <Link href={`/finance/invoices/${line.invoiceId}`} className="hover:underline">
                      {line.invoiceNumber}
                    </Link>{' '}
                    · {formatCalendarDate(line.issueDate)} · {line.customerName}
                  </p>
                </div>
                <p className="text-sm tabular-nums text-muted-foreground">
                  {line.quantity} × {formatMoney(line.unitPrice)} ={' '}
                  <span className="font-medium text-foreground">{formatMoney(line.lineTotal)}</span>
                </p>
              </div>
              <OldPartLineForm line={line} writeOffs={data.writeOffs} />
            </Panel>
          ))}
        </Stack>
      )}

      {data.costed.length ? (
        <section className="flex flex-col gap-3">
          <div>
            <h2 className="text-base font-semibold">Costed at an old write-off</h2>
            <p className="text-sm text-muted-foreground">
              Their parts left stock on a write-off already in the books, so nothing more was
              booked — only each job&rsquo;s profit counts the cost now.
            </p>
          </div>
          <Panel padding="none" className="divide-y divide-border overflow-hidden">
            {data.costed.map((line) => (
              <div key={line.id} className="flex items-center justify-between gap-4 px-4 py-3 sm:px-6">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {line.description}
                    <span className="font-normal text-muted-foreground"> → {line.partName}</span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    <Link href={`/finance/invoices/${line.invoiceId}`} className="hover:underline">
                      {line.invoiceNumber}
                    </Link>{' '}
                    · {line.quantity} at cost {formatMoney(filsToString(line.costFils))}
                    {line.writtenOffOn ? ` · written off ${formatDate(line.writtenOffOn)}` : ''}
                  </p>
                </div>
                <UndoWriteOffCost itemId={line.id} />
              </div>
            ))}
          </Panel>
        </section>
      ) : null}
    </Stack>
  );
}
