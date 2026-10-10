'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { UrgentItem } from '@/lib/compliance/reminders';
import { formatCalendarDate } from '@/lib/format';

/*
 * Alert mode: while a tax or accounting deadline is late or due within three
 * days, a red frame runs round the whole app (until it is done) and a red
 * message opens over the page. The message comes back each new session, and
 * an hour after "Remind me in an hour", until someone opens the calendar.
 */

const KEY = 'compliance-alert-snoozed-until';
const HOUR = 60 * 60 * 1000;

function snoozedUntil(): number {
  try {
    return Number(sessionStorage.getItem(KEY) ?? 0);
  } catch {
    return 0;
  }
}

function snooze(ms: number) {
  try {
    sessionStorage.setItem(KEY, String(Date.now() + ms));
  } catch {
    // Storage blocked: the message simply shows again next time.
  }
}

export function DeadlineAlert({ items }: { items: UrgentItem[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const alerts = items.filter((item) => item.alert);
  const [open, setOpen] = useState(false);
  // On the calendar itself the message has done its job.
  const onCalendar = pathname.startsWith('/finance/calendar');

  useEffect(() => {
    if (alerts.length === 0) return;
    if (onCalendar) {
      snooze(8 * HOUR);
      return;
    }
    // The snooze lives in this browser's session: read it once mounted.
    const timer = window.setTimeout(() => {
      if (Date.now() >= snoozedUntil()) setOpen(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [alerts.length, onCalendar]);

  if (alerts.length === 0) return null;
  const late = alerts.some((item) => item.late);

  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 z-[60] border-4 border-danger/80 md:border-[6px]"
      />
      <Dialog
        open={open && !onCalendar}
        onOpenChange={(next) => {
          if (!next) snooze(HOUR);
          setOpen(next);
        }}
      >
        <DialogContent className="border-danger/40">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-danger">
              <TriangleAlert className="size-5 shrink-0" />
              {late ? 'A tax deadline has passed' : 'A tax deadline is days away'}
            </DialogTitle>
            <DialogDescription>
              Missing these brings fines from the FTA. Please deal with them today.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {alerts.map((item) => (
              <li key={item.key} className="flex flex-col gap-0.5 px-4 py-3 text-sm">
                <span className="font-medium">{item.title}</span>
                <span className={item.late ? 'text-danger' : 'text-warning'}>
                  {item.late ? 'Was due' : 'Due'} {formatCalendarDate(item.due)}
                </span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              className="h-11"
              onClick={() => {
                snooze(HOUR);
                setOpen(false);
              }}
            >
              Remind me in an hour
            </Button>
            <Button
              className="h-11"
              onClick={() => {
                snooze(8 * HOUR);
                setOpen(false);
                router.push('/finance/calendar');
              }}
            >
              Open the calendar now
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
