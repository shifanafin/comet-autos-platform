'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Pencil, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { FormError, TextField, TextareaField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import { updateJobCardDetailsAction } from '@/app/(app)/job-cards/[id]/actions';

/**
 * The customer's request and the mileage, as written at check-in — with an
 * Edit button to correct them while the job card is open.
 */
export function JobDetailsEditor({
  jobCardId,
  complaint,
  mileage,
  canEdit,
  children,
}: {
  jobCardId: string;
  complaint: string | null;
  mileage: number | null;
  canEdit: boolean;
  /** The read-only view, rendered by the page. */
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await updateJobCardDetailsAction(jobCardId, prev, formData);
      if (result.ok) {
        toast.success('Job card updated');
        setEditing(false);
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};

  if (!editing) {
    return (
      <div className="flex flex-col gap-4">
        {children}
        {canEdit ? (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            onClick={() => setEditing(true)}
          >
            <Pencil />
            Edit
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <TextareaField
        label="What the customer asked for"
        name="complaint"
        required
        defaultValue={complaint ?? ''}
        error={errors.complaint}
        className="[&_textarea]:min-h-24 [&_textarea]:text-base md:[&_textarea]:text-sm"
      />
      <TextField
        label="Mileage (km)"
        name="mileage"
        inputMode="numeric"
        defaultValue={mileage !== null ? String(mileage) : ''}
        error={errors.mileage}
        hint="Leave blank if it wasn't read."
        className="sm:max-w-xs [&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm"
      />
      <FormError message={state.error} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={isPending} pendingLabel="Saving…">
          <Save />
          Save
        </SubmitButton>
        <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
