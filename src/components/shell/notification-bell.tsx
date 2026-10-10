'use client';

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlarmClock, Bell, BellOff, BellRing, CalendarClock, CheckCheck, ListTodo, Loader2, LogIn, Trash2, Volume2, VolumeX, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  dismissAllAction,
  dismissNotificationAction,
  loadNotificationsAction,
  markAllReadAction,
  removePushSubscriptionAction,
  savePushSubscriptionAction,
} from '@/app/(app)/notifications/actions';
import { announce, primeSound, setSoundEnabled, soundEnabled } from '@/lib/notifications/sound';
import { cn } from '@/lib/utils';

/*
 * The bell in the top bar: how many are unread, and the list.
 *
 * Opening a notification marks it read and goes where it points; it stays
 * in the list until removed (✕ for one, "Clear all" for every one), so it
 * can be kept as a reminder. The list is read only when the bell is opened.
 *
 * The bell also switches on push notifications for this device, and plays
 * the chime and spoken message when one arrives while the app is open (the
 * service worker passes it here instead of showing the phone's banner).
 */

type Item = {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  href: string | null;
  read: boolean;
  createdAt: string;
};

type PushState = 'checking' | 'unsupported' | 'blocked' | 'off' | 'on' | 'unavailable';

const ICON: Record<string, typeof Bell> = {
  TASK_ASSIGNED: ListTodo,
  CHECK_IN_REMINDER: LogIn,
  CHECK_OUT_REMINDER: AlarmClock,
  COMPLIANCE_REMINDER: CalendarClock,
};

function ago(iso: string) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

function keyBytes(base64: string) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

