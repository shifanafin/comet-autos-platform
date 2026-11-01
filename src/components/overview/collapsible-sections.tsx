'use client';

import { createContext, useContext, useState, type ReactNode } from 'react';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Section } from '@/components/layout/primitives';
import { DASHBOARD_CLOSED_COOKIE, setPreferenceCookie } from '@/lib/theme';
import { cn } from '@/lib/utils';

/*
 * Dashboard sections that fold, one at a time or all together, so each person
 * keeps what they look at open. Left as they were on the next visit (a cookie,
 * so the server draws them that way and nothing jumps).
 */

interface Sections {
  closed: Set<string>;
  toggle: (id: string) => void;
  setAll: (open: boolean) => void;
}

const SectionsContext = createContext<Sections | null>(null);

export function CollapsibleSections({
  ids,
  initialClosed,
  children,
}: {
  /** Every section that can fold. */
  ids: string[];
  initialClosed: string[];
  children: ReactNode;
}) {
  const [closed, setClosed] = useState(() => new Set(initialClosed));
  function save(next: Set<string>) {
    setClosed(next);
    setPreferenceCookie(DASHBOARD_CLOSED_COOKIE, [...next].join(','));
  }
  return (
    <SectionsContext.Provider
      value={{
        closed,
        toggle: (id) => {
          const next = new Set(closed);
          if (!next.delete(id)) next.add(id);
          save(next);
        },
        setAll: (open) => save(new Set(open ? [] : ids)),
      }}
    >
      {children}
    </SectionsContext.Provider>
  );
}

/** Open or close every section at once. */
export function SectionsBulkToggle() {
  const sections = useContext(SectionsContext);
  if (!sections) return null;
  return (
    <div className="flex justify-end gap-1">
      <Button type="button" variant="ghost" size="sm" onClick={() => sections.setAll(true)}>
        <ChevronsUpDown />
        Expand all
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => sections.setAll(false)}>
        <ChevronsDownUp />
        Collapse all
      </Button>
    </div>
  );
}

export function CollapsibleSection({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const sections = useContext(SectionsContext);
  const open = !sections?.closed.has(id);
  return (
    <Section
      title={title}
      description={open ? description : undefined}
      className={open ? undefined : 'gap-0'}
      action={
        <span className="flex items-center gap-2">
          {open ? action : null}
          <button
            type="button"
            onClick={() => sections?.toggle(id)}
            aria-expanded={open}
            aria-label={`${open ? 'Close' : 'Open'} ${title}`}
            title={open ? 'Close' : 'Open'}
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <ChevronRight
              className={cn(
                'size-4 transition-transform duration-200 motion-reduce:transition-none',
                open && 'rotate-90',
              )}
            />
          </button>
        </span>
      }
    >
      {/* Stays in the page while closed, so opening it again needs no reload. */}
      <div
        inert={!open}
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
      >
        <div className={cn('min-w-0', open ? 'overflow-visible' : 'overflow-hidden')}>
          {children}
        </div>
      </div>
    </Section>
  );
}
