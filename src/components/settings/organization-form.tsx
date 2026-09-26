'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Info, Save, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import {
  Field,
  FormError,
  NativeSelect,
  TextField,
  TextareaField,
} from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import type { OrganizationSettings } from '@/lib/organization/settings';
import { saveOrganizationSettingsAction } from '@/app/(app)/settings/actions';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

/**
 * The workshop's own details. Grouped so the parts that appear on customer
 * documents are obviously separate from the parts that decide VAT.
 */
export function OrganizationForm({ settings }: { settings: OrganizationSettings }) {
  const router = useRouter();
  const [registered, setRegistered] = useState(settings.isVatRegistered);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await saveOrganizationSettingsAction(prev, formData);
      if (result.ok) {
        toast.success('Workshop details saved');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-6">
        <legend className="sr-only">Business details</legend>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          These appear at the top of every quotation, invoice and receipt the customer sees.
        </p>
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField
            label="Workshop name"
            name="name"
            required
            defaultValue={settings.name}
            error={errors.name}
            hint="The name customers know you by."
            className={INPUT}
          />
          <TextField
            label="Legal name"
            name="legalName"
            defaultValue={settings.legalName ?? ''}
            error={errors.legalName}
            hint="As registered, if different."
            className={INPUT}
          />
        </div>
        <TextareaField
          label="Address"
          name="address"
          defaultValue={settings.address ?? ''}
          error={errors.address}
          placeholder="Street, area, city"
          className="[&_textarea]:min-h-20 [&_textarea]:text-base md:[&_textarea]:text-sm"
        />
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField
            label="Phone"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            defaultValue={settings.phone ?? ''}
            error={errors.phone}
            className={INPUT}
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            defaultValue={settings.email ?? ''}
            error={errors.email}
            className={INPUT}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-6 border-t border-border pt-8">
        <legend className="sr-only">VAT</legend>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field
            label="Does the workshop charge VAT?"
            htmlFor="isVatRegistered"
            required
            error={errors.isVatRegistered}
          >
            <NativeSelect
              id="isVatRegistered"
              name="isVatRegistered"
              defaultValue={settings.isVatRegistered ? 'true' : 'false'}
              onChange={(event) => setRegistered(event.target.value === 'true')}
              className="h-11 text-base md:text-sm"
            >
              <option value="true">Yes — VAT-registered</option>
              <option value="false">No — not VAT-registered</option>
            </NativeSelect>
          </Field>
          <TextField
            label="VAT rate"
            name="vatRate"
            inputMode="decimal"
            required
            defaultValue={settings.vatRate}
            error={errors.vatRate}
            hint="Percentage, e.g. 5."
            className={`${INPUT} [&_input]:text-right [&_input]:tabular-nums`}
          />
        </div>
        <TextField
          label="TRN (tax registration number)"
          name="taxNumber"
          inputMode="numeric"
          defaultValue={settings.taxNumber ?? ''}
          error={errors.taxNumber}
          hint="15 digits. Printed on every tax invoice."
          className={`${INPUT} [&_input]:font-mono`}
        />

        {registered && !settings.taxNumber ? (
          <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            No TRN is recorded, so tax invoices are printed without one. Add it above.
          </p>
        ) : null}

        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" />
          {registered
            ? 'The rate is what new quotation, invoice, purchase and expense lines start at. Anything already issued keeps the rate it was priced at.'
            : 'While not registered, new lines default to 0%. Documents already issued keep the VAT they were priced with.'}
        </p>
      </fieldset>

      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div className="border-t border-border pt-6">
        <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Saving…">
          <Save />
          Save details
        </SubmitButton>
      </div>
    </form>
  );
}
