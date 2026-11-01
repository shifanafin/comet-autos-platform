'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Scale } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { convertPartUnitAction } from '@/app/(app)/inventory/actions';
import type { ActionResult } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { formatMilli, toMilli } from '@/lib/money';
import { pricePerUnit } from '@/lib/inventory/pack';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';
const SMALL_UNITS = ['litre', 'kg', 'metre'];

/** What is left if every piece on hand is still full; '' until the size is valid. */
function fullStock(onHandMilli: number, size: string) {
  try {
    const sizeMilli = toMilli(size);
    return sizeMilli > 0 ? formatMilli(Math.round((onHandMilli * sizeMilli) / 1000)) : '';
  } catch {
    return '';
  }
}

/**
 * Moves a part from pieces to litres or kg (lib/inventory/unit-conversion.ts):
 * how much one holds and how much is really left, with the new prices shown
 * before anything is saved.
 */
export function ConvertPartUnitButton({
  partId,
  unit,
  onHandMilli,
  cost,
  selling,
}: {
  partId: string;
  unit: string;
  onHandMilli: number;
  cost: string | null;
  selling: string | null;
}) {
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [newUnit, setNewUnit] = useState(SMALL_UNITS.find((u) => u !== unit) ?? 'litre');
  const [size, setSize] = useState('');
  const [typedLeft, setTypedLeft] = useState<string | null>(null);
  const left = typedLeft ?? fullStock(onHandMilli, size);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await convertPartUnitAction(partId, prev, formData);
      if (result.ok) {
        toast.success(`Now kept by the ${newUnit}`);
        router.refresh();
        setOpen(false);
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const newCost = cost ? pricePerUnit(cost, size) : null;
  const newSelling = selling ? pricePerUnit(selling, size) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="lg" onClick={() => setOpen(true)}>
        <Scale />
        Change unit
      </Button>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keep this part by the litre or kg</DialogTitle>
          <DialogDescription>
            For something shared across cars, so each job uses only what it took. Past documents
            keep the quantities they were written in.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="New unit" htmlFor={`${id}-unit`} error={errors.unit}>
              <NativeSelect
                id={`${id}-unit`}
                name="unit"
                value={newUnit}
                onChange={(event) => setNewUnit(event.target.value)}
                className="h-11 text-base md:text-sm"
              >
                {SMALL_UNITS.filter((option) => option !== unit).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <TextField
              id={`${id}-size`}
              label={`One ${unit} holds (${newUnit})`}
              name="size"
              numeric="quantity"
              required
              value={size}
              onChange={(event) => setSize(event.target.value)}
              placeholder="3"
              error={errors.size}
              className={INPUT}
            />
            <TextField
              id={`${id}-left`}
              label={`Really left now (${newUnit})`}
              name="remaining"
              numeric="quantity"
              required
              value={left}
              onChange={(event) => setTypedLeft(event.target.value)}
              error={errors.remaining}
              hint={`${formatMilli(onHandMilli)} ${unit} on hand. Lower this if one is already open.`}
              className={`${INPUT} sm:col-span-2`}
            />
          </div>
          {newCost || newSelling ? (
            <dl className="flex flex-col gap-1.5 rounded-lg bg-muted/50 p-3 text-sm">
              {newCost ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{`New cost per ${newUnit}`}</dt>
                  <dd className="tabular-nums">{formatMoney(newCost)}</dd>
                </div>
              ) : null}
              {newSelling ? (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">{`New selling price per ${newUnit}`}</dt>
                  <dd className="tabular-nums">{formatMoney(newSelling)}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <FormError message={Object.keys(errors).length ? undefined : state.error} />
          <div className="border-t border-border pt-4">
            <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Changing…">
              <Scale />
              Change unit
            </SubmitButton>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
