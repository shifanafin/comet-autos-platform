'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Save } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { FormError, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { formatMoney } from '@/lib/format';
import type { ActionResult } from '@/lib/errors';
import { updateEntryNarrationAction } from '@/app/(app)/finance/accounting/actions';

/*
 * An entry's narration: its description and each line's note. Narration
 * moves no figure, so it can be corrected on any entry — one booked from an
 * invoice, one in a closed period — and the audit log keeps the old words.
 * The accounts and amounts are shown, not edited.
 */

export interface NarrationLine {
  id: string;
  account: string;
  party: string | null;
  debit: string;
  credit: string;
  memo: string;
}

export function JournalNarrationForm({
  entryId,
  description,
  lines,
}: {
  entryId: string;
  description: string;
  lines: NarrationLine[];
}) {
  const router = useRouter();
  const [notes, setNotes] = useState(() => new Map(lines.map((line) => [line.id, line.memo])));
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await updateEntryNarrationAction(entryId, prev, formData);
      if (result.ok) {
        toast.success('Narration saved');
        router.push('/finance/accounting?view=journal');
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const payload = JSON.stringify(
    lines.map((line) => ({ lineId: line.id, memo: notes.get(line.id) ?? '' })),
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <input type="hidden" name="notes" value={payload} />
      <TextField
        label="What is this entry for?"
        name="description"
        required
        defaultValue={description}
        error={errors.description}
        className="[&_input]:h-11"
      />
      <ol className="@container flex flex-col gap-3">
        {lines.map((line, index) => (
          <li
            key={line.id}
            className="grid gap-3 rounded-xl border border-border bg-card p-3 sm:p-4 @xl:grid-cols-[1fr_minmax(12rem,20rem)]"
          >
            <div className="flex min-w-0 flex-col gap-0.5 text-sm">
              <span className="font-medium break-words">{line.account}</span>
              {line.party ? (
                <span className="text-xs text-muted-foreground">{line.party}</span>
              ) : null}
              <span className="text-xs text-muted-foreground tabular-nums">
                {Number(line.debit) > 0
                  ? `Debit ${formatMoney(line.debit)}`
                  : `Credit ${formatMoney(line.credit)}`}
              </span>
            </div>
            <label className="flex min-w-0 flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">Note</span>
              <Input
                aria-label={`Line ${index + 1} note`}
                value={notes.get(line.id) ?? ''}
                maxLength={200}
                onChange={(event) =>
                  setNotes((current) => new Map(current).set(line.id, event.target.value))
                }
                className="h-11 text-base md:text-sm"
              />
            </label>
          </li>
        ))}
      </ol>
      <FormError message={state.error} />
      <div className="border-t border-border pt-6">
        <SubmitButton pending={isPending} size="lg" pendingLabel="Saving…">
          <Save />
          Save narration
        </SubmitButton>
      </div>
    </form>
  );
}
