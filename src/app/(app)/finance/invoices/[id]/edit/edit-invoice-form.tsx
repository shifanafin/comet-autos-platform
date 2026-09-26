'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Save } from 'lucide-react';
import { FormError, TextareaField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import {
  DocumentLinesEditor,
  isBlankLine,
  useLineTotals,
  type EditableLine,
} from '@/components/workshop/document-lines-editor';
import { formatMoney } from '@/lib/format';
import type { ActionResult } from '@/lib/errors';
import { updateInvoiceAction } from '../../actions';

export function EditInvoiceForm({
  invoiceId,
  lines: initialLines,
  notes,
  defaultVatRate,
}: {
  invoiceId: string;
  lines: EditableLine[];
  notes: string;
  defaultVatRate: string;
}) {
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    (prev, formData) => updateInvoiceAction(invoiceId, prev, formData),
    { ok: false },
  );
  const [lines, setLines] = useState<EditableLine[]>(initialLines);
  const { totals, incomplete, count } = useLineTotals(lines, defaultVatRate);
  const errors = state.fieldErrors ?? {};

  const payload = JSON.stringify(
    lines
      .filter((line) => !isBlankLine(line))
      .map(({ itemType, description, quantity, unitPrice, taxRate }) => ({
        itemType,
        description,
        quantity,
        unitPrice,
        taxRate,
      })),
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-8">
      <input type="hidden" name="items" value={payload} />
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold tracking-tight">What is being billed</h2>
        <DocumentLinesEditor lines={lines} onChange={setLines} defaultVatRate={defaultVatRate} />
      </section>

      <TextareaField
        label="Notes on the invoice"
        name="notes"
        defaultValue={notes}
        error={errors.notes}
        hint="Optional — shown to the customer."
        className="[&_textarea]:min-h-16"
      />

      <FormError message={state.error ?? errors.items} />

      <div className="flex flex-col gap-3 border-t border-border pt-6 sm:flex-row sm:items-center">
        <SubmitButton
          pending={isPending}
          size="lg"
          disabled={count === 0 || incomplete}
          className="h-12 w-full sm:h-11 sm:w-auto"
          pendingLabel="Saving…"
        >
          <Save />
          Save invoice
          {count > 0 && !incomplete ? ` · ${formatMoney(totals.totalAmount)}` : ''}
        </SubmitButton>
        <Link
          href={`/finance/invoices/${invoiceId}`}
          className="inline-flex h-11 items-center justify-center rounded-lg px-4 text-sm font-medium text-muted-foreground hover:bg-muted"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
