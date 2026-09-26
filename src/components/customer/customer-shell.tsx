import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Lock } from 'lucide-react';
import type { OrganizationBranding } from '@/lib/customer-access/access';

/** The shell's graphite bar; customer pages give the phone's browser bar the same colour. */
export const CUSTOMER_BAR_COLOR = '#111118';

/*
 * The frame of every customer page opened from a WhatsApp link: a slim
 * branded bar, a single readable column sized for phones, and the workshop's
 * contact details. No staff navigation, no dashboard.
 */

export function CustomerShell({
  organization,
  label,
  children,
}: {
  organization?: OrganizationBranding;
  label: string;
  children: ReactNode;
}) {
  // No organization means a dead link: nothing names the workshop, so neither do we.
  const name = organization?.name ?? 'Your workshop';
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="bg-sidebar text-sidebar-foreground">
        <div className="mx-auto flex w-full max-w-xl items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-bold text-sidebar-primary-foreground">
              {name.charAt(0)}
            </span>
            <span className="flex flex-col">
              <span className="text-sm leading-tight font-semibold">{name}</span>
              <span className="text-xs leading-tight text-sidebar-foreground/60">{label}</span>
            </span>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-sidebar-foreground/60">
            <Lock className="size-3.5" />
            Secure
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-xl flex-1 px-4 pt-6 pb-10 sm:px-6 sm:pt-10">
        {children}
      </main>
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-xl flex-col gap-1 px-4 py-6 text-xs text-muted-foreground sm:px-6">
          <p className="font-medium text-foreground">{organization?.legalName ?? name}</p>
          {organization?.address ? <p>{organization.address}</p> : null}
          {organization?.phone ? (
            <p>
              Tel{' '}
              <a
                href={`tel:${organization.phone.replace(/\s+/g, '')}`}
                className="underline-offset-4 hover:underline"
              >
                {organization.phone}
              </a>
            </p>
          ) : null}
          {organization?.taxNumber ? <p>TRN {organization.taxNumber}</p> : null}
        </div>
      </footer>
    </div>
  );
}

export function CustomerNotice({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-2xl border border-border bg-card px-6 py-8">
      <span className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}
