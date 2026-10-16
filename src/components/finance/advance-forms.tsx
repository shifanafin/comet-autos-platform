'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, HandCoins, Link2, Undo2, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { ReferenceField } from '@/components/forms/reference-field';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { ReasonAction } from '@/components/shared/reason-action';
import { MoneyAccountField } from '@/components/accounting/money-account-field';
import { PaymentModeField } from '@/components/accounting/payment-mode-field';
import { CustomerPicker, type PickedParty } from '@/components/workshop/customer-picker';
import { PAYMENT_METHODS } from '@/components/finance/invoice-payment-form';
import type { ActionResult } from '@/lib/errors';
import type { AccountChoice } from '@/lib/accounting/reports';
import type { PaymentModeOption } from '@/lib/accounting/payment-modes';
import type { CustomerOption } from '@/lib/customers/picker';
import { filsToString, toFils } from '@/lib/money';
import { formatMoney } from '@/lib/format';
import {
  applyAdvanceAction,
  cancelAdvanceAction,
  receiveAdvanceAction,
  refundAdvanceAction,
  reverseRefundAction,
  undoApplicationAction,
} from '@/app/(app)/finance/advances/actions';

/*
 * Customer advances on screen: taking one, applying it to an invoice (from
 * either side — the advance or the invoice), refunding it, and undoing any
 * of these. Every rule is checked again on the server.
 */

const inputClass = '[&_input]:h-12 [&_input]:text-base md:[&_input]:h-11 md:[&_input]:text-sm';

/** The smaller of two amounts, as the likeliest amount to apply. */
const smaller = (a: string, b: string) => filsToString(Math.min(toFils(a), toFils(b)));

