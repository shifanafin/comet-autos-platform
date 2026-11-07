'use client';

import { useState } from 'react';
import { Field, NativeSelect, TextField } from '@/components/forms/fields';
import { ReferenceField } from '@/components/forms/reference-field';
import { MoneyAccountField } from '@/components/accounting/money-account-field';
import { PaymentModeField } from '@/components/accounting/payment-mode-field';
import type { AccountChoice } from '@/lib/accounting/reports';
import type { PaymentModeOption } from '@/lib/accounting/payment-modes';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/*
 * What happens to the supplier's bill as the goods come in — shared by "Save
 * & receive stock" on a new purchase and the Receive screen of a draft, so
 * both send the same fields to the same server function:
 *
 *   payment       "later" (default) or "now"
 *   dueDate       when paying later (the Receive screen only; a new purchase
 *                 has the due date among its own details)
 *   payAmount     when paying now — blank pays everything owed
 *   method / accountId (or a payment mode), payReference
 *   updateCostPrice   "on" to set each part's cost price to its cost after
 *                     discounts — off by default
 *
 * The server checks everything again: the right to pay a supplier, never
 * more than is owed, never from card settlements.
 */

const METHODS = [
  { value: 'CASH', label: 'Cash' },
  { value: 'BANK_TRANSFER', label: 'Bank transfer' },
  { value: 'CHEQUE', label: 'Cheque' },
  { value: 'CARD', label: 'Card' },
  { value: 'ONLINE', label: 'Online' },
];

export interface ReceiptOptions {
  /** Payment modes for the workshop's own costs (none on card settlements). */
  modes: PaymentModeOption[];
  /** Used when no payment modes are set up. */
  moneyAccounts: AccountChoice[];
  /** May pay suppliers (supplier_payment.create): "Paid now" is offered. */
  canPay: boolean;
  /** May change catalogue cost prices: the cost-price tick is offered. */
  canUpdateCost: boolean;
}

const inputClass = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

