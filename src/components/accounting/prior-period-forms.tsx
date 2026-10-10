'use client';

import { useRouter } from 'next/navigation';
import { Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FormError, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { ReasonAction } from '@/components/shared/reason-action';
import type { ActionResult } from '@/lib/errors';
import {
  removePriorPeriodAction,
  savePriorPeriodAction,
} from '@/app/(app)/finance/accounting/prior-periods/actions';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';
const AMOUNT = `${INPUT} [&_input]:text-right [&_input]:tabular-nums`;

/** One month's totals, from the invoice book, the supplier bills and the bank. */
export function PriorPeriodForm({ latestMonth }: { latestMonth: string }) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await savePriorPeriodAction(prev, formData);
      if (result.ok) {
        toast.success('Month saved and booked');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <TextField
        label="Month"
        name="month"
        type="month"
        required
        max={latestMonth}
        error={errors.month}
        hint="For the month the books began in, enter only the days before they began."
        className={`${INPUT} @lg:max-w-60`}
      />
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold">Sales — from the invoice book</legend>
        <div className="grid gap-6 @lg:grid-cols-2">
          <TextField
            label="Sales, before VAT"
            name="sales"
            numeric="money"
            placeholder="0.00"
            error={errors.sales}
            className={AMOUNT}
          />
          <TextField
            label="VAT charged on them"
            name="salesVat"
            numeric="money"
            placeholder="0.00"
            error={errors.salesVat}
            hint="0 before VAT registration."
            className={AMOUNT}
          />
        </div>
      </fieldset>
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold">
          Costs — from supplier bills and the bank
        </legend>
        <div className="grid gap-6 @lg:grid-cols-2">
          <TextField
            label="Spare parts bought, before VAT"
            name="partsBought"
            numeric="money"
            placeholder="0.00"
            error={errors.partsBought}
            className={AMOUNT}
          />
          <TextField
            label="Other costs with VAT, before VAT"
            name="costsWithVat"
            numeric="money"
            placeholder="0.00"
            error={errors.costsWithVat}
            hint="Rent, electricity, tools, fuel…"
            className={AMOUNT}
          />
          <TextField
            label="VAT paid on parts and those costs"
            name="purchasesVat"
            numeric="money"
            placeholder="0.00"
            error={errors.purchasesVat}
            hint="Only with a supplier tax invoice."
            className={AMOUNT}
          />
          <TextField
            label="Costs without VAT"
            name="costsWithoutVat"
            numeric="money"
            placeholder="0.00"
            error={errors.costsWithoutVat}
            hint="Government fees, visas, bank charges…"
            className={AMOUNT}
          />
          <TextField
            label="Salaries paid"
            name="salaries"
            numeric="money"
            placeholder="0.00"
            error={errors.salaries}
            className={AMOUNT}
          />
          <TextField
            label="Note"
            name="note"
            error={errors.note}
            hint="Optional — where the figures came from."
            className={INPUT}
          />
        </div>
      </fieldset>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div className="border-t border-border pt-4">
        <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Saving…">
          <Plus />
          Save the month
        </SubmitButton>
      </div>
    </form>
  );
}

export function RemovePriorPeriodButton({ id, label }: { id: string; label: string }) {
  return (
    <ReasonAction
      trigger={
        <Button variant="ghost" size="sm" className="h-11 sm:h-8">
          <Trash2 />
          Remove
        </Button>
      }
      title={`Remove ${label}?`}
      description="Its entry is reversed, so the books lose those income and costs until it is entered again."
      confirmLabel="Remove the month"
      placeholder="e.g. Sales were entered twice"
      successMessage="Month removed"
      tone="destructive"
      onConfirm={(input) => removePriorPeriodAction(id, input)}
    />
  );
}
