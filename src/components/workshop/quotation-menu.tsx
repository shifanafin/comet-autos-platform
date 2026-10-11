'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Copy,
  Download,
  ExternalLink,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  UserRoundPen,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CustomerPicker, type PickedParty } from '@/components/workshop/customer-picker';
import { downloadUrl } from '@/components/documents/share-menu';
import type { ActionResult } from '@/lib/errors';
import type { CustomerOption } from '@/lib/customers/picker';
import {
  changeQuotationPartyAction,
  deleteDraftQuotationAction,
  duplicateQuotationAction,
  reviseQuotationAction,
} from '@/app/(app)/quotations/actions';

/*
 * Edit, copy, re-address and delete a quotation — from its own page and from
 * the ⋯ menu on the list. Which of them apply follows the document's rules:
 *
 *   draft             edit on the page itself; delete if it never left the
 *                     workshop; change customer/vehicle likewise
 *   sent / rejected   Edit makes the next version as a draft (the sent one,
 *                     and the customer's answer, are kept as they were). A
 *                     sent version still waiting is either replaced (its
 *                     link stops working — a correction) or kept open as an
 *                     option the customer may still choose
 *   approved          Change makes the next version, to add, remove or
 *                     change work before it is invoiced; the customer
 *                     approves that version. Duplicate starts a new one.
 *
 * Every rule is checked again on the server.
 */

/** 'keepOpen' is no menu item: it lets Edit keep the version open as an option. */
export type QuotationAction = 'edit' | 'revise' | 'keepOpen' | 'duplicate' | 'delete' | 'pdf';

function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const CONFIRM = {
  revise: {
    title: 'Edit this quotation?',
    description:
      'Editing makes the next version as a draft. This version and the customer’s answer to it are kept, and its customer link stops working until you send the new one.',
    confirm: 'Edit as new version',
    tone: 'default' as const,
  },
  reviseApproved: {
    title: 'Change the approved quotation?',
    description:
      'A new version is made with the same lines — add, remove or change anything on it. The customer then approves the new version: send it on WhatsApp, or record their OK if they agreed in person or by phone. Until then the job is back at the quotation step and can’t be invoiced. The approved version stays on record exactly as it was.',
    confirm: 'Make the new version',
    tone: 'default' as const,
  },
  duplicate: {
    title: 'Copy into a new quotation?',
    description:
      'A new draft is made with the same customer, vehicle, lines and discounts, under a new number. This quotation is not changed.',
    confirm: 'Make a copy',
    tone: 'default' as const,
  },
  delete: {
    title: 'Delete this draft?',
    description: 'It was never sent, so nobody else has seen it. It is removed with its lines.',
    confirm: 'Delete draft',
    tone: 'destructive' as const,
  },
};

type Confirmable = keyof typeof CONFIRM;

/**
 * One confirmation dialog, driven by which action is waiting on it. Editing a
 * version still waiting for the customer asks what becomes of it.
 */
