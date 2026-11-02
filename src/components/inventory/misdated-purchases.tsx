'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatCalendarDate } from '@/lib/format';
import { keepPurchaseDateAction, moveMisdatedPurchasesAction } from '@/app/(app)/inventory/actions';

/**
 * Purchases booked on another day than their purchase date. Usually typed in
 * late, so stock and cash sit in the wrong month: their stock and same-day
 * payment are brought to the purchase date in one go. Goods that really came
 * on the later day are kept off the list, one by one, first. Any that can't
 * move are listed with the reason; the rest still move.
 */
export function MisdatedPurchases({
  rows,
}: {
  rows: { id: string; purchaseNumber: string; purchaseDate: string; bookedOn: string }[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [refused, setRefused] = useState<{ number: string; why: string }[]>([]);
  const count = rows.length;

  function move() {
    if (
      !window.confirm(
        `Move ${count} purchase${count === 1 ? '' : 's'} to the purchase date? Their stock and any payment made the same day move with them. A closed period, a filed VAT return or a reconciled payment stops one from moving.`,
      )
    ) {
      return;
    }
    startTransition(async () => {
      const result = await moveMisdatedPurchasesAction();
      if (!result.ok || !result.data) {
        toast.error(result.error ?? 'The purchases could not be moved.');
        return;
      }
      setRefused(result.data.refused);
      if (result.data.moved.length) {
        toast.success(`${result.data.moved.length} moved to their purchase date`);
      }
      router.refresh();
    });
  }

  function keep(id: string) {
    startTransition(async () => {
      const result = await keepPurchaseDateAction(id);
      if (result.ok) router.refresh();
      else toast.error(result.error ?? 'That could not be saved.');
    });
  }

  const why = (number: string) => refused.find((row) => row.number === number)?.why;

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="flex min-w-0 items-start gap-2">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>
            {`${count} purchase${count === 1 ? ' is' : 's are'} booked on another day than the purchase date, so stock and cash can fall in the wrong month. If goods really came on the later day, choose Keep this date first.`}
          </span>
        </p>
        <Button type="button" variant="outline" disabled={isPending} onClick={move}>
          {isPending ? 'Working…' : 'Move to purchase dates'}
        </Button>
      </div>
      <details open={refused.length > 0}>
        <summary className="cursor-pointer text-xs font-medium text-primary">
          Review the list
        </summary>
        <ul className="mt-2 flex flex-col divide-y divide-border">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1 py-2">
              <span className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <span className="min-w-0">
                  <Link
                    href={`/inventory/purchases/${row.id}`}
                    className="font-medium hover:underline"
                  >
                    {row.purchaseNumber}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {` · dated ${formatCalendarDate(row.purchaseDate)} · booked ${formatCalendarDate(row.bookedOn)}`}
                  </span>
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={isPending}
                  onClick={() => keep(row.id)}
                >
                  Keep this date
                </Button>
              </span>
              {why(row.purchaseNumber) ? (
                <span className="text-xs text-destructive">{why(row.purchaseNumber)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}
