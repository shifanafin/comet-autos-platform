import Link from 'next/link';
import { CalendarClock, TriangleAlert } from 'lucide-react';
import type { UrgentItem } from '@/lib/compliance/reminders';
import { formatCalendarDate } from '@/lib/format';
import { cn } from '@/lib/utils';

/*
 * The bar above every page while a tax or accounting deadline is late or
 * due within 14 days — for the people who keep the books. Not dismissible:
 * it goes when the return is filed, the licence renewed, the salaries paid.
 */
export function DeadlineBar({ items }: { items: UrgentItem[] }) {
  if (items.length === 0) return null;
  const [first, ...rest] = items;
  const late = items.some((item) => item.late);
  return (
    <div
      role="status"
      className={cn(
        'border-b px-4 py-2.5 text-sm sm:px-6',
        late
          ? 'border-danger/30 bg-danger/10 text-danger'
          : 'border-warning/30 bg-warning/10 text-warning',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {late ? (
          <TriangleAlert className="size-4 shrink-0" />
        ) : (
          <CalendarClock className="size-4 shrink-0" />
        )}
        <span className="min-w-0 flex-1 font-medium">
          {first.late ? 'Late: ' : `Due ${formatCalendarDate(first.due)}: `}
          {first.title}
          {rest.length ? <span className="font-normal"> — and {rest.length} more</span> : null}
        </span>
        <Link
          href="/finance/calendar"
          className="shrink-0 font-semibold underline underline-offset-2"
        >
          Open the calendar
        </Link>
      </div>
    </div>
  );
}
