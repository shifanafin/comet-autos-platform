'use client';

import { useEffect, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NavList } from '@/components/shell/nav-list';
import { BrandMark } from '@/components/shell/brand-mark';
import type { Brand } from '@/lib/brand/brand';

const COLLAPSE_STORAGE_KEY = 'comet:sidebar-collapsed';

export function SidebarNav({
  allowedHrefs,
  brand,
}: {
  allowedHrefs: string[];
  brand: Pick<Brand, 'shortName' | 'initial'>;
}) {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    // Deferred a tick so this doesn't read as a synchronous setState-in-effect
    // (which would cascade an extra render) — it's a one-time hydration of a
    // per-viewer preference, not something worth optimizing further.
    const timeout = setTimeout(() => {
      try {
        setCollapsed(window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === '1');
      } catch {
        // Private browsing / storage disabled — default to expanded.
      }
    }, 0);
    return () => clearTimeout(timeout);
  }, []);

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Per-viewer convenience only — fine if it doesn't persist.
      }
      return next;
    });
  }

  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex',
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'w-[72px]' : 'w-64',
      )}
    >
      {/* A violet bloom behind the brand keeps the rail from reading as a flat slab. */}
      <span
        aria-hidden
        className="pointer-events-none absolute -top-28 left-1/2 size-64 -translate-x-1/2 rounded-full bg-sidebar-primary/25 blur-3xl"
      />
      <div
        className={cn(
          'relative flex h-16 shrink-0 items-center border-b border-sidebar-border',
          collapsed ? 'justify-center' : 'px-5',
        )}
      >
        <BrandMark brand={brand} collapsed={collapsed} />
      </div>

      <NavList allowedHrefs={allowedHrefs} collapsed={collapsed} />

      <div
        className={cn(
          'relative shrink-0 border-t border-sidebar-border py-3',
          collapsed ? 'px-3' : 'px-4',
        )}
      >
        <button
          type="button"
          onClick={toggle}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'flex h-9 w-full items-center gap-3 rounded-lg px-3 text-sm text-sidebar-foreground/55 transition-colors hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
            collapsed && 'justify-center px-0',
          )}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-[18px]" />
          ) : (
            <PanelLeftClose className="size-[18px]" />
          )}
          {!collapsed ? 'Collapse' : null}
        </button>
      </div>
    </aside>
  );
}
