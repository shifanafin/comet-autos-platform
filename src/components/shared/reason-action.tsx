'use client';

import { useId, useRef, useState, useTransition, type ReactElement } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/forms/fields';
import type { ActionResult } from '@/lib/errors';

function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A confirmation that asks why — for the undo-style actions (void an
 * invoice, reverse a payment, archive a record) whose reason belongs in the
 * audit trail. One request key per opening, so a double tap records once.
 */
export function ReasonAction({
  trigger,
  title,
  description,
  confirmLabel,
  reasonLabel = 'Reason',
  placeholder,
  successMessage,
  requireReason = true,
  onConfirm,
}: {
  trigger: ReactElement;
  title: string;
  description: string;
  confirmLabel: string;
  reasonLabel?: string;
  placeholder?: string;
  successMessage: string;
  requireReason?: boolean;
  onConfirm: (input: { reason: string; requestKey: string }) => Promise<ActionResult>;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const requestKey = useRef<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setReason('');
      setError(null);
      requestKey.current = newRequestKey();
    }
  }

  function confirm() {
    if (requireReason && reason.trim().length < 3) {
      setError('Say why, in a few words.');
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await onConfirm({ reason: reason.trim(), requestKey: requestKey.current! });
      if (result.ok || result.duplicate) {
        toast.success(successMessage);
        setOpen(false);
        router.refresh();
      } else {
        setError(result.error ?? 'That did not work. Try again.');
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={trigger} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={id} className="text-sm font-medium">
            {reasonLabel}
            {requireReason ? null : (
              <span className="font-normal text-muted-foreground"> (optional)</span>
            )}
          </label>
          <Textarea
            id={id}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={placeholder}
            maxLength={500}
            className="min-h-20"
          />
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Never mind
          </Button>
          <Button variant="destructive" disabled={isPending} onClick={confirm}>
            {isPending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
