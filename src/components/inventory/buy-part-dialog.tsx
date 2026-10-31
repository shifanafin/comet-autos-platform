'use client';

import { useState } from 'react';
import { ShoppingCart } from 'lucide-react';
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
import { NewSupplierDialog } from '@/components/inventory/new-supplier-dialog';
import {
  ConfirmNewPart,
  INPUT,
  SimilarParts,
  StockBadge,
  UNITS,
  useLikelySame,
  usePartCatalog,
} from '@/components/inventory/part-picker';
import type { ActionResult } from '@/lib/errors';
import type { PartOption } from '@/lib/inventory/part-options';
import { calculateLine, filsToString } from '@/lib/money';
import { formatMoney, localDateString } from '@/lib/format';
import { cn } from '@/lib/utils';
import { buyPartForJobAction, type BoughtPart } from '@/app/(app)/inventory/actions';
import { PriceBasisToggle } from '@/components/forms/price-basis-toggle';
import { fitInclusivePrice, inclusiveOf, type PriceBasis } from '@/lib/vat-entry';

/*
 * "Bought for this job" — from an invoice line, when the part is not in
 * stock (or not in the parts list at all) because someone just bought it
 * from the shop nearby. One short form records what happened: which part,
 * from which shop, how many, what was paid, and whether the shop's tax
 * invoice is in hand yet. Saving adds the part if it is new, records the
 * purchase received into stock and the payment — and the line is ready to
 * sell it, at that cost.
 *
 * A part typed that is already in the list under another spelling is shown
 * first ("Did you mean…?"), so the list never gets a second copy.
 */

type Paid = 'cash' | 'bank' | 'later';

