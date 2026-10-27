'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, HandCoins, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { ReasonAction } from '@/components/shared/reason-action';
import type { ActionResult } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { OWNER_MONEY_LABEL, type OwnerMoneyKindKey } from '@/lib/finance/owner-money-labels';
import type {
  OwnerMoneyEntry,
  OwnerMoneyForm as FormOptions,
  OwnerMoneyHow,
} from '@/lib/finance/owner-money';
import {
  addPartnerAction,
  recordOwnerMoneyAction,
  updateOwnerMoneyAction,
  voidOwnerMoneyAction,
} from '@/app/(app)/finance/money/actions';

const KINDS: { kind: OwnerMoneyKindKey; title: string; hint: string }[] = [
  {
    kind: 'CAPITAL_IN',
    title: 'Put money in',
    hint: 'Your money for the business to use — it stays in the business (capital).',
  },
  {
    kind: 'LOAN_IN',
    title: 'Lend to the business',
    hint: 'Money you will take back later — the business owes it to you.',
  },
  {
    kind: 'DRAWINGS',
    title: 'Take money out',
    hint: 'Money you take from the business for yourself (drawings).',
  },
];

/** How money put in arrived: through cash or bank, or straight into a cost or a debt. */
const HOWS: { how: OwnerMoneyHow; title: string; hint: string }[] = [
  {
    how: 'money',
    title: 'Money into cash or bank',
    hint: 'Cash handed over, or a transfer into the bank.',
  },
  {
    how: 'cost',
    title: 'Paid a business cost from own pocket',
    hint: 'e.g. Tasheel or MOHRE fees the partner paid personally. A supplier bill with VAT goes in Expenses instead, so its VAT is claimed.',
  },
  {
    how: 'owed',
    title: 'Left in what the business owed them',
    hint: 'e.g. a salary the partner did not take: the business no longer owes it, it stays as their capital.',
  },
];

/** An amount as typed, in fils — 0 while it isn't a figure yet. */
function typedFils(value: string) {
  const text = value.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return 0;
  const [whole, part = ''] = text.split('.');
  return Number(whole) * 100 + Number(part.padEnd(2, '0'));
}

const aed = (fils: number) => formatMoney((fils / 100).toFixed(2));

/**
 * An owner putting money into the business or taking it out — with the
 * journal entry it will book shown as it is filled in, before it is saved.
 * Given an entry, it opens filled in and saves a correction of it.
 */
