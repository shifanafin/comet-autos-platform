'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { setHiddenMenusAction } from '@/app/(app)/settings/actions';
import { ALWAYS_SHOWN_MENUS, NAV_GROUPS, STANDARD_JOB_CARD_MENUS } from '@/lib/nav';
import { cn } from '@/lib/utils';

/**
 * Which menus the workshop sees. Each switch saves as it is flipped. Some
 * are fixed: the ones the app can't be used without, and the standard job
 * card's own screens while the minimal job card is on.
 */
export function MenusForm({
  hiddenMenus,
  detailedJobCards,
  canEdit,
}: {
  hiddenMenus: string[];
  detailedJobCards: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [hidden, setHidden] = useState(hiddenMenus);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle(href: string, label: string, show: boolean) {
    const previous = hidden;
    const next = show ? hidden.filter((h) => h !== href) : [...hidden, href];
    setError(null);
    setHidden(next);
    startTransition(async () => {
      const result = await setHiddenMenusAction(next);
      if (result.ok) {
        toast.success(show ? `${label} shown` : `${label} hidden`);
        router.refresh();
      } else {
        setHidden(previous);
        setError(result.error ?? 'Could not change the menus.');
      }
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {NAV_GROUPS.map((group, index) => (
        <div
          key={group.label ?? `group-${index}`}
          className="overflow-hidden rounded-xl border border-border bg-card"
        >
          {group.label ? (
            <p className="border-b border-border bg-muted/40 px-4 py-2.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:px-6">
              {group.label}
            </p>
          ) : null}
          <ul className="divide-y divide-border">
            {group.items.map((item) => {
              const Icon = item.icon;
              const locked = ALWAYS_SHOWN_MENUS.includes(item.href);
              const standardOnly = !detailedJobCards && STANDARD_JOB_CARD_MENUS.includes(item.href);
              const shown = locked || (!standardOnly && !hidden.includes(item.href));
              const note = locked
                ? 'Always shown'
                : standardOnly
                  ? 'Shown with the standard job card'
                  : item.soon
                    ? 'Coming soon'
                    : null;
              return (
                <li
                  key={item.href}
                  className="flex min-h-14 items-center justify-between gap-4 px-4 py-2 sm:px-6"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium">{item.label}</span>
                      {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
                    </span>
                  </span>
                  <MenuSwitch
                    label={item.label}
                    checked={shown}
                    disabled={!canEdit || locked || standardOnly || isPending}
                    onChange={(show) => toggle(item.href, item.label, show)}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function MenuSwitch({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={`Show ${label}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex min-h-11 shrink-0 items-center disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        className={cn(
          'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn(
            'inline-block size-5 rounded-full bg-background shadow-sm transition-transform',
            checked ? 'translate-x-5.5' : 'translate-x-0.5',
          )}
        />
      </span>
    </button>
  );
}
