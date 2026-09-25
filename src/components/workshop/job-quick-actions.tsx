'use client';

import type { LucideIcon } from 'lucide-react';
import { Camera, ClipboardCheck, Package, ShieldCheck, Stethoscope, Timer, Wallet } from 'lucide-react';
import type { WorkflowStatus } from '@/lib/workshop/stages';
import { ADD_PHOTO_EVENT } from '@/components/media/job-photos';

interface QuickAction {
  label: string;
  icon: LucideIcon;
  href?: string;
  photo?: boolean;
}

/** The one-tap actions that make sense at each stage. */
function actionsFor(status: WorkflowStatus, base: string, can: { edit: boolean; parts: boolean; pay: boolean }): QuickAction[] {
  const actions: QuickAction[] = [];
  if (can.edit) actions.push({ label: 'Photo', icon: Camera, photo: true });
  if (status === 'ARRIVED' || status === 'INSPECTION') actions.push({ label: 'Inspection', icon: ClipboardCheck, href: `${base}/inspection` });
  if (status === 'DIAGNOSIS') actions.push({ label: 'Diagnosis', icon: Stethoscope, href: `${base}/diagnosis` });
  if (status === 'REPAIR' && can.edit) {
    actions.push({ label: 'Labour', icon: Timer, href: '#labour' });
    if (can.parts) actions.push({ label: 'Part', icon: Package, href: '#parts' });
  }
  if ((status === 'REPAIR' || status === 'QUALITY_CHECK') && can.edit) actions.push({ label: 'Quality check', icon: ShieldCheck, href: '#quality-check' });
  if (status === 'INVOICED' && can.pay) actions.push({ label: 'Payment', icon: Wallet, href: '#payments' });
  return actions;
}

/** The minimal job card has no stages to jump to: a photo, and the payment when one is due. */
function minimalActionsFor(status: WorkflowStatus, can: { edit: boolean; pay: boolean }): QuickAction[] {
  const actions: QuickAction[] = [];
  if (can.edit) actions.push({ label: 'Photo', icon: Camera, photo: true });
  if (status === 'INVOICED' && can.pay) actions.push({ label: 'Payment', icon: Wallet, href: '#next-step' });
  return actions;
}

/**
 * On phones and small tablets, the actions a technician takes most often
 * sit in a bar at the bottom of the screen, above the navigation — within
 * thumb reach wherever they have scrolled to.
 */
export function JobQuickActions({
  jobCardId,
  status,
  canEdit,
  canIssueParts,
  canPay,
  minimal = false,
}: {
  jobCardId: string;
  status: WorkflowStatus;
  canEdit: boolean;
  canIssueParts: boolean;
  canPay: boolean;
  minimal?: boolean;
}) {
  const actions = minimal
    ? minimalActionsFor(status, { edit: canEdit, pay: canPay })
    : actionsFor(status, `/job-cards/${jobCardId}`, { edit: canEdit, parts: canIssueParts, pay: canPay });
  if (actions.length === 0) return null;

  return (
    <>
      <div aria-hidden className="h-20 md:hidden" />
      <nav
        aria-label="Quick actions"
        className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-border bg-background/95 px-3 py-2 backdrop-blur md:hidden"
      >
        <ul className="flex gap-2 overflow-x-auto [scrollbar-width:none]">
          {actions.map((action) => {
            const Icon = action.icon;
            const className =
              'flex h-12 min-w-[4.5rem] flex-1 flex-col items-center justify-center gap-0.5 rounded-lg border border-border bg-card px-2 text-[11px] font-medium active:bg-muted';
            return (
              <li key={action.label} className="flex flex-1">
                {action.photo ? (
                  <button type="button" className={className} onClick={() => window.dispatchEvent(new Event(ADD_PHOTO_EVENT))}>
                    <Icon className="size-5 text-primary" />
                    {action.label}
                  </button>
                ) : (
                  <a href={action.href} className={className}>
                    <Icon className="size-5 text-primary" />
                    {action.label}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
