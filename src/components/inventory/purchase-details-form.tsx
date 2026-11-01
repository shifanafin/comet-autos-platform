'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormError, TextareaField, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { formatCalendarDate } from '@/lib/format';
import type { ActionResult } from '@/lib/errors';
import { updatePurchaseDetailsAction } from '@/app/(app)/inventory/actions';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

/**
 * Corrects a received purchase's details — the supplier's invoice number, its
 * date, the due date and the notes. The lines and amounts stay as received.
 */
export function EditPurchaseDetailsButton({
  purchase,
  today,
}: {
  purchase: {
    id: string;
    purchaseNumber: string;
    supplierInvoiceNumber: string | null;
    /** "YYYY-MM-DD". */
    supplierInvoiceDate: string | null;
    dueDate: string | null;
    notes: string | null;
    /** The day the goods were booked in, "YYYY-MM-DD"; null if there was more than one. */
    receivedOn: string | null;
  };
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await updatePurchaseDetailsAction(purchase.id, prev, formData);
      if (result.ok) {
        toast.success('Purchase details updated');
        router.refresh();
        setOpen(false);
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const [date, setDate] = useState(purchase.supplierInvoiceDate ?? '');
  // The books say another day than the purchase date: offer to bring them to it.
  const offerMove = Boolean(date && purchase.receivedOn && date !== purchase.receivedOn);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="lg" onClick={() => setOpen(true)}>
        <Pencil />
        Edit details
      </Button>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{purchase.purchaseNumber} — details</DialogTitle>
          <DialogDescription>
            The supplier&apos;s invoice number, its date, the due date and notes. The parts and
            amounts stay as received.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="Supplier invoice no."
              name="supplierInvoiceNumber"
              defaultValue={purchase.supplierInvoiceNumber ?? ''}
              error={errors.supplierInvoiceNumber}
              className={INPUT}
            />
            <TextField
              label="Purchase date"
              name="supplierInvoiceDate"
              type="date"
              max={today}
              value={date}
              onChange={(event) => setDate(event.target.value)}
              error={errors.supplierInvoiceDate}
              hint="The date on the supplier's bill."
              className={INPUT}
            />
            <TextField
              label="Due date"
              name="dueDate"
              type="date"
              defaultValue={purchase.dueDate ?? ''}
              error={errors.dueDate}
              hint="Optional: when the supplier expects to be paid."
              className={INPUT}
            />
          </div>
          {offerMove ? (
            <label className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3 text-sm">
              <input
                type="checkbox"
                name="moveBooks"
                defaultChecked
                className="mt-0.5 size-4 accent-primary"
              />
              <span>
                <span className="font-medium">
                  {`Move the stock and payment to ${formatCalendarDate(date)}`}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {`They are booked on ${formatCalendarDate(purchase.receivedOn!)}. Untick if the goods really came that day. A payment made on any other day stays as it is.`}
                </span>
              </span>
            </label>
          ) : null}
          <FormError message={errors.moveBooks} />
          <TextareaField
            label="Notes"
            name="notes"
            defaultValue={purchase.notes ?? ''}
            error={errors.notes}
            className="[&_textarea]:min-h-16"
          />
          <FormError message={Object.keys(errors).length ? undefined : state.error} />
          <div className="border-t border-border pt-4">
            <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Saving…">
              <Save />
              Save details
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
