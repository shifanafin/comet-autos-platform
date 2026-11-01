'use client';

import { useEffect, useState } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Check, Monitor, Moon, Palette, Sun, type LucideIcon } from 'lucide-react';
import {
  ACCENTS,
  DEFAULT_THEME,
  readTheme,
  saveTheme,
  THEME_MODES,
  type ThemeMode,
  type ThemeSettings,
} from '@/lib/theme';
import { cn } from '@/lib/utils';

const MODE_ICON: Record<ThemeMode, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

/** Light, dark or the device's setting, and the colour theme. Remembered in this browser. */
export function ThemeControls({ className }: { className?: string }) {
  const [theme, setTheme] = useState<ThemeSettings>(DEFAULT_THEME);
  useEffect(() => {
    // Read after the first render, so the server and the browser draw the same thing.
    const timeout = setTimeout(() => setTheme(readTheme()), 0);
    return () => clearTimeout(timeout);
  }, []);
  function choose(change: Partial<ThemeSettings>) {
    const next = { ...theme, ...change };
    setTheme(next);
    saveTheme(next);
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Appearance</p>
        <div
          role="radiogroup"
          aria-label="Appearance"
          className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1"
        >
          {THEME_MODES.map((mode) => {
            const Icon = MODE_ICON[mode.value];
            return (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={theme.mode === mode.value}
                onClick={() => choose({ mode: mode.value })}
                className={cn(
                  'flex h-9 items-center justify-center gap-1.5 rounded-md text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                  theme.mode === mode.value
                    ? 'bg-card text-foreground shadow-card'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-3.5" />
                {mode.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-xs font-medium text-muted-foreground">Colour theme</p>
        <div role="radiogroup" aria-label="Colour theme" className="grid grid-cols-3 gap-2">
          {ACCENTS.map((accent) => {
            const selected = theme.accent === accent.value;
            return (
              <button
                key={accent.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => choose({ accent: accent.value })}
                className={cn(
                  'flex flex-col items-center gap-1.5 rounded-lg border px-1 py-2 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'border-primary bg-accent font-medium' : 'border-border',
                )}
              >
                <span
                  aria-hidden
                  className="flex size-6 items-center justify-center rounded-full text-white"
                  style={{ backgroundColor: accent.swatch }}
                >
                  {selected ? <Check className="size-3.5" /> : null}
                </span>
                {accent.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The theme picker in the top bar (on a phone, it is in the menu drawer). */
export function ThemeMenu() {
  return (
    <Popover.Root>
      <Popover.Trigger
        aria-label="Appearance and colour theme"
        title="Appearance and colour theme"
        className="hidden size-10 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:flex"
      >
        <Palette className="size-5" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner align="end" sideOffset={8} className="isolate z-50">
          <Popover.Popup className="w-72 rounded-xl bg-popover p-3 text-popover-foreground shadow-float ring-1 ring-foreground/10 outline-none">
            <ThemeControls />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