/** How the money was paid: the payment modes when set up, else method and account. */
function HowPaid({
  id,
  modes,
  moneyAccounts,
  label,
  accountLabel,
  errors,
}: {
  id: string;
  modes: PaymentModeOption[];
  moneyAccounts: AccountChoice[];
  label: string;
  accountLabel: string;
  errors: Record<string, string>;
}) {
  if (modes.length) {
    return (
      <PaymentModeField
        id={id}
        modes={modes}
        label={label}
        error={errors.method ?? errors.accountId}
      />
    );
  }
  return (
    <>
      <Field label={label} htmlFor={`${id}-method`} required error={errors.method}>
        <NativeSelect
          id={`${id}-method`}
          name="method"
          required
          defaultValue="CASH"
          className="h-12 text-base md:h-11 md:text-sm"
        >
          {PAYMENT_METHODS.map((method) => (
            <option key={method.value} value={method.value}>
              {method.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {moneyAccounts.length ? (
        <MoneyAccountField
          id={`${id}-account`}
          name="accountId"
          label={accountLabel}
          accounts={moneyAccounts}
          error={errors.accountId}
        />
      ) : null}
    </>
  );
}

// ─── Receive ────────────────────────────────────────────────────────────────

/** Money a customer pays before their invoice — always towards one of their job cards. */
export function ReceiveAdvanceForm({
  initialCustomer,
  initialVehicleId = '',
  initialJobCardId = '',
  pinnedJobCard = null,
  modes,
  moneyAccounts,
  today,
}: {
  initialCustomer: CustomerOption | null;
  initialVehicleId?: string;
  initialJobCardId?: string;
  /** Opened from a job card: offered even if it is no longer open. */
  pinnedJobCard?: { id: string; jobNumber: string; vehicleId: string } | null;
  modes: PaymentModeOption[];
  moneyAccounts: AccountChoice[];
  today: string;
}) {
  const [picked, setPicked] = useState<PickedParty | null>(
    initialCustomer
      ? {
          customer: initialCustomer,
          vehicleId:
            initialVehicleId ||
            (initialCustomer.vehicles.length === 1 ? initialCustomer.vehicles[0].id : ''),
          jobCardId: initialJobCardId,
        }
      : null,
  );
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(receiveAdvanceAction, {
    ok: false,
  });
  const errors = state.fieldErrors ?? {};

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-8">
      <input type="hidden" name="customerId" value={picked?.customer.id ?? ''} />
      <input type="hidden" name="vehicleId" value={picked?.vehicleId ?? ''} />
      <input type="hidden" name="jobCardId" value={picked?.jobCardId ?? ''} />

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold tracking-tight">Who paid it?</h2>
        <CustomerPicker
          value={picked}
          onChange={setPicked}
          requireJobCard
          pinnedJobCard={pinnedJobCard}
          autoFocus={!initialCustomer}
        />
        <FormError message={errors.customerId ?? errors.vehicleId ?? errors.jobCardId} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold tracking-tight">The money</h2>
        <div className="grid gap-6 md:grid-cols-2">
          <TextField
            label="Amount received (AED)"
            name="amount"
            numeric="money"
            required
            error={errors.amount}
            className={inputClass}
          />
          <TextField
            label="Received on"
            name="receivedOn"
            type="date"
            required
            defaultValue={today}
            max={today}
            error={errors.receivedOn}
            className={inputClass}
          />
          <HowPaid
            id="advance-receive"
            modes={modes}
            moneyAccounts={moneyAccounts}
            label="Received by"
            accountLabel="Deposited into"
            errors={errors}
          />
          <ReferenceField
            label="Reference"
            name="reference"
            error={errors.reference}
            hint="Optional: receipt, card slip, transfer or cheque number."
            className={inputClass}
          />
          <TextField
            label="What it is for"
            name="notes"
            error={errors.notes}
            hint="Optional, e.g. Advance for repair."
            className={`md:col-span-2 ${inputClass}`}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          The amount includes VAT (AED 3,000 at 5% is 2,857.14 + 142.86 VAT). In the UAE, VAT on
          an advance is due the day it is received; when the advance is applied to the job&apos;s
          invoice, that VAT is taken off again so it is never counted twice.
        </p>
      </section>

      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div className="border-t border-border pt-4">
        <SubmitButton
          pending={isPending}
          size="lg"
          className="h-12 w-full sm:h-11 sm:w-auto"
          pendingLabel="Recording…"
          disabled={!picked?.jobCardId}
        >
          <HandCoins />
          Record advance
        </SubmitButton>
      </div>
    </form>
  );
}

// ─── Apply ──────────────────────────────────────────────────────────────────

interface ApplyChoice {
  id: string;
  label: string;
  hint?: string;
  /** What is left on the advance, or due on the invoice. */
  max: string;
}

/**
 * Applying an advance to an invoice. From the invoice, the choice is which
 * of the customer's advances; from the advance, which of their invoices.
 */
export function ApplyAdvanceForm({
  side,
  fixedId,
  fixedMax,
  choices,
  defaultChoiceId,
  today,
}: {
  /** "invoice": on an invoice, choosing the advance. "advance": on an advance, choosing the invoice. */
  side: 'invoice' | 'advance';
  /** The invoice (side "invoice") or the advance (side "advance") it is on. */
  fixedId: string;
  /** Due on that invoice, or left on that advance. */
  fixedMax: string;
  choices: ApplyChoice[];
  defaultChoiceId?: string;
  today: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const first = choices.find((choice) => choice.id === defaultChoiceId) ?? choices[0];
  const [choiceId, setChoiceId] = useState(first?.id ?? '');
  const chosen = choices.find((choice) => choice.id === choiceId);
  const [amount, setAmount] = useState(first ? smaller(first.max, fixedMax) : '');
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const advanceId = side === 'invoice' ? choiceId : fixedId;
      const result = await applyAdvanceAction(advanceId, prev, formData);
      if (result.ok) {
        toast.success('Advance applied');
        formRef.current?.reset();
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const invoiceId = side === 'invoice' ? fixedId : choiceId;

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-6">
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="grid gap-6 md:grid-cols-3">
        <Field
          label={side === 'invoice' ? 'Advance' : 'Invoice'}
          htmlFor={`apply-choice-${fixedId}`}
          required
          error={side === 'invoice' ? undefined : errors.invoiceId}
          hint={chosen?.hint}
        >
          <NativeSelect
            id={`apply-choice-${fixedId}`}
            value={choiceId}
            onChange={(event) => {
              setChoiceId(event.target.value);
              const next = choices.find((choice) => choice.id === event.target.value);
              if (next) setAmount(smaller(next.max, fixedMax));
            }}
            className="h-12 text-base md:h-11 md:text-sm"
          >
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <TextField
          label="Amount to apply (AED)"
          name="amount"
          numeric="money"
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          error={errors.amount}
          hint={
            chosen
              ? side === 'invoice'
                ? `Up to ${formatMoney(smaller(chosen.max, fixedMax))}: ${formatMoney(chosen.max)} left on the advance, ${formatMoney(fixedMax)} due.`
                : `Up to ${formatMoney(smaller(chosen.max, fixedMax))}: ${formatMoney(chosen.max)} due, ${formatMoney(fixedMax)} left on the advance.`
              : undefined
          }
          className={inputClass}
        />
        <TextField
          label="Applied on"
          name="allocatedOn"
          type="date"
          required
          defaultValue={today}
          max={today}
          error={errors.allocatedOn}
          className={inputClass}
        />
      </div>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} className="h-11" pendingLabel="Applying…">
          <Link2 />
          Apply advance
        </SubmitButton>
      </div>
    </form>
  );
}

/** Undoes an application entered in error: the money goes back on the advance. */
export function UndoApplicationButton({
  allocationId,
  label,
}: {
  allocationId: string;
  label: string;
}) {
  return (
    <ReasonAction
      trigger={
        <Button variant="ghost" size="sm">
          <Undo2 />
          Undo
        </Button>
      }
      title={`Undo ${label}?`}
      description="It stays on record, marked undone. The money goes back on the advance and is owed again on the invoice."
      placeholder="e.g. Applied to the wrong invoice."
      confirmLabel="Undo application"
      successMessage="Application undone"
      onConfirm={(input) => undoApplicationAction(allocationId, input)}
    />
  );
}

// ─── Refund ─────────────────────────────────────────────────────────────────

/** Paying part or all of what is left on an advance back to the customer. */
export function RefundAdvanceForm({
  advanceId,
  left,
  modes,
  moneyAccounts,
  today,
}: {
  advanceId: string;
  left: string;
  modes: PaymentModeOption[];
  moneyAccounts: AccountChoice[];
  today: string;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await refundAdvanceAction(advanceId, prev, formData);
      if (result.ok) {
        toast.success('Refund recorded');
        formRef.current?.reset();
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="grid gap-6 md:grid-cols-2">
        <TextField
          label="Amount paid back (AED)"
          name="amount"
          numeric="money"
          required
          defaultValue={left}
          error={errors.amount}
          hint={`${formatMoney(left)} is left on the advance.`}
          className={inputClass}
        />
        <TextField
          label="Refunded on"
          name="refundedOn"
          type="date"
          required
          defaultValue={today}
          max={today}
          error={errors.refundedOn}
          className={inputClass}
        />
        <HowPaid
          id={`advance-refund-${advanceId}`}
          modes={modes}
          moneyAccounts={moneyAccounts}
          label="Paid back by"
          accountLabel="Paid from"
          errors={errors}
        />
        <ReferenceField
          label="Reference"
          name="reference"
          error={errors.reference}
          hint="Optional: transfer or cheque number."
          className={inputClass}
        />
      </div>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} className="h-11" pendingLabel="Recording…">
          <Wallet />
          Record refund
        </SubmitButton>
      </div>
    </form>
  );
}

/** Reverses a refund recorded in error. */
export function ReverseRefundButton({ refundId, label }: { refundId: string; label: string }) {
  return (
    <ReasonAction
      trigger={
        <Button variant="ghost" size="sm">
          <Undo2 />
          Reverse
        </Button>
      }
      title={`Reverse the refund of ${label}?`}
      description="It stays on record, marked reversed, and the money is back on the advance."
      placeholder="e.g. Recorded twice."
      confirmLabel="Reverse refund"
      successMessage="Refund reversed"
      onConfirm={(input) => reverseRefundAction(refundId, input)}
    />
  );
}

/** Cancels an advance entered in error, before any of it is used. */
export function CancelAdvanceButton({ advanceId, label }: { advanceId: string; label: string }) {
  return (
    <ReasonAction
      trigger={
        <Button variant="outline" size="lg">
          <Ban />
          Cancel advance
        </Button>
      }
      title={`Cancel ${label}?`}
      description="Only for an advance entered by mistake. It stays on record, marked cancelled, and its entry is reversed. Its number is not reused."
      placeholder="e.g. Entered for the wrong customer."
      confirmLabel="Cancel advance"
      successMessage={`${label} cancelled`}
      onConfirm={(input) => cancelAdvanceAction(advanceId, input)}
    />
  );
}
