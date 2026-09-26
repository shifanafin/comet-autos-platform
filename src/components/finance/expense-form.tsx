'use client';

import { useRouter } from 'next/navigation';
import { Plus, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import { recordExpenseAction, updateExpenseAction } from '@/app/(app)/finance/actions';
import { localDateString } from '@/lib/format';

/** An expense being corrected, as the form's starting values. */
export interface ExpenseDraft {
  id: string;
  description: string;
  amount: string;
  taxRate: string;
  /** YYYY-MM-DD */
  expenseDate: string;
  vendorName: string;
  paymentMethod: string;
  categoryId: string;
}

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

/** Today in the workshop's own date terms, for the date field's default. */
function today() {
  return localDateString();
}

export function ExpenseForm({
  categories,
  defaultVatRate,
  expense,
  onDone,
}: {
  categories: { id: string; accountCode: string; accountName: string }[];
  defaultVatRate: string;
  /** Set to correct an existing expense instead of recording a new one. */
  expense?: ExpenseDraft;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = expense
        ? await updateExpenseAction(expense.id, prev, formData)
        : await recordExpenseAction(prev, formData);
      if (result.ok) {
        toast.success(expense ? 'Expense updated' : 'Expense recorded');
        router.refresh();
        onDone?.();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  // Unique ids, so an edit dialog can sit on the same page as the record form.
  const id = (name: string) => (expense ? name + '-' + expense.id : name);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <TextField
        label="What was it for?"
        id={id('description')}
        name="description"
        required
        defaultValue={expense?.description}
        placeholder="e.g. Monthly workshop rent — October"
        error={errors.description}
        className={INPUT}
      />

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Category" htmlFor={id('categoryId')} error={errors.categoryId}>
          <NativeSelect
            id={id('categoryId')}
            name="categoryId"
            defaultValue={expense?.categoryId ?? ''}
            className="h-11 text-base md:text-sm"
          >
            <option value="">Uncategorised</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.accountName}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <TextField
          label="Date"
          id={id('expenseDate')}
          name="expenseDate"
          type="date"
          required
          defaultValue={expense?.expenseDate ?? today()}
          error={errors.expenseDate}
          className={INPUT}
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <TextField
          label="Amount excluding VAT"
          id={id('amount')}
          name="amount"
          inputMode="decimal"
          required
          defaultValue={expense?.amount}
          placeholder="0.00"
          error={errors.amount}
          hint="In AED."
          className={`${INPUT} [&_input]:text-right [&_input]:tabular-nums`}
        />
        <TextField
          label="VAT rate"
          id={id('taxRate')}
          name="taxRate"
          inputMode="decimal"
          defaultValue={expense ? expense.taxRate : defaultVatRate.replace(/\.?0+$/, '')}
          error={errors.taxRate}
          hint="Leave empty if the expense carries no VAT."
          className={`${INPUT} [&_input]:text-right [&_input]:tabular-nums`}
        />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <TextField
          label="Paid to"
          id={id('vendorName')}
          name="vendorName"
          defaultValue={expense?.vendorName}
          placeholder="e.g. the landlord or utility company"
          error={errors.vendorName}
          className={INPUT}
        />
        <Field
          label="Paid by"
          htmlFor={id('paymentMethod')}
          error={errors.paymentMethod}
          hint="Leave empty if it has not been paid yet."
        >
          <NativeSelect
            id={id('paymentMethod')}
            name="paymentMethod"
            defaultValue={expense?.paymentMethod ?? ''}
            className="h-11 text-base md:text-sm"
          >
            <option value="">Not settled yet</option>
            <option value="CASH">Cash</option>
            <option value="CARD">Card</option>
            <option value="BANK_TRANSFER">Bank transfer</option>
            <option value="CHEQUE">Cheque</option>
            <option value="ONLINE">Online</option>
          </NativeSelect>
        </Field>
      </div>

      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div className="border-t border-border pt-4">
        <SubmitButton
          pending={isPending}
          size="lg"
          className="h-11"
          pendingLabel={expense ? 'Saving…' : 'Recording…'}
        >
          {expense ? <Save /> : <Plus />}
          {expense ? 'Save changes' : 'Record expense'}
        </SubmitButton>
      </div>
    </form>
  );
}