export function NotificationBell({ unread: initialUnread, vapidKey }: { unread: number; vapidKey: string | null }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [unread, setUnread] = useState(initialUnread);
  const [push, setPush] = useState<PushState>('checking');
  const [sound, setSound] = useState(true);
  const [pending, startTransition] = useTransition();
  // Whether the list is showing, for the push listener set up once below.
  const panelOpen = useRef(false);
  useEffect(() => {
    panelOpen.current = open;
  }, [open]);

  // The server's count wins whenever the page is refreshed.
  const [seenInitial, setSeenInitial] = useState(initialUnread);
  if (initialUnread !== seenInitial) {
    setSeenInitial(initialUnread);
    setUnread(initialUnread);
  }

  const load = useCallback(async () => {
    const data = await loadNotificationsAction();
    setItems(data.items);
    setUnread(data.unread);
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- browser-only facts, read after hydration */
    setSound(soundEnabled());
    const supported =
      'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) setPush('unsupported');
    else if (!vapidKey) setPush('unavailable');
    else if (Notification.permission === 'denied') setPush('blocked');
    else {
      navigator.serviceWorker.ready
        .then((registration) => registration.pushManager.getSubscription())
        .then((subscription) => setPush(subscription ? 'on' : 'off'))
        .catch(() => setPush('off'));
    }
    /* eslint-enable react-hooks/set-state-in-effect */

    // Sound may only start after a first tap on the page.
    const prime = () => primeSound();
    window.addEventListener('pointerdown', prime, { once: true });

    // A push arriving while the app is open: chime, voice, and a message here.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== 'notification') return;
      const payload = event.data.payload as { id?: string; kind?: string; title?: string; body?: string };
      setUnread((count) => count + 1);
      announce(payload.kind ?? 'TASK_ASSIGNED');
      toast(payload.title ?? 'New notification', {
        description: payload.body,
        action: payload.id
          ? { label: 'Open', onClick: () => router.push(`/notifications/${payload.id}/open`) }
          : undefined,
        duration: 10_000,
      });
      if (panelOpen.current) void load();
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('pointerdown', prime);
      navigator.serviceWorker?.removeEventListener('message', onMessage);
    };
  }, [vapidKey, router, load]);

  // Close on a tap outside, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (panel.current && !panel.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) startTransition(load);
  }

  async function turnOn() {
    if (!vapidKey) return;
    primeSound();
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setPush(permission === 'denied' ? 'blocked' : 'off');
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidKey) }));
      const result = await savePushSubscriptionAction(subscription.toJSON());
      if (!result.ok) {
        toast.error(result.error ?? 'Notifications could not be turned on.');
        return;
      }
      setPush('on');
      toast.success('Notifications are on for this device');
      announce('TASK_ASSIGNED', 'Notifications are on.');
    } catch {
      toast.error('This device couldn’t turn on notifications. On an iPhone, add the app to the Home Screen first.');
    }
  }

  async function turnOff() {
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await removePushSubscriptionAction(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setPush('off');
      toast.success('Notifications are off for this device');
    } catch {
      toast.error('Notifications could not be turned off.');
    }
  }

  function remove(id: string) {
    const wasUnread = items?.find((item) => item.id === id && !item.read);
    setItems((current) => current?.filter((item) => item.id !== id) ?? null);
    if (wasUnread) setUnread((count) => Math.max(0, count - 1));
    void dismissNotificationAction(id);
  }

  function clearAll() {
    setItems([]);
    setUnread(0);
    void dismissAllAction();
  }

  function readAll() {
    setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? null);
    setUnread(0);
    void markAllReadAction();
  }

  return (
    <div ref={panel} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        className="relative flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        {unread ? <BellRing className="size-5" /> : <Bell className="size-5" />}
        {unread ? (
          <span className="absolute top-1 right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white tabular-nums">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="fixed inset-x-3 top-[calc(4rem+env(safe-area-inset-top))] z-50 flex max-h-[75dvh] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xl sm:absolute sm:inset-x-auto sm:top-12 sm:right-0 sm:w-96">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h2 className="text-[15px] font-semibold">Notifications</h2>
            <div className="flex items-center gap-1">
              {items?.some((item) => !item.read) ? (
                <button type="button" onClick={readAll} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/5">
                  <CheckCheck className="size-3.5" />
                  Mark all read
                </button>
              ) : null}
              {items?.length ? (
                <button type="button" onClick={clearAll} className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-destructive">
                  <Trash2 className="size-3.5" />
                  Clear all
                </button>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {items === null || (pending && items.length === 0) ? (
              <p className="flex items-center justify-center gap-2 px-4 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </p>
            ) : items.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">You’re all caught up.</p>
            ) : (
              <ul className="divide-y divide-border">
                {items.map((item) => {
                  const Icon = ICON[item.kind] ?? Bell;
                  return (
                    <li key={item.id} className={cn('group relative flex', !item.read && 'bg-primary/5')}>
                      <a
                        href={`/notifications/${item.id}/open`}
                        onClick={() => setOpen(false)}
                        className="flex min-w-0 flex-1 items-start gap-3 py-3 pr-2 pl-4 hover:bg-muted/50"
                      >
                        <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full', item.read ? 'bg-muted text-muted-foreground' : 'bg-primary/10 text-primary')}>
                          <Icon className="size-4" />
                        </span>
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className={cn('text-sm leading-snug', !item.read && 'font-semibold')}>{item.title}</span>
                          {item.body ? <span className="line-clamp-2 text-xs text-muted-foreground">{item.body}</span> : null}
                          <span className="text-[11px] text-muted-foreground">{ago(item.createdAt)}</span>
                        </span>
                        {!item.read ? <span aria-label="Unread" className="mt-2 size-2 shrink-0 rounded-full bg-primary" /> : null}
                      </a>
                      <button
                        type="button"
                        onClick={() => remove(item.id)}
                        aria-label={`Remove “${item.title}”`}
                        className="flex w-10 shrink-0 items-center justify-center text-muted-foreground hover:text-destructive"
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-border bg-muted/30 px-4 py-3 text-xs">
            {push === 'on' ? (
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1.5 text-success">
                  <BellRing className="size-3.5" />
                  Notifications on for this device
                </span>
                <button type="button" onClick={turnOff} className="font-medium text-muted-foreground hover:text-foreground">
                  Turn off
                </button>
              </div>
            ) : push === 'off' ? (
              <button type="button" onClick={turnOn} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary-hover">
                <BellRing className="size-4" />
                Turn on notifications on this device
              </button>
            ) : push === 'blocked' ? (
              <p className="flex items-start gap-1.5 text-muted-foreground">
                <BellOff className="mt-px size-3.5 shrink-0" />
                Notifications are blocked for this site. Allow them in the browser’s site settings.
              </p>
            ) : push === 'unsupported' ? (
              <p className="flex items-start gap-1.5 text-muted-foreground">
                <BellOff className="mt-px size-3.5 shrink-0" />
                This browser can’t receive notifications. On an iPhone, add the app to the Home Screen and open it from there.
              </p>
            ) : push === 'unavailable' ? (
              <p className="text-muted-foreground">Phone notifications aren’t set up on the server yet.</p>
            ) : null}
            <button
              type="button"
              onClick={() => {
                const next = !sound;
                setSound(next);
                setSoundEnabled(next);
                if (next) announce('TASK_ASSIGNED', 'Sound is on.');
              }}
              className="inline-flex w-fit items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground"
            >
              {sound ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
              {sound ? 'Sound on (chime + voice)' : 'Sound off'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
