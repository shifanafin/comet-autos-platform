'use client';

import { useState } from 'react';
import { Save, UserCheck } from 'lucide-react';
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
import type { CustomerOption } from '@/lib/customers/picker';
import {
  checkDuplicatePhoneAction,
  quickCreateCustomerAction,
} from '@/app/(app)/customers/actions';
import { getCustomerOptionAction } from '@/app/(app)/customers/search-action';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

/** What was searched for: digits are a mobile number, anything else a name. */
export function startFrom(query: string) {
  const text = query.trim();
  return /^[+\d\s()-]{5,}$/.test(text) ? { name: '', phone: text } : { name: text, phone: '' };
}

/**
 * A customer not on file yet, added from a document's customer search
 * without leaving it: the name and mobile, and the TRN for a business. If
 * the mobile already belongs to a customer, that customer is offered
 * instead, so nobody is entered twice.
 */
export function NewCustomerDialog({
  query,
  onClose,
  onCreated,
}: {
  /** What was typed in the search, to start the form with. */
  query: string;
  onClose: () => void;
  onCreated: (customer: CustomerOption) => void;
}) {
  const start = startFrom(query);
  const [existing, setExisting] = useState<{ id: string; name: string; phone: string }[]>([]);
  const [state, onSubmit, isPending] = useFormAction<ActionResult<CustomerOption>>(
    async (prev, formData) => {
      const result = await quickCreateCustomerAction(prev, formData);
      if (result.ok && result.data) {
        toast.success(`${result.data.name} added to your customers`);
        onCreated(result.data);
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};

  async function pickExisting(id: string) {
    const customer = await getCustomerOptionAction(id);
    if (customer) onCreated(customer);
    else toast.error('That customer could not be opened — search for them instead.');
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a new customer</DialogTitle>
          <DialogDescription>
            It is saved to your customers and chosen for this document. Add a vehicle later if you
            need one.
          </DialogDescription>
        </DialogHeader>
        {/* Inside the document's form on the page's component tree: its keys and submit stop here. */}
        <form
          onSubmit={(event) => {
            event.stopPropagation();
            onSubmit(event);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex flex-col gap-5"
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id="new-customer-name"
              label="Customer name"
              name="name"
              required
              autoFocus={!start.name}
              defaultValue={start.name}
              error={errors.name}
              className={`${INPUT} sm:col-span-2`}
            />
            <TextField
              id="new-customer-phone"
              label="Mobile"
              name="phone"
              type="tel"
              required
              autoFocus={Boolean(start.name)}
              defaultValue={start.phone}
              error={errors.phone}
              onBlur={async (event) =>
                setExisting(await checkDuplicatePhoneAction(event.target.value))
              }
              className={INPUT}
            />
            <TextField
              id="new-customer-trn"
              label="TRN"
              name="taxNumber"
              inputMode="numeric"
              error={errors.taxNumber}
              hint="For a business customer."
              className={INPUT}
            />
          </div>
          {existing.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
              <p>This mobile is already on file:</p>
              {existing.map((customer) => (
                <Button
                  key={customer.id}
                  type="button"
                  variant="outline"
                  className="h-11 justify-start"
                  onClick={() => pickExisting(customer.id)}
                >
                  <UserCheck />
                  Use {customer.name} · {customer.phone}
                </Button>
              ))}
            </div>
          ) : null}
          <FormError message={state.error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton size="lg" pending={isPending} pendingLabel="Adding…">
              <Save />
              Add customer
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
