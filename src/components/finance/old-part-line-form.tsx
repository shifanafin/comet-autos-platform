'use client';

import { useState } from 'react';
import { Archive, PackageMinus, Wrench } from 'lucide-react';
import { Field, FormError, NativeSelect } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { Button } from '@/components/ui/button';
import { formatDate, formatMoney } from '@/lib/format';
import type { ActionResult } from '@/lib/errors';
import type { OldPartLines } from '@/lib/inventory/old-part-lines';
import { cn } from '@/lib/utils';
import { settleOldPartLineAction } from '@/app/(app)/reports/job-profit/old-parts/actions';

/*
 * One old Parts line, settled one of three ways (lib/inventory/
 * old-part-lines.ts): tied to the write-off its part already left stock on,
 * taken out of stock now, or turned into a Labour line.
 */

type Line = OldPartLines['open'][number];
type WriteOffs = OldPartLines['writeOffs'];
type How = 'WRITE_OFF' | 'STOCK' | 'WORK';

const CHOICES: { how: How; title: string; note: string; Icon: typeof Archive }[] = [
  {
    how: 'WRITE_OFF',
    title: 'Already written off',
    note: 'Its part left stock on an old write-off. Its cost is already in the books.',
    Icon: Archive,
  },
  {
    how: 'STOCK',
    title: 'Take it out of stock now',
    note: 'The part still shows on the shelf. It leaves stock and its cost is booked.',
    Icon: PackageMinus,
  },
  {
    how: 'WORK',
    title: 'It was work, not a part',
    note: 'Labour or a service. It moves to labour sales; the total and VAT stay.',
    Icon: Wrench,
  },
];

function writeOffLabel(off: WriteOffs[string]) {
  return `${off.partName} — ${formatMoney(off.unitCost)} each · ${off.left} left · ${formatDate(off.date)}`;
}

export function OldPartLineForm({ line, writeOffs }: { line: Line; writeOffs: WriteOffs }) {
  const hasWriteOffs = line.likely.length + line.others.length > 0;
  const available: Record<How, boolean> = {
    WRITE_OFF: hasWriteOffs,
    STOCK: !line.rebookBlocker && line.inStock.length > 0,
    WORK: !line.rebookBlocker,
  };
  const [how, setHow] = useState<How | null>(
    line.likely.length ? 'WRITE_OFF' : null,
  );
  const [movementId, setMovementId] = useState(line.likely[0] ?? '');
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(settleOldPartLineAction, {
    ok: false,
  });
  const chosen = movementId ? writeOffs[movementId] : undefined;

  return (
    <form onSubmit={onSubmit} className="@container flex flex-col gap-4">
      <input type="hidden" name="itemId" value={line.id} />
      <input type="hidden" name="how" value={how ?? ''} />
      <div className="grid gap-2 @lg:grid-cols-3" role="radiogroup" aria-label="What this line was">
        {CHOICES.map(({ how: value, title, note, Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={how === value}
            disabled={!available[value]}
            onClick={() => setHow(value)}
            className={cn(
              'flex min-w-0 items-start gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
              how === value ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted',
              'disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-card',
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="font-medium">{title}</span>
              <span className="text-xs text-muted-foreground">{note}</span>
            </span>
          </button>
        ))}
      </div>
      {line.rebookBlocker ? (
        <p className="text-xs text-muted-foreground">{line.rebookBlocker}</p>
      ) : null}

      {how === 'WRITE_OFF' ? (
        <Field
          label="The write-off its part left stock on"
          htmlFor={`movement-${line.id}`}
          hint={
            chosen?.note
              ? `Noted: “${chosen.note}”`
              : 'Likely ones first: a note naming this invoice, or a part named like the line.'
          }
          className="max-w-xl"
        >
          <NativeSelect
            id={`movement-${line.id}`}
            name="movementId"
            value={movementId}
            onChange={(event) => setMovementId(event.target.value)}
            required
          >
            <option value="">Choose the write-off</option>
            {line.likely.length ? (
              <optgroup label="Likely">
                {line.likely.map((id) => (
                  <option key={id} value={id}>
                    {writeOffLabel(writeOffs[id])}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {line.others.length ? (
              <optgroup label="Other write-offs">
                {line.others.map((id) => (
                  <option key={id} value={id}>
                    {writeOffLabel(writeOffs[id])}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </NativeSelect>
        </Field>
      ) : null}

      {how === 'STOCK' ? (
        <Field
          label="The part it was"
          htmlFor={`part-${line.id}`}
          hint="Costed at the part's last purchase cost, on the invoice's date."
          className="max-w-xl"
        >
          <NativeSelect id={`part-${line.id}`} name="partId" defaultValue="" required>
            <option value="">Choose the part</option>
            {line.inStock.map((part) => (
              <option key={part.id} value={part.id}>
                {`${part.name} — ${formatMoney(part.unitCost)} · ${part.onHand} on hand`}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}

      <FormError message={state.error} />
      {how ? (
        <div>
          <SubmitButton pending={isPending} pendingLabel="Saving…">
            {how === 'WRITE_OFF'
              ? 'Cost it at this write-off'
              : how === 'STOCK'
                ? 'Take it out of stock'
                : 'Make it a Labour line'}
          </SubmitButton>
        </div>
      ) : null}
    </form>
  );
}

/** Unties a line from the write-off it was costed at. */
export function UndoWriteOffCost({ itemId }: { itemId: string }) {
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(settleOldPartLineAction, {
    ok: false,
  });
  return (
    <form onSubmit={onSubmit} className="flex flex-col items-end gap-1">
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="how" value="UNDO" />
      <Button type="submit" variant="ghost" size="sm" disabled={isPending}>
        {isPending ? 'Undoing…' : 'Undo'}
      </Button>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}
