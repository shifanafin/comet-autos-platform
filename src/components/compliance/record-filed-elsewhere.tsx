'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { FileCheck2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormError, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import { formatCalendarDate } from '@/lib/format';
import { recordVatReturnFiledElsewhereAction } from '@/app/(app)/finance/vat/actions';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';
const AMOUNT = `${INPUT} [&_input]:text-right [&_input]:tabular-nums`;

/**
 * Records a VAT return filed in EmaraTax before these books began, with the
 * figures as submitted. Only marks it filed — nothing is booked.
 */
export function RecordFiledElsewhereButton({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await recordVatReturnFiledElsewhereAction(prev, formData);
      if (result.ok) {
        toast.success('Return recorded as filed');
        setOpen(false);
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const period = `${formatCalendarDate(from)} – ${formatCalendarDate(to)}`;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" className="h-11 sm:h-9" onClick={() => setOpen(true)}>
        <FileCheck2 />
        It was filed — record it
      </Button>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Record the return for {period}</DialogTitle>
          <DialogDescription>
            Open the submitted return in EmaraTax (VAT → VAT Returns → View) and copy the figures.
            This only marks it filed: those months are before these books, so nothing is booked.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <input type="hidden" name="from" value={from} />
          <input type="hidden" name="to" value={to} />
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id={`filedOn-${to}`}
              label="Filed on"
              name="filedOn"
              type="date"
              required
              error={errors.filedOn}
              className={INPUT}
            />
            <TextField
              id={`ftaReference-${to}`}
              label="FTA reference"
              name="ftaReference"
              error={errors.ftaReference}
              hint="On the submitted return."
              className={INPUT}
            />
            <TextField
              id={`standardSupplies-${to}`}
              label="Box 1 — sales (before VAT)"
              name="standardSupplies"
              numeric="money"
              required
              defaultValue="0.00"
              error={errors.standardSupplies}
              className={AMOUNT}
            />
            <TextField
              id={`outputVat-${to}`}
              label="Box 1 — VAT on sales"
              name="outputVat"
              numeric="money"
              required
              defaultValue="0.00"
              error={errors.outputVat}
              className={AMOUNT}
            />
            <TextField
              id={`standardExpenses-${to}`}
              label="Box 9 — expenses (before VAT)"
              name="standardExpenses"
              numeric="money"
              required
              defaultValue="0.00"
              error={errors.standardExpenses}
              className={AMOUNT}
            />
            <TextField
              id={`inputVat-${to}`}
              label="Box 9 — VAT on expenses"
              name="inputVat"
              numeric="money"
              required
              defaultValue="0.00"
              error={errors.inputVat}
              className={AMOUNT}
            />
            <TextField
              id={`settledOn-${to}`}
              label="VAT paid on (if paid)"
              name="settledOn"
              type="date"
              error={errors.settledOn}
              hint="Empty if it isn't paid yet."
              className={INPUT}
            />
          </div>
          <FormError message={Object.keys(errors).length ? undefined : state.error} />
          <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Saving…">
            Record as filed
          </SubmitButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}
