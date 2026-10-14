'use client';

import { useState, useTransition } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BookCheck, Loader2, Lock, LockOpen, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FormError, NativeSelect } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { ReasonAction } from '@/components/shared/reason-action';
import { formatCalendarDate } from '@/lib/format';
import type { ActionResult } from '@/lib/errors';
import {
  addStandardAccountsAction,
  bookExistingRecordsAction,
  closeBooksAction,
  deleteManualEntryAction,
  reopenBooksAction,
  reverseManualEntryAction,
} from '@/app/(app)/finance/accounting/actions';

/** Reverses an entry made by hand, with a reason; the original stays on record. */
export function ReverseEntryButton({
  entryId,
  entryNumber,
}: {
  entryId: string;
  entryNumber: string;
}) {
  return (
    <ReasonAction
      trigger={
        <Button variant="outline" size="sm">
          <Undo2 />
          Reverse
        </Button>
      }
      title={`Reverse ${entryNumber}?`}
      description="An equal and opposite entry is booked today. The original stays on record, marked reversed — nothing is deleted. Use this once the books are closed; while they are open, editing or deleting the entry is cleaner."
      confirmLabel="Reverse entry"
      placeholder="e.g. Posted to the wrong account"
      successMessage="Entry reversed"
      onConfirm={({ reason }) => reverseManualEntryAction(entryId, { reason })}
    />
  );
}

/**
 * Deletes an entry made by hand from an open period, with a reason kept in
 * the audit log; the entries after it move up a number.
 */
export function DeleteEntryButton({
  entryId,
  entryNumber,
  withReversal,
}: {
  entryId: string;
  entryNumber: string;
  /** The entry has been reversed: its reversal goes too. */
  withReversal: boolean;
}) {
  const router = useRouter();
  return (
    <ReasonAction
      trigger={
        <Button variant="outline" size="sm">
          <Trash2 />
          Delete
        </Button>
      }
      title={`Delete ${entryNumber}?`}
      description={
        withReversal
          ? 'The entry and its reversal are removed together — they cancel out, so no balance moves. The entries after them move up, so the journal keeps no gap. What they said stays in the audit log.'
          : 'The entry is removed from the books and the entries after it move up a number, so the journal keeps no gap. What it said stays in the audit log.'
      }
      confirmLabel="Delete entry"
      placeholder="e.g. Booked twice by mistake"
      successMessage="Entry deleted"
      onConfirm={async ({ reason }) => {
        const result = await deleteManualEntryAction(entryId, { reason });
        if (result.ok) router.push('/finance/accounting?view=journal');
        return result;
      }}
    />
  );
}

/** Books every record kept before the books existed. Safe to run again. */
export function BookExistingButton({ count }: { count: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <Button
      disabled={isPending}
      onClick={() =>
        startTransition(async () => {
          const result = await bookExistingRecordsAction();
          if (!result.ok || !result.data) {
            toast.error(result.error ?? 'The records could not be booked.');
            return;
          }
          const { booked, failed } = result.data;
          if (failed.length) {
            toast.warning(`${booked} booked; ${failed.length} could not be: ${failed[0]}`);
          } else {
            toast.success(`${booked} record${booked === 1 ? '' : 's'} booked`);
          }
          router.refresh();
        })
      }
    >
      {isPending ? <Loader2 className="animate-spin" /> : <BookCheck />}
      Book {count} record{count === 1 ? '' : 's'}
    </Button>
  );
}

/** Adds any standard account the chart is missing; never changes one. */
export function AddStandardAccountsButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border px-4 py-3">
      <p className="text-sm text-muted-foreground">
        The standard UAE workshop chart: fixed assets and depreciation, owner&apos;s capital and
        drawings, end-of-service benefits, corporate tax and the usual expense categories.
      </p>
      <Button
        variant="outline"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            const result = await addStandardAccountsAction();
            if (!result.ok) return void toast.error(result.error ?? 'Could not add the accounts.');
            const added = result.data?.added ?? 0;
            toast.success(
              added
                ? `${added} standard account${added === 1 ? '' : 's'} added`
                : 'Nothing missing',
            );
            router.refresh();
          })
        }
      >
        {isPending ? <Loader2 className="animate-spin" /> : <BookCheck />}
        Add standard accounts
      </Button>
    </div>
  );
}

/**
 * Closing the books through a date, and reopening them. Shown to those who
 * may change the accounts.
 */
export function CloseBooksPanel({
  closedThrough,
  today,
}: {
  /** YYYY-MM-DD, or null when every period is open. */
  closedThrough: string | null;
  today: string;
}) {
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await closeBooksAction(prev, formData);
      if (result.ok) toast.success('Books closed');
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        {closedThrough ? (
          <>
            <Lock className="mr-1.5 inline size-4" />
            Closed through <strong>{formatCalendarDate(closedThrough)}</strong>. Nothing dated on or
            before it can be booked, changed or voided.
          </>
        ) : (
          <>
            <LockOpen className="mr-1.5 inline size-4" />
            Every period is open.
          </>
        )}
      </p>
      <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
        <Field label="Close the books through" htmlFor="through" error={errors.through}>
          <Input
            id="through"
            name="through"
            type="date"
            max={today}
            required
            className="h-10 w-44"
          />
        </Field>
        <Field label="Reason (when reopening)" htmlFor="close-reason" error={errors.reason}>
          <Input id="close-reason" name="reason" className="h-10 w-64" placeholder="Optional" />
        </Field>
        <SubmitButton pending={isPending} pendingLabel="Closing…">
          <Lock />
          Close
        </SubmitButton>
        {closedThrough ? (
          <ReasonAction
            trigger={
              <Button type="button" variant="outline">
                <LockOpen />
                Reopen all
              </Button>
            }
            title="Reopen every period?"
            description="Everything becomes changeable again. Do this only to correct a mistake, and close the books again afterwards."
            confirmLabel="Reopen"
            placeholder="e.g. Correcting a September invoice before re-filing"
            successMessage="Books reopened"
            onConfirm={({ reason }) => reopenBooksAction({ reason })}
          />
        ) : null}
      </form>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <p className="text-xs text-muted-foreground">
        Close a period once its VAT return is filed or its accounts are final.
      </p>
    </div>
  );
}

/** Which account's ledger to show. */
export function AccountPicker({
  accounts,
  value,
}: {
  accounts: { id: string; code: string; name: string }[];
  value: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState(value ?? '');
  return (
    <Field label="Account" htmlFor="ledger-account">
      <NativeSelect
        id="ledger-account"
        value={selected}
        disabled={isPending}
        onChange={(event) => {
          setSelected(event.target.value);
          const params = new URLSearchParams(searchParams.toString());
          params.set('view', 'ledger');
          params.set('account', event.target.value);
          startTransition(() => router.push(`/finance/accounting?${params}`));
        }}
        className="h-10 max-w-md"
      >
        <option value="" disabled>
          Choose an account…
        </option>
        {accounts.map((account) => (
          <option key={account.id} value={account.id}>
            {account.code} · {account.name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}