export function OwnerMoneyForm({
  options,
  entry,
}: {
  options: FormOptions;
  entry?: OwnerMoneyEntry;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const cashId = options.accounts.find((account) => account.kind === 'cash')?.id ?? '';
  const [kind, setKind] = useState<OwnerMoneyKindKey>(entry?.kind ?? 'CAPITAL_IN');
  const [how, setHow] = useState<OwnerMoneyHow>(entry?.how ?? 'money');
  const [accountId, setAccountId] = useState(entry?.accountId ?? cashId);
  const [amount, setAmount] = useState(entry?.amount ?? '');
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      if (entry) {
        const result = await updateOwnerMoneyAction(entry.id, prev, formData);
        if (result.ok) {
          toast.success(`${entry.entryNumber} corrected`);
          router.push('/finance/money/owner');
        }
        return result;
      }
      const result = await recordOwnerMoneyAction(prev, formData);
      if (result.ok) {
        toast.success(`${OWNER_MONEY_LABEL[kind]} recorded`);
        formRef.current?.reset();
        setAmount('');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const choices = how === 'money' ? options.accounts : options.direct[how];
  const account = options.accounts.find((a) => a.id === accountId);
  const chosen = choices.find((a) => a.id === accountId);
  const other = options.other[kind];
  const fils = typedFils(amount);
  const out = kind === 'DRAWINGS';
  const chooseHow = (next: OwnerMoneyHow) => {
    setHow(next);
    setAccountId(next === 'money' ? cashId : '');
  };
  const chooseKind = (next: OwnerMoneyKindKey) => {
    setKind(next);
    // Only money put in can be a cost paid or something owed left in.
    if (next !== 'CAPITAL_IN' && how !== 'money') chooseHow('money');
  };

  // The entry, as the books will record it.
  const moneyLine = {
    code: chosen?.code ?? '—',
    name: chosen?.label ?? 'Choose the account',
  };
  const lines = out
    ? [
        { ...other, debit: fils, credit: 0 },
        { ...moneyLine, debit: 0, credit: fils },
      ]
    : [
        { ...moneyLine, debit: fils, credit: 0 },
        { ...other, debit: 0, credit: fils },
      ];

  return (
    <form ref={formRef} onSubmit={onSubmit} className="@container flex flex-col gap-6">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="how" value={how} />

      <div role="radiogroup" aria-label="What happened" className="grid gap-3 @2xl:grid-cols-3">
        {KINDS.map((option) => (
          <button
            key={option.kind}
            type="button"
            role="radio"
            aria-checked={kind === option.kind}
            onClick={() => chooseKind(option.kind)}
            className={cn(
              'flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors',
              kind === option.kind
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-muted/50',
            )}
          >
            <span className="text-sm font-semibold">{option.title}</span>
            <span className="text-xs text-muted-foreground">{option.hint}</span>
          </button>
        ))}
      </div>
      {errors.kind ? <p className="text-sm text-destructive">{errors.kind}</p> : null}

      <div className="grid gap-6 @xl:grid-cols-2">
        {kind === 'CAPITAL_IN' ? (
          <Field
            label="How it came in"
            htmlFor="owner-money-how"
            error={errors.how}
            className="@xl:col-span-2"
            hint={HOWS.find((option) => option.how === how)?.hint}
          >
            <NativeSelect
              id="owner-money-how"
              value={how}
              onChange={(event) => chooseHow(event.target.value as OwnerMoneyHow)}
              className="h-11 @xl:max-w-md"
            >
              {HOWS.map((option) => (
                <option key={option.how} value={option.how}>
                  {option.title}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        <Field
          label={
            out
              ? 'Taken from'
              : how === 'cost'
                ? 'Cost paid for'
                : how === 'owed'
                  ? 'What the business owed'
                  : 'Put into'
          }
          htmlFor="owner-money-account"
          required
          error={errors.accountId}
          hint={
            how === 'cost'
              ? 'The expense the partner paid from their own pocket.'
              : how === 'owed'
                ? 'A salary not taken, or money the business owes them back.'
                : account
                  ? account.balance.startsWith('-')
                    ? `Shows ${formatMoney(account.balance.slice(1))} below zero now.`
                    : `Holds ${formatMoney(account.balance)} now.`
                  : 'Cash on hand, the petty-cash box or the bank.'
          }
        >
          <NativeSelect
            id="owner-money-account"
            name="accountId"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="h-11"
          >
            <option value="" disabled>
              Choose…
            </option>
            {choices.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.code} ${option.label}`}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {options.partners.length ? (
          <Field
            label="Partner"
            htmlFor="owner-money-partner"
            required={how !== 'money'}
            error={errors.partnerId}
            hint="Whose money it is — add partners under Partners below."
          >
            <NativeSelect
              id="owner-money-partner"
              name="partnerId"
              defaultValue={
                entry
                  ? entry.partnerId
                  : options.partners.length === 1
                    ? options.partners[0].id
                    : ''
              }
              className="h-11"
            >
              <option value="">Not said</option>
              {options.partners.map((partner) => (
                <option key={partner.id} value={partner.id}>
                  {partner.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        <TextField
          label="Amount (AED)"
          name="amount"
          id="owner-money-amount"
          numeric="money"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={errors.amount}
          className="[&_input]:h-11"
        />
        <TextField
          label="Date"
          name="movedOn"
          id="owner-money-date"
          type="date"
          required
          defaultValue={entry?.movedOn ?? options.today}
          max={options.today}
          error={errors.movedOn}
          className="[&_input]:h-11"
        />
        <TextField
          label="Reference"
          name="reference"
          id="owner-money-reference"
          defaultValue={entry?.reference}
          error={errors.reference}
          hint="Optional: a deposit slip or transfer number."
          className="[&_input]:h-11"
        />
        <TextField
          label="Notes"
          name="notes"
          id="owner-money-notes"
          defaultValue={entry?.notes}
          error={errors.notes}
          hint="Optional: e.g. money for parts and running costs."
          className="[&_input]:h-11"
        />
      </div>

      {/* The journal entry, before it is saved. */}
      <div className="rounded-lg border border-border bg-muted/30">
        <p className="border-b border-border px-4 py-2.5 text-sm font-semibold">
          Journal entry this books
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-105 text-sm">
            <thead className="text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-2">Account</th>
                <th className="w-32 px-4 py-2 text-right">Debit</th>
                <th className="w-32 px-4 py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((line, index) => (
                <tr key={index}>
                  <td className="px-4 py-2">
                    <span className="mr-2 font-mono text-xs text-muted-foreground">
                      {line.code}
                    </span>
                    {line.name}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {line.debit ? aed(line.debit) : ''}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {line.credit ? aed(line.credit) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {fils <= 0
            ? 'Enter the amount to see the entry.'
            : how === 'cost'
              ? `${moneyLine.name} is the business's cost, as it would be if the business had paid it; the partner paid it, so ${aed(fils)} counts as their capital. No cash or bank moves.`
              : how === 'owed'
                ? `The business no longer owes ${aed(fils)} — it stays in as the partner's capital. No cash or bank moves, and profit does not change.`
                : `${moneyLine.name} goes ${out ? 'down' : 'up'} by ${aed(fils)}. ${
                    kind === 'LOAN_IN'
                      ? `The business owes you ${aed(fils)} more — repay it with Reimburse owner.`
                      : kind === 'DRAWINGS'
                        ? 'It is not an expense: profit does not change.'
                        : 'It is not income: profit does not change.'
                  }`}
        </p>
      </div>

      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} className="h-11" pendingLabel="Saving…">
          <HandCoins />
          {entry
            ? `Save changes to ${entry.entryNumber}`
            : `Record — ${OWNER_MONEY_LABEL[kind].toLowerCase()}`}
        </SubmitButton>
      </div>
    </form>
  );
}

/** Withdraws an entry made by mistake. */
export function VoidOwnerMoneyButton({ id, label }: { id: string; label: string }) {
  return (
    <ReasonAction
      trigger={
        <Button variant="ghost" size="sm">
          <Ban />
          Void
        </Button>
      }
      title={`Void ${label}?`}
      description="It stays on record, marked void, and its journal entry is reversed — the account goes back to what it was. Its number is not reused."
      placeholder="e.g. Entered twice."
      confirmLabel="Void"
      successMessage={`${label} voided`}
      onConfirm={(input) => voidOwnerMoneyAction(id, input)}
    />
  );
}

/** Adds a partner by name — the business's owners, kept here (not logins). */
export function AddPartnerForm() {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await addPartnerAction(prev, formData);
      if (result.ok) {
        toast.success('Partner added');
        formRef.current?.reset();
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <TextField
        label="Partner's name"
        name="name"
        id="partner-name"
        required
        error={errors.name ?? (Object.keys(errors).length ? undefined : state.error)}
        className="min-w-56 flex-1 [&_input]:h-11"
      />
      <SubmitButton pending={isPending} variant="outline" className="h-11" pendingLabel="Adding…">
        <UserPlus />
        Add partner
      </SubmitButton>
    </form>
  );
}
