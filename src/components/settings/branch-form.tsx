'use client';

import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { FormError, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import type { BranchSettings } from '@/lib/organization/branches';
import { updateBranchAction } from '@/app/(app)/settings/actions';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

/** One branch's name and contact details. The code is shown, not edited. */
export function BranchForm({ branch }: { branch: BranchSettings }) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await updateBranchAction(branch.id, prev, formData);
      if (result.ok) {
        toast.success('Branch saved');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const id = (name: string) => `${name}-${branch.id}`;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <TextField
          id={id('name')}
          label="Branch name"
          name="name"
          required
          defaultValue={branch.name}
          error={errors.name}
          hint={`Code ${branch.code} — used in document numbers, not shown to customers.`}
          className={INPUT}
        />
        <TextField
          id={id('phone')}
          label="Phone"
          name="phone"
          defaultValue={branch.phone ?? ''}
          error={errors.phone}
          className={INPUT}
        />
      </div>
      <TextField
        id={id('address')}
        label="Address"
        name="address"
        defaultValue={branch.address ?? ''}
        error={errors.address}
        className={INPUT}
      />
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} className="h-11" pendingLabel="Saving…">
          <Save />
          Save branch
        </SubmitButton>
      </div>
    </form>
  );
}