export function BuyPartDialog({
  part,
  name = '',
  quantity,
  sellingPrice = '',
  onClose,
  onDone,
  onUseExisting,
}: {
  /** The part, when it is in the list and only the stock is short. */
  part?: PartOption | null;
  /** A new part: the name typed on the line. */
  name?: string;
  /** How many to record as bought (what the line is short of). */
  quantity: string;
  /** The line's price, for a new part's selling price. */
  sellingPrice?: string;
  onClose: () => void;
  /** Recorded: the part with its new stock, and what one cost. */
  onDone: (bought: BoughtPart) => void;
  /** "Did you mean…?" — an existing part chosen instead of adding one. */
  onUseExisting: (part: PartOption) => void;
}) {
  const catalog = usePartCatalog();
  const canPay = Boolean(catalog?.canPay);
  const [state, onSubmit, isPending] = useFormAction<ActionResult<BoughtPart>>(
    async (prev, formData) => {
      const result = await buyPartForJobAction(prev, formData);
      if (result.ok && result.data) {
        catalog?.add(result.data.part);
        toast.success(
          `${result.data.purchaseNumber} recorded — ${result.data.part.name} is in stock${result.data.billAwaited ? '. Its tax invoice is awaited under Bills to match.' : '.'}`,
        );
        onDone(result.data);
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};

  const [typedName, setTypedName] = useState(name);
  const [typedSku, setTypedSku] = useState('');
  const likelySame = useLikelySame(part ? '' : typedName, part ? '' : typedSku);
  const [supplierId, setSupplierId] = useState(part?.supplierId ?? '');
  const [addingSupplier, setAddingSupplier] = useState<string | null>(null);
  const [count, setCount] = useState(quantity || '1');
  const [typedCost, setTypedCost] = useState(part?.cost ?? '');
  const [basis, setBasis] = useState<PriceBasis>('EXCLUSIVE');
  const rate = catalog?.defaultVat || '5';
  const standardVat = rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate;
  const [vat, setVat] = useState(
    part?.taxRate && Number(part.taxRate) === 0 ? '0' : standardVat,
  );
  const inclusive = basis === 'INCLUSIVE';
  const fit = inclusive ? fitInclusivePrice(typedCost, count, vat) : null;
  /** The price for one before VAT, as it is sent. */
  const cost = inclusive ? (fit?.unitPrice ?? '') : typedCost;
  const [paid, setPaid] = useState<Paid>(canPay ? 'cash' : 'later');
  const [unit, setUnit] = useState(part?.unit ?? 'piece');

  // What the shop was paid, VAT included — by the same rules the purchase is priced with.
  let total: string | null = null;
  try {
    if (cost) {
      const line = calculateLine({ quantity: count, unitPrice: cost, taxRate: vat });
      total = filsToString(line.lineTotalFils + line.taxFils);
    }
  } catch {
    total = null;
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Bought for this job</DialogTitle>
          <DialogDescription>
            {part
              ? 'Record the purchase from the shop — the part comes into stock, and this line sells it at the price paid.'
              : 'Add the part and record where it was bought — it comes into stock, and this line sells it at the price paid.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.stopPropagation();
            onSubmit(event);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex flex-col gap-5"
        >
          <input type="hidden" name="partId" value={part?.id ?? ''} />
          <input type="hidden" name="paid" value={paid} />

          {part ? (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
              <span className="min-w-0">
                <span className="block truncate font-medium">{part.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  <span className="font-mono">{part.sku}</span>
                  {part.supplierName ? ` · usually from ${part.supplierName}` : ''}
                </span>
              </span>
              <StockBadge part={part} />
            </div>
          ) : (
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                id="buy-part-name"
                label="Part name"
                name="name"
                required
                autoFocus
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                error={errors.name}
                className={cn(INPUT, 'sm:col-span-2')}
              />
              <div className="sm:col-span-2">
                <SimilarParts name={typedName} sku={typedSku} onUse={onUseExisting} />
              </div>
              <TextField
                id="buy-part-sku"
                label="Code / part number"
                name="sku"
                value={typedSku}
                onChange={(event) => setTypedSku(event.target.value)}
                error={errors.sku}
                hint="Optional — numbered automatically if blank."
                className={INPUT}
              />
              <Field label="Unit" htmlFor="buy-part-unit" error={errors.unitOfMeasure}>
                <NativeSelect
                  id="buy-part-unit"
                  name="unitOfMeasure"
                  value={unit}
                  onChange={(event) => setUnit(event.target.value)}
                  className="h-11 text-base md:text-sm"
                >
                  {UNITS.map((option) => (
                    <option key={option.unit} value={option.unit}>
                      {option.unit}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <input type="hidden" name="sellingPrice" value={sellingPrice} />
              {likelySame || errors.name ? (
                <div className="sm:col-span-2">
                  <ConfirmNewPart />
                </div>
              ) : null}
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Bought from"
              htmlFor="buy-part-supplier"
              required
              error={errors.supplierId}
              className="sm:col-span-2"
            >
              <NativeSelect
                id="buy-part-supplier"
                name="supplierId"
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                onCreate={(typed) => setAddingSupplier(typed)}
                createLabel="Add new shop"
                className="h-11 text-base md:text-sm"
              >
                <option value="">Choose the shop</option>
                {(catalog?.suppliers ?? []).map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <PriceBasisToggle
              label="The shop's price is"
              value={basis}
              className="sm:col-span-2"
              onChange={(next) => {
                if (next === basis) return;
                setTypedCost(next === 'INCLUSIVE' && cost ? inclusiveOf(cost, vat) : cost);
                setBasis(next);
              }}
            />
            {inclusive ? <input type="hidden" name="unitCost" value={cost} /> : null}
            <TextField
              id="buy-part-quantity"
              label={`How many (${unit})`}
              name="quantity"
              numeric="quantity"
              required
              value={count}
              onChange={(event) => setCount(event.target.value)}
              error={errors.quantity}
              className={INPUT}
            />
            <TextField
              id="buy-part-cost"
              label="Price paid for one"
              name={inclusive ? 'unitCostIncludingVat' : 'unitCost'}
              numeric="money"
              required
              placeholder="0.00"
              value={typedCost}
              onChange={(event) => setTypedCost(event.target.value)}
              error={errors.unitCost}
              hint={
                !inclusive
                  ? 'Before VAT.'
                  : fit && !fit.exact
                    ? `Includes VAT. Comes to ${formatMoney(fit.actual)}, not ${formatMoney(fit.wanted)}: VAT rounds to the fil.`
                    : 'Includes VAT.'
              }
              className={INPUT}
            />
            <Field label="VAT on the shop's bill" htmlFor="buy-part-vat" error={errors.taxRate}>
              <NativeSelect
                id="buy-part-vat"
                name="taxRate"
                value={vat}
                onChange={(event) => setVat(event.target.value)}
                className="h-11 text-base md:text-sm"
              >
                <option value={standardVat}>{standardVat}% VAT</option>
                {standardVat !== '0' ? <option value="0">No VAT</option> : null}
              </NativeSelect>
            </Field>
            <p className="flex items-end pb-2 text-sm text-muted-foreground">
              {total ? (
                <span>
                  Total paid <span className="font-semibold text-foreground tabular-nums">{formatMoney(total)}</span>
                </span>
              ) : null}
            </p>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Paid?</legend>
            <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Paid">
              {(
                [
                  ['cash', 'Paid in cash', 'From Cash on hand'],
                  ['bank', 'Paid by bank / card', 'From the bank'],
                  ['later', 'Not paid yet', 'Owed to the shop'],
                ] as const
              )
                .filter(([value]) => canPay || value === 'later')
                .map(([value, title, note]) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={paid === value}
                    onClick={() => setPaid(value)}
                    className={cn(
                      'flex flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                      paid === value ? 'border-primary bg-primary/5' : 'border-border bg-card hover:bg-muted',
                    )}
                  >
                    <span className="font-medium">{title}</span>
                    <span className="text-xs text-muted-foreground">{note}</span>
                  </button>
                ))}
            </div>
            {errors.paid || errors.method ? (
              <p className="text-xs font-medium text-destructive">{errors.paid ?? errors.method}</p>
            ) : null}
          </fieldset>

          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id="buy-part-bill"
              label="Shop's tax invoice no."
              name="supplierInvoiceNumber"
              error={errors.supplierInvoiceNumber}
              hint="Only if you have it now. Blank: it waits under Bills to match."
              className={INPUT}
            />
            <TextField
              id="buy-part-date"
              label="Bought on"
              name="supplierInvoiceDate"
              type="date"
              max={localDateString()}
              defaultValue={localDateString()}
              error={errors.supplierInvoiceDate}
              className={INPUT}
            />
          </div>

          <FormError message={state.error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton size="lg" pending={isPending} pendingLabel="Recording…">
              <ShoppingCart />
              Record purchase
            </SubmitButton>
          </div>
        </form>
        {addingSupplier !== null ? (
          <NewSupplierDialog
            name={addingSupplier}
            onClose={() => setAddingSupplier(null)}
            onCreated={(supplier) => {
              catalog?.addSupplier(supplier);
              setSupplierId(supplier.id);
              setAddingSupplier(null);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