function useQuotationConfirm(estimateId: string, canKeepOpen = false) {
  const router = useRouter();
  const [open, setOpen] = useState<Confirmable | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [requestKey, setRequestKey] = useState('');

  function ask(action: Confirmable) {
    setError(null);
    setRequestKey(newRequestKey());
    setOpen(action);
  }

  function run(action: Confirmable, keepOpen = false) {
    setError(null);
    startTransition(async () => {
      // Each of these redirects when it succeeds, so only a failure returns.
      const result: ActionResult | undefined =
        action === 'revise' || action === 'reviseApproved'
          ? await reviseQuotationAction(estimateId, keepOpen)
          : action === 'duplicate'
            ? await duplicateQuotationAction(estimateId, requestKey)
            : await deleteDraftQuotationAction(estimateId);
      if (result && !result.ok) {
        setError(result.error ?? 'That did not work. Try again.');
        return;
      }
      toast.success(
        action === 'delete'
          ? 'Draft deleted'
          : action === 'duplicate'
            ? 'Copy created'
            : 'New version ready to edit',
      );
      setOpen(null);
      router.refresh();
    });
  }

  const copy = open ? CONFIRM[open] : null;
  const choose = open === 'revise' && canKeepOpen;
  const dialog = (
    <Dialog open={open !== null} onOpenChange={(next) => (next ? null : setOpen(null))}>
      <DialogContent>
        {copy ? (
          <>
            <DialogHeader>
              <DialogTitle>{choose ? 'Make a new version?' : copy.title}</DialogTitle>
              <DialogDescription>
                {choose
                  ? 'A new draft is made from this version. What should happen to this one?'
                  : copy.description}
              </DialogDescription>
            </DialogHeader>
            {choose ? (
              <ul className="flex flex-col gap-2 text-sm">
                <li className="rounded-lg border border-border px-4 py-3">
                  <span className="font-medium">Replace it</span>
                  <span className="block text-muted-foreground">
                    For a correction. Its customer link stops working; the customer approves the new
                    version.
                  </span>
                </li>
                <li className="rounded-lg border border-border px-4 py-3">
                  <span className="font-medium">Keep it open as an option</span>
                  <span className="block text-muted-foreground">
                    For a choice (genuine or aftermarket parts, say). Both stay open: the customer
                    approves either, on its own link, or you record their choice. Approving one
                    closes the other.
                  </span>
                </li>
              </ul>
            ) : null}
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(null)}>
                Never mind
              </Button>
              {choose ? (
                <>
                  <Button variant="outline" disabled={isPending} onClick={() => run('revise')}>
                    Replace it
                  </Button>
                  <Button disabled={isPending} onClick={() => run('revise', true)}>
                    {isPending ? <Loader2 className="animate-spin" /> : null}
                    {isPending ? 'Working…' : 'Keep it open'}
                  </Button>
                </>
              ) : (
                <Button variant={copy.tone} disabled={isPending} onClick={() => open && run(open)}>
                  {isPending ? <Loader2 className="animate-spin" /> : null}
                  {isPending ? 'Working…' : copy.confirm}
                </Button>
              )}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
  return { ask, dialog };
}

/** Header buttons on the quotation page: Edit (as a new version) and Duplicate. */
export function QuotationHeaderActions({
  estimateId,
  canRevise,
  canDuplicate,
  approved = false,
  canKeepOpen = false,
}: {
  estimateId: string;
  canRevise: boolean;
  canDuplicate: boolean;
  /** Revising an approved quotation: said plainly, since the customer must approve again. */
  approved?: boolean;
  /** Still waiting for the customer: the new version may leave this one open. */
  canKeepOpen?: boolean;
}) {
  const { ask, dialog } = useQuotationConfirm(estimateId, canKeepOpen);
  if (!canRevise && !canDuplicate) return null;
  return (
    <>
      {canRevise ? (
        <Button size="lg" onClick={() => ask(approved ? 'reviseApproved' : 'revise')}>
          <Pencil />
          {approved ? 'Change' : 'Edit'}
        </Button>
      ) : null}
      {canDuplicate ? (
        <Button variant="outline" size="lg" onClick={() => ask('duplicate')}>
          <Copy />
          Duplicate
        </Button>
      ) : null}
      {dialog}
    </>
  );
}

/** The ⋯ menu on a row of the quotation list. */
export function QuotationRowMenu({
  estimateId,
  number,
  actions,
}: {
  estimateId: string;
  number: string;
  actions: QuotationAction[];
}) {
  const has = (action: QuotationAction) => actions.includes(action);
  const { ask, dialog } = useQuotationConfirm(estimateId, has('keepOpen'));
  const href = `/quotations/${estimateId}`;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Actions for ${number}`}
              className="relative z-10 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            />
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem render={<Link href={href} />} className="gap-2.5 py-2">
            <ExternalLink />
            Open
          </DropdownMenuItem>
          {has('edit') ? (
            <DropdownMenuItem render={<Link href={href} />} className="gap-2.5 py-2">
              <Pencil />
              Edit draft
            </DropdownMenuItem>
          ) : null}
          {has('revise') ? (
            <DropdownMenuItem onClick={() => ask('revise')} className="gap-2.5 py-2">
              <Pencil />
              Edit (new version)
            </DropdownMenuItem>
          ) : null}
          {has('duplicate') ? (
            <DropdownMenuItem onClick={() => ask('duplicate')} className="gap-2.5 py-2">
              <Copy />
              Duplicate
            </DropdownMenuItem>
          ) : null}
          {has('pdf') ? (
            <DropdownMenuItem
              render={<a href={downloadUrl(`/documents/quotation/${estimateId}`)} />}
              className="gap-2.5 py-2"
            >
              <Download />
              Download PDF
            </DropdownMenuItem>
          ) : null}
          {has('delete') ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => ask('delete')}
                className="gap-2.5 py-2"
              >
                <Trash2 />
                Delete draft
              </DropdownMenuItem>
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  );
}

/** Re-addresses an unsent first draft: pick the customer, then the vehicle. */
export function ChangeQuotationPartyButton({
  estimateId,
  current,
  vehicleId,
}: {
  estimateId: string;
  current: CustomerOption | null;
  vehicleId: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<PickedParty | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function start() {
    setError(null);
    setPicked(current ? { customer: current, vehicleId: vehicleId ?? '', jobCardId: '' } : null);
    setOpen(true);
  }

  function save() {
    if (!picked) return;
    setError(null);
    startTransition(async () => {
      const result = await changeQuotationPartyAction(estimateId, {
        customerId: picked.customer.id,
        vehicleId: picked.vehicleId,
      });
      if (!result.ok) {
        setError(result.error ?? 'Could not change the quotation.');
        return;
      }
      toast.success('Quotation updated');
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="lg" className="w-full sm:w-auto" onClick={start}>
        <UserRoundPen />
        Change customer or vehicle
      </Button>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Who is this quotation for?</DialogTitle>
          <DialogDescription>
            The lines and prices stay as they are. Only an unsent draft can change hands.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto">
          <CustomerPicker value={picked} onChange={setPicked} allowJobCard={false} autoFocus />
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Never mind
          </Button>
          <Button disabled={!picked || isPending} onClick={save}>
            {isPending ? <Loader2 className="animate-spin" /> : null}
            {isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
