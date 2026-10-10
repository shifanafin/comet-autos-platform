'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { activeNavHref, NAV_GROUPS, type NavGroup, type NavItem } from '@/lib/nav';

/*
 * The sidebar's links, in folding sections (Workshop, Customers & Sales,
 * Suppliers & Bills… — see NAV_GROUPS). A section's heading opens and closes
 * it; a group given a `parent` would fold inside that section as a
 * sub-section (none today).
 *
 * Only what the user may see is listed — the server decides that from their
 * permissions (`allowedHrefs`); a section with nothing allowed in it is not
 * shown at all. Open and closed are remembered in this browser. Until a
 * section has been opened or closed by hand, the one holding the current page
 * is open and the rest are closed.
 *
 * The narrow, icons-only sidebar shows every allowed link as before: there is
 * no heading there to open a section with.
 */

const OPEN_STORAGE_KEY = 'garage:nav-open';

interface Section {
  key: string;
  /** Null: the links before the first heading (Dashboard). */
  label: string | null;
  /** One group for a plain section; several, each with its heading, for Finance. */
  groups: NavGroup[];
  nested: boolean;
}

/** NAV_GROUPS as sidebar sections: groups that share a parent become one section. */
function sectionsOf(groups: NavGroup[]): Section[] {
  const sections: Section[] = [];
  for (const group of groups) {
    if (group.parent) {
      const existing = sections.find((section) => section.key === group.parent);
      if (existing) existing.groups.push(group);
      else sections.push({ key: group.parent, label: group.parent, groups: [group], nested: true });
    } else {
      sections.push({
        key: group.label ?? 'top',
        label: group.label,
        groups: [group],
        nested: false,
      });
    }
  }
  return sections;
}

export function NavList({
  allowedHrefs,
  collapsed = false,
  onNavigate,
}: {
  /** Items the signed-in user may see (decided on the server from their permissions). */
  allowedHrefs: string[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const allowed = new Set(allowedHrefs);
  // One item is current: the most specific one matching the page.
  const active = activeNavHref(pathname, searchParams, allowedHrefs);
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => allowed.has(item.href)),
  })).filter((group) => group.items.length > 0);
  const sections = sectionsOf(groups);

  // What the user opened or closed by hand, by section key ("Finance",
  // "Finance/VAT"). Read after the first render, as the sidebar's own
  // narrow/wide choice is, so the server and the browser draw the same thing.
  const [chosen, setChosen] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const timeout = setTimeout(() => {
      try {
        const saved = JSON.parse(window.localStorage.getItem(OPEN_STORAGE_KEY) ?? '{}');
        if (saved && typeof saved === 'object') setChosen(saved as Record<string, boolean>);
      } catch {
        // Private browsing / storage disabled — the defaults stand.
      }
    }, 0);
    return () => clearTimeout(timeout);
  }, []);

  const holdsActive = (items: NavItem[]) => items.some((item) => item.href === active);
  const isOpen = (key: string, items: NavItem[]) => chosen[key] ?? holdsActive(items);
  function toggle(key: string, items: NavItem[]) {
    setChosen((current) => {
      const next = { ...current, [key]: !(current[key] ?? holdsActive(items)) };
      try {
        window.localStorage.setItem(OPEN_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Per-viewer convenience only — fine if it doesn't persist.
      }
      return next;
    });
  }

  const link = (item: NavItem, indent = false) => {
    const isActive = item.href === active;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        title={collapsed ? item.label : undefined}
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'group/nav relative flex h-10 items-center gap-3 rounded-lg px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          'transition-[background-color,color,transform] duration-150 ease-out motion-reduce:transition-none',
          collapsed && 'justify-center px-0',
          indent && !collapsed && 'pl-5',
          item.soon && !isActive && 'text-sidebar-foreground/45',
          isActive
            ? 'bg-gradient-to-r from-sidebar-primary/30 to-sidebar-primary/10 text-sidebar-foreground ring-1 ring-sidebar-primary/30 ring-inset'
            : 'text-sidebar-foreground/75 hover:translate-x-0.5 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground',
        )}
      >
        <Icon
          className={cn(
            'size-[18px] shrink-0 transition-colors',
            isActive
              ? 'text-violet-400'
              : 'text-sidebar-foreground/55 group-hover/nav:text-sidebar-foreground/90',
          )}
        />
        {!collapsed ? <span className="truncate">{item.label}</span> : null}
        {!collapsed && item.soon ? (
          <span className="ml-auto rounded-full bg-sidebar-accent px-1.5 py-0.5 text-[10px] font-medium text-sidebar-foreground/50">
            Soon
          </span>
        ) : null}
      </Link>
    );
  };

  /** A heading that opens and closes what is under it. */
  const heading = (key: string, label: string, items: NavItem[], level: 'section' | 'sub') => {
    const open = isOpen(key, items);
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
      <button
        type="button"
        onClick={() => toggle(key, items)}
        aria-expanded={open}
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md text-left outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring',
          level === 'section'
            ? 'px-3 py-1.5 text-[11px] font-semibold tracking-wider text-sidebar-foreground/55 uppercase'
            : 'py-1 pr-3 pl-5 text-xs font-medium text-sidebar-foreground/55',
        )}
      >
        <span className="flex-1 truncate">{label}</span>
        {holdsActive(items) && !open ? (
          <span className="size-1.5 rounded-full bg-violet-400" aria-label="Current page is here" />
        ) : null}
        <Chevron className="size-3.5 shrink-0" />
      </button>
    );
  };

  // Narrow sidebar: every allowed link, a divider between sections.
  if (collapsed) {
    return (
      <nav className="scrollbar-none relative flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-5">
        {sections.map((section, index) => (
          <div key={section.key} className="flex flex-col gap-1">
            {index > 0 ? (
              <span className="mx-auto mb-2 h-px w-6 bg-sidebar-border" aria-hidden />
            ) : null}
            {section.groups.flatMap((group) => group.items).map((item) => link(item))}
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav className="scrollbar-none relative flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-5">
      {sections.map((section) => {
        const items = section.groups.flatMap((group) => group.items);
        if (section.label === null) {
          return (
            <div key={section.key} className="flex flex-col gap-1 pb-2">
              {items.map((item) => link(item))}
            </div>
          );
        }
        const open = isOpen(section.key, items);
        return (
          <div key={section.key} className="flex flex-col gap-1">
            {heading(section.key, section.label, items, 'section')}
            {open ? (
              section.nested ? (
                <div className="flex flex-col gap-1">
                  {section.groups.map((group) => {
                    // A sub-section of one link needs no heading of its own.
                    if (group.items.length === 1) return link(group.items[0]);
                    const key = `${section.key}/${group.label}`;
                    return (
                      <div key={key} className="flex flex-col gap-1">
                        {heading(key, group.label ?? '', group.items, 'sub')}
                        {isOpen(key, group.items)
                          ? group.items.map((item) => link(item, true))
                          : null}
                      </div>
                    );
                  })}
                </div>
              ) : (
                items.map((item) => link(item))
              )
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
