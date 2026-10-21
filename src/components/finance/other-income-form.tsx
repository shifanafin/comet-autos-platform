'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Banknote } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { ReasonAction } from '@/components/shared/reason-action';
import type { ActionResult } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import type { OtherIncomeForm as FormOptions } from '@/lib/finance/other-income';
import { recordOtherIncomeAction, voidOtherIncomeAction } from '@/app/(app)/finance/money/actions';

/** An amount as typed, in fils — 0 while it isn't a figure yet. */
function typedFils(value: string) {
  const text = value.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(text)) return 0;
  const [whole, part = ''] = text.split('.');
  return Number(whole) * 100 + Number(part.padEnd(2, '0'));
}

/** The VAT inside an amount at a rate — as the server works it out (advance-vat.ts vatIncluded). */
function vatInside(fils: number, rate: string) {
  const basis = Math.round(Number(rate) * 100);
  if (!basis || fils <= 0) return 0;
  return Math.round((fils * basis) / (10_000 + basis));
}

const aed = (fils: number) => formatMoney((fils / 100).toFixed(2));

/**
 * Rent or other income received — who paid, what for, how much, into which
 * account — with the VAT inside it and the entry it books shown before saving.
 */
export function OtherIncomeForm({ options }: { options: FormOptions }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [incomeAccountId, setIncomeAccountId] = useState(options.defaults.incomeAccountId);
  const [accountId, setAccountId] = useState(options.defaults.accountId);
  const [taxCodeId, setTaxCodeId] = useState(options.defaults.taxCodeId);
  const [amount, setAmount] = useState('');
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await recordOtherIncomeAction(prev, formData);
      if (result.ok) {
        toast.success('Income recorded');
        formRef.current?.reset();
        setAmount('');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const income = options.incomeAccounts.find((a) => a.id === incomeAccountId);
  const money = options.moneyAccounts.find((a) => a.id === accountId);
  const code = options.taxCodes.find((c) => c.id === taxCodeId);
  const fils = typedFils(amount);
  const vat = options.registered && code ? vatInside(fils, code.rate) : 0;

  const lines = [
    {
      code: money?.code ?? '—',
      name: money?.label ?? 'Choose the account',
      debit: fils,
      credit: 0,
    },
    {
      code: income?.code ?? '—',
      name: income?.name ?? 'Choose the income account',
      debit: 0,
      credit: fils - vat,
    },
    ...(vat ? [{ ...options.outputVat, debit: 0, credit: vat }] : []),
  ];

  if (options.incomeAccounts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Add an income account first — e.g. 4030 Rental income — under Accounting → Chart of
        accounts.
      </p>
    );
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="@container flex flex-col gap-6">
      <div className="grid gap-6 @xl:grid-cols-2">
        <TextField
          label="Received from"
          name="receivedFrom"
          id="income-from"
          required
          error={errors.receivedFrom}
          hint="Who paid — a name is enough."
          className="[&_input]:h-11"
        />
        <TextField
          label="For"
          name="description"
          id="income-description"
          required
          error={errors.description}
          hint="e.g. Rent — workshop space, October 2026."
          className="[&_input]:h-11"
        />
        <TextField
          label="Amount received (AED)"
          name="amount"
          id="income-amount"
          numeric="money"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={errors.amount}
          hint="What was handed over, VAT included."
          className="[&_input]:h-11"
        />
        <TextField
          label="Date received"
          name="receivedOn"
          id="income-date"
          type="date"
          required
          defaultValue={options.today}
          max={options.today}
          error={errors.receivedOn}
          className="[&_input]:h-11"
        />
        <Field
          label="Income account"
          htmlFor="income-account"
          required
          error={errors.incomeAccountId}
        >
          <NativeSelect
            id="income-account"
            name="incomeAccountId"
            value={incomeAccountId}
            onChange={(event) => setIncomeAccountId(event.target.value)}
            className="h-11"
          >
            {options.incomeAccounts.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.code} ${option.name}`}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Received into" htmlFor="income-money" required error={errors.accountId}>
          <NativeSelect
            id="income-money"
            name="accountId"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            className="h-11"
          >
            <option value="" disabled>
              Choose…
            </option>
            {options.moneyAccounts.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.code} ${option.label}`}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="VAT"
          htmlFor="income-tax"
          required
          error={errors.taxCodeId}
          hint="Renting out business premises is standard rated (5%)."
        >
          <NativeSelect
            id="income-tax"
            name="taxCodeId"
            value={taxCodeId}
            onChange={(event) => setTaxCodeId(event.target.value)}
            className="h-11"
          >
            {options.taxCodes.map((option) => (
              <option key={option.id} value={option.id}>
                {`${option.code} — ${option.name}`}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <TextField
          label="Notes"
          name="notes"
          id="income-notes"
          error={errors.notes}
          hint="Optional."
          className="[&_input]:h-11"
        />
      </div>

      {/* The entry, before it is saved. */}
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
          {fils > 0
            ? vat
              ? `Income ${aed(fils - vat)} and VAT ${aed(vat)} inside the ${aed(fils)} received — the VAT goes in the return for the month received.`
              : `Income ${aed(fils)}, no VAT.`
            : 'Enter the amount to see the entry.'}
        </p>
      </div>

      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} className="h-11" pendingLabel="Saving…">
          <Banknote />
          Record income
        </SubmitButton>
      </div>
    </form>
  );
}

/** Withdraws a receipt entered by mistake. */
export function VoidOtherIncomeButton({ id, label }: { id: string; label: string }) {
  return (
    <ReasonAction
      trigger={
        <Button variant="ghost" size="sm">
          <Ban />
          Void
        </Button>
      }
      title={`Void ${label}?`}
      description="It stays on record, marked void, and its journal entry is reversed — the income, the VAT and the account go back to what they were. Its number is not reused."
      placeholder="e.g. Entered twice."
      confirmLabel="Void"
      successMessage={`${label} voided`}
      onConfirm={(input) => voidOtherIncomeAction(id, input)}
    />
  );
}
