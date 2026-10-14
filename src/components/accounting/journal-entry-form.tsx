'use client';

import { useMemo, useState } from 'react';
import { NumberInput } from '@/components/forms/number-input';
import { useRouter } from 'next/navigation';
import { Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { formatMoney } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import type { ActionResult } from '@/lib/errors';
import {
  createManualEntryAction,
  updateManualEntryAction,
} from '@/app/(app)/finance/accounting/actions';
import { cn } from '@/lib/utils';

/*
 * A journal entry made by hand: opening balances, the owner's capital or
 * drawings, bank charges, depreciation, card takings moved to the bank, a
 * correction between accounts — or an amount for one customer or supplier.
 * It saves only when debits equal credits — the server checks again, and so
 * does the database.
 *
 * A line on an account kept per customer or per supplier (trade receivables,
 * trade payables, or one the accountant set up that way) names who it is
 * for, so it counts in that party's balance and statement.
 *
 * Given an entry, the form edits it instead: same number, its lines
 * replaced, the old version kept in the audit log.
 *
 * Each line is a small card laid out by the form's own width: account and
 * party side by side with the amounts beneath on a desk, everything stacked
 * on a phone — never a table to scroll sideways.
 */

interface Line {
  key: number;
  accountId: string;
  partyId: string;
  debit: string;
  credit: string;
  memo: string;
}

export interface JournalAccount {
  id: string;
  code: string;
  name: string;
  type: string;
  /** Kept per customer or per supplier: the line must name one. */
  party: 'CUSTOMER' | 'SUPPLIER' | null;
}

/** An entry made by hand, opened for editing. */
export interface EditableEntry {
  id: string;
  entryNumber: string | null;
  date: string;
  description: string;
  lines: { accountId: string; partyId: string; debit: string; credit: string; memo: string }[];
}

export interface JournalParty {
  id: string;
  name: string;
  detail: string | null;
}

const TYPE_LABEL: Record<string, string> = {
  ASSET: 'Assets',
  LIABILITY: 'Liabilities',
  EQUITY: 'Equity',
  REVENUE: 'Income',
  EXPENSE: 'Expenses',
};

/** An amount as typed, in fils; 0 when blank or not a valid amount. */
function amountFils(value: string) {
  const text = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return 0;
  return toFils(text);
}

let next = 0;
const blankLine = (): Line => ({
  key: next++,
  accountId: '',
  partyId: '',
  debit: '',
  credit: '',
  memo: '',
});

export function JournalEntryForm({
  accounts,
  customers,
  suppliers,
  today,
  entry,
}: {
  accounts: JournalAccount[];
  customers: JournalParty[];
  suppliers: JournalParty[];
  today: string;
  entry?: EditableEntry;
}) {
  const router = useRouter();
  const [lines, setLines] = useState<Line[]>(() =>
    entry ? entry.lines.map((line) => ({ ...line, key: next++ })) : [blankLine(), blankLine()],
  );
  const [state, onSubmit, isPending] = useFormAction<ActionResult<{ entryNumber: string | null }>>(
    async (prev, formData) => {
      const result = entry
        ? await updateManualEntryAction(entry.id, prev, formData)
        : await createManualEntryAction(prev, formData);
      if (result.ok) {
        toast.success(`Entry ${result.data?.entryNumber ?? ''} ${entry ? 'saved' : 'booked'}`);
        router.push('/finance/accounting?view=journal');
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const byId = useMemo(() => new Map(accounts.map((account) => [account.id, account])), [accounts]);

  const totals = useMemo(() => {
    const debit = lines.reduce((sum, line) => sum + amountFils(line.debit), 0);
    const credit = lines.reduce((sum, line) => sum + amountFils(line.credit), 0);
    return { debit, credit, difference: debit - credit };
  }, [lines]);
  const used = lines.filter((line) => line.accountId || line.debit || line.credit);
  const partyMissing = used.some((line) => byId.get(line.accountId)?.party && !line.partyId);
  const ready = used.length >= 2 && totals.debit > 0 && totals.difference === 0 && !partyMissing;

  const grouped = Object.entries(TYPE_LABEL).map(([type, label]) => ({
    label,
    accounts: accounts.filter((account) => account.type === type),
  }));
  const update = (key: number, patch: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));

  const payload = JSON.stringify(
    used.map(({ accountId, partyId, debit, credit, memo }) => ({
      accountId,
      // Only an account kept per party carries one.
      partyId: byId.get(accountId)?.party ? partyId : '',
      debit,
      credit,
      memo,
    })),
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-8">
      <input type="hidden" name="lines" value={payload} />
      <div className="@container">
        <div className="grid gap-6 @xl:grid-cols-[12rem_1fr]">
          <Field label="Date" htmlFor="date" required error={errors.date}>
            <Input
              id="date"
              name="date"
              type="date"
              required
              max={today}
              defaultValue={entry?.date ?? today}
              className="h-11"
            />
          </Field>
          <TextField
            label="What is this entry for?"
            name="description"
            required
            error={errors.description}
            placeholder="e.g. Owner's capital paid into the bank"
            defaultValue={entry?.description}
            className="[&_input]:h-11"
          />
        </div>
      </div>

      <ol className="@container flex flex-col gap-3">
        {lines.map((line, index) => {
          const account = byId.get(line.accountId);
          const party = account?.party ?? null;
          const parties = party === 'CUSTOMER' ? customers : party === 'SUPPLIER' ? suppliers : [];
          const n = index + 1;
          return (
            <li
              key={line.key}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3 sm:p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Line {n}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove line ${n}`}
                  disabled={lines.length <= 2}
                  onClick={() => setLines((current) => current.filter((l) => l.key !== line.key))}
                >
                  <Trash2 />
                </Button>
              </div>

              <div className={cn('grid gap-3', party && '@3xl:grid-cols-2')}>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Account</span>
                  <NativeSelect
                    aria-label={`Line ${n} account`}
                    value={line.accountId}
                    onChange={(event) =>
                      update(line.key, { accountId: event.target.value, partyId: '' })
                    }
                    className="h-11 text-base md:text-sm"
                  >
                    <option value="">Choose an account…</option>
                    {grouped.map((group) =>
                      group.accounts.length ? (
                        <optgroup key={group.label} label={group.label}>
                          {group.accounts.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.code} · {option.name}
                            </option>
                          ))}
                        </optgroup>
                      ) : null,
                    )}
                  </NativeSelect>
                </label>
                {party ? (
                  <label className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs font-medium text-muted-foreground">
                      {party === 'CUSTOMER' ? 'Customer' : 'Supplier'}
                      <span className="text-destructive" aria-hidden>
                        {' '}
                        *
                      </span>
                    </span>
                    <NativeSelect
                      aria-label={`Line ${n} ${party === 'CUSTOMER' ? 'customer' : 'supplier'}`}
                      value={line.partyId}
                      onChange={(event) => update(line.key, { partyId: event.target.value })}
                      className={cn(
                        'h-11 text-base md:text-sm',
                        !line.partyId && 'border-warning/60',
                      )}
                    >
                      <option value="">
                        {party === 'CUSTOMER' ? 'Choose the customer…' : 'Choose the supplier…'}
                      </option>
                      {parties.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                          {option.detail ? ` — ${option.detail}` : ''}
                        </option>
                      ))}
                    </NativeSelect>
                  </label>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3 @xl:grid-cols-[minmax(7rem,10rem)_minmax(7rem,10rem)_1fr]">
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Debit</span>
                  <NumberInput
                    aria-label={`Line ${n} debit`}
                    value={line.debit}
                    placeholder="0.00"
                    onChange={(event) =>
                      update(line.key, { debit: event.target.value, credit: '' })
                    }
                    className="h-11 text-right text-base tabular-nums md:text-sm"
                  />
                </label>
                <label className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Credit</span>
                  <NumberInput
                    aria-label={`Line ${n} credit`}
                    value={line.credit}
                    placeholder="0.00"
                    onChange={(event) =>
                      update(line.key, { credit: event.target.value, debit: '' })
                    }
                    className="h-11 text-right text-base tabular-nums md:text-sm"
                  />
                </label>
                <label className="col-span-2 flex min-w-0 flex-col gap-1 @xl:col-span-1">
                  <span className="text-xs font-medium text-muted-foreground">Note</span>
                  <Input
                    aria-label={`Line ${n} note`}
                    value={line.memo}
                    onChange={(event) => update(line.key, { memo: event.target.value })}
                    className="h-11 text-base md:text-sm"
                  />
                </label>
              </div>
              {errors[`lines.${index}`] ? (
                <p className="text-xs text-destructive">{errors[`lines.${index}`]}</p>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <Button
          type="button"
          variant="outline"
          className="h-11 self-start"
          onClick={() => setLines((current) => [...current, blankLine()])}
        >
          <Plus />
          Add a line
        </Button>
        {/* The totals, always in view of the last line. */}
        <dl className="grid grid-cols-3 gap-4 rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm sm:min-w-[24rem]">
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Debits</dt>
            <dd className="font-semibold tabular-nums">
              {formatMoney(filsToString(totals.debit))}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Credits</dt>
            <dd className="font-semibold tabular-nums">
              {formatMoney(filsToString(totals.credit))}
            </dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-xs text-muted-foreground">Check</dt>
            <dd
              className={cn(
                'font-semibold',
                totals.difference === 0 ? 'text-success' : 'text-destructive',
              )}
            >
              {totals.difference === 0
                ? totals.debit > 0
                  ? 'Balanced'
                  : '—'
                : `Out by ${formatMoney(filsToString(Math.abs(totals.difference)))}`}
            </dd>
          </div>
        </dl>
      </div>

      {partyMissing ? (
        <p className="text-sm text-warning">
          Choose the customer or supplier on every line that asks for one.
        </p>
      ) : null}
      {entry ? (
        <TextField
          label="Why the change? (optional)"
          name="reason"
          error={errors.reason}
          placeholder="e.g. Wrong account chosen"
          className="[&_input]:h-11"
        />
      ) : null}
      <FormError message={errors.lines ?? state.error} />
      <div className="border-t border-border pt-6">
        <SubmitButton
          pending={isPending}
          disabled={!ready}
          size="lg"
          pendingLabel={entry ? 'Saving…' : 'Booking…'}
        >
          <Save />
          {entry ? 'Save changes' : 'Book entry'}
        </SubmitButton>
        <p className="mt-3 text-sm text-muted-foreground">
          While its period is open an entry can be edited or deleted, and the audit log keeps every
          version. Once the books are closed it can only be reversed.
        </p>
      </div>
    </form>
  );
}
