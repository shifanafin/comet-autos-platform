'use client';

import { useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Handshake } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { ReasonAction } from '@/components/shared/reason-action';
import type { ActionResult } from '@/lib/errors';
import type { BusinessPurchaseEntry } from '@/lib/finance/business-purchase';
import {
  recordBusinessPurchaseAction,
  updateBusinessPurchaseAction,
  voidBusinessPurchaseAction,
} from '@/app/(app)/finance/money/actions';

/**
 * A partner's payment to buy the business — to its previous owner, or a fee
 * of transferring it. Kept outside the company's books
 * (lib/finance/business-purchase.ts). Given an entry, it opens filled in and
 * saves a correction of it.
 */
export function BusinessPurchaseForm({
  partners,
  today,
  entry,
}: {
  partners: { id: string; name: string }[];
  today: string;
  entry?: BusinessPurchaseEntry;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      if (entry) {
        const result = await updateBusinessPurchaseAction(entry.id, prev, formData);
        if (result.ok) {
          toast.success('Payment corrected');
          router.push('/finance/money/owner');
        }
        return result;
      }
      const result = await recordBusinessPurchaseAction(prev, formData);
      if (result.ok) {
        toast.success('Payment recorded');
        formRef.current?.reset();
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};

  return (
    <form ref={formRef} onSubmit={onSubmit} className="@container flex flex-col gap-6">
      <div className="grid gap-6 @xl:grid-cols-2">
        <Field label="Paid by" htmlFor="purchase-partner" required error={errors.partnerId}>
          <NativeSelect
            id="purchase-partner"
            name="partnerId"
            defaultValue={entry ? entry.partnerId : partners.length === 1 ? partners[0].id : ''}
            className="h-11"
            required
          >
            <option value="" disabled>
              Choose the partner…
            </option>
            {partners.map((partner) => (
              <option key={partner.id} value={partner.id}>
                {partner.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <TextField
          label="Amount (AED)"
          name="amount"
          id="purchase-amount"
          numeric="money"
          required
          defaultValue={entry?.amount}
          error={errors.amount}
          className="[&_input]:h-11"
        />
        <TextField
          label="Paid to"
          name="paidTo"
          id="purchase-paid-to"
          required
          defaultValue={entry?.paidTo}
          error={errors.paidTo}
          hint="The previous owner, Tasheel, a typing centre…"
          className="[&_input]:h-11"
        />
        <TextField
          label="Date"
          name="paidOn"
          id="purchase-date"
          type="date"
          required
          defaultValue={entry?.paidOn ?? today}
          max={today}
          error={errors.paidOn}
          className="[&_input]:h-11"
        />
        <TextField
          label="What it was for"
          name="description"
          id="purchase-description"
          required
          defaultValue={entry?.description}
          error={errors.description}
          hint="e.g. Payout for the company, ownership transfer fee."
          className="[&_input]:h-11"
        />
        <TextField
          label="Reference"
          name="reference"
          id="purchase-reference"
          defaultValue={entry?.reference}
          error={errors.reference}
          hint="Optional: cheque, transfer or receipt number."
          className="[&_input]:h-11"
        />
        <TextField
          label="Notes"
          name="notes"
          id="purchase-notes"
          defaultValue={entry?.notes}
          error={errors.notes}
          hint="Optional: e.g. which line of the investments sheet."
          className="@xl:col-span-2 [&_input]:h-11"
        />
      </div>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} className="h-11" pendingLabel="Saving…">
          <Handshake />
          {entry ? 'Save changes' : 'Record payment'}
        </SubmitButton>
      </div>
    </form>
  );
}

/** Withdraws a payment entered by mistake. */
export function VoidBusinessPurchaseButton({ id, label }: { id: string; label: string }) {
  return (
    <ReasonAction
      trigger={
        <Button variant="ghost" size="sm">
          <Ban />
          Void
        </Button>
      }
      title={`Void “${label}”?`}
      description="It stays on record, marked void, and no longer counts in the partner's investment."
      placeholder="e.g. Entered twice."
      confirmLabel="Void"
      successMessage="Payment voided"
      onConfirm={(input) => voidBusinessPurchaseAction(id, input)}
    />
  );
}
