'use client';

import { Dialog as DialogPrimitive } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { NavList } from '@/components/shell/nav-list';
import { BrandMark } from '@/components/shell/brand-mark';
import type { Brand } from '@/lib/brand/brand';

/**
 * The full navigation on a phone or small tablet, as a drawer. It is opened
 * from "More" in the bottom bar — the one place mobile navigation lives, so
 * there is never a second menu button competing with it.
 */
export function MobileNav({
  allowedHrefs,
  brand,
  open,
  onOpenChange,
}: {
  allowedHrefs: string[];
  brand: Pick<Brand, 'shortName' | 'initial'>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-black/30 duration-150 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 md:hidden" />
        <DialogPrimitive.Popup className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-sidebar text-sidebar-foreground outline-none duration-150 data-open:animate-in data-open:slide-in-from-left data-closed:animate-out data-closed:slide-out-to-left md:hidden">
          <DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
          <div className="flex h-16 shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-6">
            <BrandMark brand={brand} />
            <DialogPrimitive.Close
              aria-label="Close navigation menu"
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-3 focus-visible:ring-sidebar-ring/50"
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </div>
          <NavList allowedHrefs={allowedHrefs} onNavigate={() => onOpenChange(false)} />
          <div className="shrink-0 pb-[env(safe-area-inset-bottom)]" aria-hidden />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
