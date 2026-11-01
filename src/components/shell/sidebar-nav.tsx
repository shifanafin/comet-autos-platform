'use client';

import { useEffect, useState } from 'react';
import { PanelLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NavList } from '@/components/shell/nav-list';
import { BrandMark } from '@/components/shell/brand-mark';
import type { Brand } from '@/lib/brand/brand';
import { setPreferenceCookie, SIDEBAR_COOKIE, TOGGLE_SIDEBAR_EVENT } from '@/lib/theme';

/** The opener in the top bar. The sidebar itself listens: they are apart on the page. */
export function SidebarToggle() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(TOGGLE_SIDEBAR_EVENT))}
      aria-label="Open or close the sidebar"
      title="Open or close the sidebar (Ctrl+B)"
      className="hidden size-10 shrink-0 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 md:flex"
    >
      <PanelLeft className="size-5" />
    </button>
  );
}

export function SidebarNav({
  allowedHrefs,
  brand,
  initialCollapsed = false,
}: {
  allowedHrefs: string[];
  brand: Pick<Brand, 'shortName' | 'initial'>;
  /** As it was left: read on the server, so the page never draws it the other way first. */
  initialCollapsed?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  useEffect(() => {
    function toggle() {
      setCollapsed((prev) => {
        setPreferenceCookie(SIDEBAR_COOKIE, prev ? 'open' : 'collapsed');
        return !prev;
      });
    }
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'b') return;
      // Ctrl+B is "bold" in the letter editor, and belongs to whatever is being typed in.
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return;
      }
      event.preventDefault();
      toggle();
    }
    window.addEventListener(TOGGLE_SIDEBAR_EVENT, toggle);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener(TOGGLE_SIDEBAR_EVENT, toggle);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  return (
    <aside
      className={cn(
        'sticky top-0 hidden h-screen shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex',
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'w-[72px]' : 'w-64',
      )}
    >
      {/* A bloom of the theme's colour behind the brand keeps the rail from reading as a flat slab. */}
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
    </aside>
  );
}
