'use client';

import { useRouter } from 'next/navigation';
import { CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { FormError, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import { changeEntryDateAction } from '@/app/(app)/finance/accounting/journal/[id]/edit/actions';

/**
 * A new date for a journal entry. For an entry booked from a record, the
 * record's own date moves (an invoice's issue date, a payment's date) and the
 * entry follows it; the screen says which record.
 */
export function ChangeEntryDateForm({
  entryId,
  date,
  what,
  today,
}: {
  entryId: string;
  /** "YYYY-MM-DD" now. */
  date: string;
  /** The record whose date moves: "invoice INV-000012"; null for an entry made by hand. */
  what: string | null;
  today: string;
}) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await changeEntryDateAction(entryId, prev, formData);
      if (result.ok) {
        toast.success('Date changed');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="@container flex flex-col gap-5">
      <div className="grid gap-5 @xl:grid-cols-[12rem_1fr]">
        <TextField
          label="New date"
          name="date"
          id="entry-new-date"
          type="date"
          required
          defaultValue={date}
          max={today}
          error={errors.date}
          className="[&_input]:h-11"
        />
        <TextField
          label="Why"
          name="reason"
          id="entry-date-reason"
          required
          error={errors.reason}
          hint="Kept in the audit log, e.g. Entered on the wrong day."
          className="[&_input]:h-11"
        />
      </div>
      {what ? (
        <p className="text-xs text-muted-foreground">
          The date of {what} moves to the new day, and this entry follows it — the same accounts and
          amounts, in date order in the journal.
        </p>
      ) : null}
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} className="h-11" pendingLabel="Changing…">
          <CalendarClock />
          Change the date
        </SubmitButton>
      </div>
    </form>
  );
}
