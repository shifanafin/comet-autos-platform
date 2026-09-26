'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ClipboardList, FileText, Home, Menu, Receipt, type LucideIcon } from 'lucide-react';
import { MobileNav } from '@/components/shell/mobile-nav';
import type { Brand } from '@/lib/brand/brand';
import { cn } from '@/lib/utils';

interface Tab {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Shown only when the user's role includes the page behind it. */
  requires?: string;
}

/*
 * The daily documents, one thumb away. Home carries the three "+ New"
 * buttons, so the tabs are for finding what already exists.
 */
const TABS: Tab[] = [
  { label: 'Home', href: '/', icon: Home },
  { label: 'Job cards', href: '/job-cards', icon: ClipboardList, requires: '/job-cards' },
  { label: 'Quotes', href: '/quotations', icon: FileText, requires: '/quotations' },
  { label: 'Invoices', href: '/finance/invoices', icon: Receipt, requires: '/finance/invoices' },
];

/**
 * Navigation on phones and small tablets: the few places a technician goes
 * all day, fixed within thumb reach at the bottom of the screen, with
 * everything else behind "More". Hidden from tablets in landscape and
 * desktops upward, where the sidebar takes over.
 */
export function BottomNav({
  allowedHrefs,
  brand,
}: {
  allowedHrefs: string[];
  brand: Pick<Brand, 'shortName' | 'initial'>;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const allowed = new Set(allowedHrefs);
  const tabs = TABS.filter((tab) => !tab.requires || allowed.has(tab.requires));

  const itemClass =
    'flex h-full flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium outline-none transition-colors';

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <div className="flex h-16 items-stretch">
          {tabs.map((tab) => {
            const isActive = tab.href === '/' ? pathname === '/' : pathname.startsWith(tab.href);
            const Icon = tab.icon;
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  itemClass,
                  isActive ? 'text-primary' : 'text-muted-foreground active:bg-muted',
                )}
              >
                <Icon className="size-5" />
                {tab.label}
              </Link>
            );
          })}
          <button
            type="button"
            aria-label="Open navigation menu"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className={cn(itemClass, 'text-muted-foreground active:bg-muted')}
          >
            <Menu className="size-5" />
            More
          </button>
        </div>
      </nav>
      <MobileNav allowedHrefs={allowedHrefs} brand={brand} open={open} onOpenChange={setOpen} />
    </>
  );
}