export function ReceiptSettlementFields({
  options,
  errors,
  showDueDate,
  amount,
  onAmountChange,
  amountHint,
  onPaymentChange,
  idPrefix = 'receipt',
}: {
  options: ReceiptOptions;
  errors: Record<string, string>;
  /** The Receive screen asks for the due date here; a new purchase has its own field. */
  showDueDate: boolean;
  /** Controlled amount to pay now (a new purchase follows its total until edited). */
  amount?: string;
  onAmountChange?: (value: string) => void;
  amountHint: string;
  onPaymentChange?: (payment: 'later' | 'now') => void;
  idPrefix?: string;
}) {
  const [payment, setPayment] = useState<'later' | 'now'>('later');
  const choose = (value: 'later' | 'now') => {
    setPayment(value);
    onPaymentChange?.(value);
  };

  return (
    <fieldset className="flex flex-col gap-4 rounded-xl border border-border p-4 sm:p-5">
      <legend className="px-1 text-sm font-semibold">Paying the supplier</legend>
      <input type="hidden" name="payment" value={payment} />
      {options.canPay ? (
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Payment">
          {(
            [
              ['later', 'Pay later', 'Nothing leaves the cash or bank. The bill stays owed.'],
              ['now', 'Paid now', 'Record the payment made as the goods arrived.'],
            ] as const
          ).map(([value, title, note]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={payment === value}
              onClick={() => choose(value)}
              className={cn(
                'flex flex-col gap-0.5 rounded-lg border px-4 py-3 text-left text-sm transition-colors',
                payment === value
                  ? 'border-primary bg-primary/5'
                  : 'border-border bg-card hover:bg-muted',
              )}
            >
              <span className="font-medium">{title}</span>
              <span className="text-xs text-muted-foreground">{note}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          The bill stays owed to the supplier and is paid from Suppliers owed.
        </p>
      )}

      {payment === 'later' && showDueDate ? (
        <TextField
          id={`${idPrefix}-due`}
          label="Due date"
          name="dueDate"
          type="date"
          error={errors.dueDate}
          hint="Optional: when the supplier expects to be paid. Suppliers owed counts overdue from it."
          className={cn('sm:max-w-xs', inputClass)}
        />
      ) : null}

      {payment === 'now' ? (
        <div className="grid gap-4 md:grid-cols-2">
          <TextField
            id={`${idPrefix}-amount`}
            label="Amount paid (AED)"
            name="payAmount"
            numeric="money"
            value={amount}
            onChange={onAmountChange ? (event) => onAmountChange(event.target.value) : undefined}
            error={errors.payAmount ?? errors.amount}
            hint={amountHint}
            className={inputClass}
          />
          {options.modes.length ? (
            <PaymentModeField
              id={`${idPrefix}-mode`}
              modes={options.modes}
              label="Paid by"
              error={errors.method ?? errors.accountId}
            />
          ) : (
            <>
              <Field label="Paid by" htmlFor={`${idPrefix}-method`} required error={errors.method}>
                <NativeSelect
                  id={`${idPrefix}-method`}
                  name="method"
                  defaultValue="CASH"
                  className="h-11 text-base md:text-sm"
                >
                  {METHODS.map((method) => (
                    <option key={method.value} value={method.value}>
                      {method.label}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              {options.moneyAccounts.length ? (
                <MoneyAccountField
                  id={`${idPrefix}-account`}
                  name="accountId"
                  label="Paid from"
                  accounts={options.moneyAccounts}
                  error={errors.accountId}
                />
              ) : null}
            </>
          )}
          <ReferenceField
            id={`${idPrefix}-reference`}
            label="Reference"
            name="payReference"
            error={errors.payReference}
            hint="Optional: transfer or cheque number."
            className={inputClass}
          />
        </div>
      ) : null}

      {options.canUpdateCost ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="updateCostPrice" value="on" className="mt-1 size-4" />
          <span>
            Update part cost price to cost after discount
            <span className="block text-xs text-muted-foreground">
              Off: each part keeps the cost price it has in the catalogue.
            </span>
          </span>
        </label>
      ) : null}
    </fieldset>
  );
}

/** The hint under the amount to pay now: the bill total when known, else "blank pays it all". */
export const owedHint = (total: string | null) =>
  total
    ? `The bill comes to ${formatMoney(total)}. Enter less for a part payment; the rest stays owed.`
    : 'Leave blank to pay everything owed. Enter less for a part payment; the rest stays owed.';

/**
 * Correcting a received purchase that is already paid: whether the payment
 * follows the new total (the amount was typed wrong on both) or stays as it
 * is, any difference owed. Sent as `paidChoice`.
 */
export function CorrectionPaymentFields({
  paid,
  total,
  error,
}: {
  /** What is paid on it now. */
  paid: string;
  /** The corrected total, when the lines are complete. */
  total: string | null;
  error?: string;
}) {
  const [choice, setChoice] = useState<'follow' | 'keep'>('follow');
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:p-5">
      <legend className="px-1 text-sm font-semibold">Paying the supplier</legend>
      <input type="hidden" name="paidChoice" value={choice} />
      <p className="text-sm text-muted-foreground">{`${formatMoney(paid)} is paid on this purchase.`}</p>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Payment">
        {(
          [
            [
              'follow',
              'Paid in full',
              total
                ? `The payment changes to ${formatMoney(total)}, on the day it was made.`
                : 'The payment changes to the new total, on the day it was made.',
            ],
            [
              'keep',
              'Leave the payment as it is',
              'Any difference stays owed to the supplier, and is paid later.',
            ],
          ] as const
        ).map(([value, title, note]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={choice === value}
            onClick={() => setChoice(value)}
            className={cn(
              'flex flex-col gap-0.5 rounded-lg border px-4 py-3 text-left text-sm transition-colors',
              choice === value
                ? 'border-primary bg-primary/5'
                : 'border-border bg-card hover:bg-muted',
            )}
          >
            <span className="font-medium">{title}</span>
            <span className="text-xs text-muted-foreground">{note}</span>
          </button>
        ))}
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </fieldset>
  );
}
