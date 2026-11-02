'use client';

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { PackagePlus, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
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
import type { ActionResult } from '@/lib/errors';
import type { PartCatalog, PartOption } from '@/lib/inventory/part-options';
import { formatMilli, signedToMilli } from '@/lib/money';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';
import { quickCreatePartAction } from '@/app/(app)/inventory/actions';
import { NewSupplierDialog, type SupplierChoice } from '@/components/inventory/new-supplier-dialog';
import { LIKELY_SAME, similarParts } from '@/lib/inventory/part-match';

/*
 * Picking a part for a line — on an invoice, a quotation or a purchase.
 * Typing shows the parts the workshop has that match, each with what is in
 * stock and its price; one tap fills the line. A part not in the catalogue
 * yet can be added from the same list, in a short form, without leaving the
 * page — it is then on the line and in the list for every other line.
 */

interface CatalogState extends PartCatalog {
  add: (part: PartOption) => void;
  addSupplier: (supplier: SupplierChoice) => void;
}

const CatalogContext = createContext<CatalogState | null>(null);

/** Holds the parts for every picker inside it, so a part added on one line is offered on all. */
export function PartCatalogProvider({
  catalog,
  onAdd,
  children,
}: {
  catalog: PartCatalog;
  /** Told of every part added or bought here (its stock as it now is). */
  onAdd?: (part: PartOption) => void;
  children: ReactNode;
}) {
  const [added, setAdded] = useState<PartOption[]>([]);
  const add = useCallback(
    (part: PartOption) => {
      setAdded((current) => [...current.filter((p) => p.id !== part.id), part]);
      onAdd?.(part);
    },
    [onAdd],
  );
  // Suppliers added on this page too, in name order with the rest.
  const [addedSuppliers, setAddedSuppliers] = useState<SupplierChoice[]>([]);
  const addSupplier = useCallback(
    (supplier: SupplierChoice) =>
      setAddedSuppliers((current) => [...current.filter((s) => s.id !== supplier.id), supplier]),
    [],
  );
  const value = useMemo(() => {
    const ids = new Set(added.map((part) => part.id));
    const supplierIds = new Set(addedSuppliers.map((supplier) => supplier.id));
    return {
      ...catalog,
      parts: [...catalog.parts.filter((part) => !ids.has(part.id)), ...added],
      suppliers: [
        ...catalog.suppliers.filter((supplier) => !supplierIds.has(supplier.id)),
        ...addedSuppliers,
      ].sort((a, b) => a.name.localeCompare(b.name)),
      add,
      addSupplier,
    };
  }, [catalog, added, add, addedSuppliers, addSupplier]);
  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
}

/** The catalogue around this component, or null outside a provider. */
export function usePartCatalog() {
  return useContext(CatalogContext);
}

/** Parts whose name or code holds every word typed. */
function matching(parts: PartOption[], query: string, exclude?: Set<string>, prefer?: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return parts
    .filter((part) => {
      if (exclude?.has(part.id)) return false;
      const haystack = `${part.name} ${part.sku} ${part.supplierName ?? ''}`.toLowerCase();
      return words.every((word) => haystack.includes(word));
    })
    .sort((a, b) => Number(b.supplierId === prefer) - Number(a.supplierId === prefer))
    .slice(0, 8);
}

/** "3 in stock" / "Out of stock". */
export function StockBadge({ part }: { part: PartOption }) {
  const milli = signedToMilli(part.stock);
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium whitespace-nowrap tabular-nums',
        milli > 0 ? 'bg-success/15 text-success' : 'bg-destructive/10 text-destructive',
      )}
    >
      {milli > 0
        ? `${formatMilli(milli)} ${part.unit === 'piece' ? '' : `${UNITS.find((option) => option.unit === part.unit)?.plural ?? part.unit} `}in stock`
        : 'Out of stock'}
    </span>
  );
}

const ADD_NEW = 'add-new' as const;
const NO_PARTS: PartOption[] = [];

/**
 * A text box that offers the catalogue's parts as you type.
 *
 * `text` mode (invoice and quotation lines): the box is the line's
 * description — anything can still be typed, and picking a part fills it.
 * `search` mode (purchases): the box only finds a part to add, and is
 * cleared by the caller once one is picked.
 */
export function PartPicker({
  value,
  onValueChange,
  onPick,
  mode = 'text',
  price = 'selling',
  exclude,
  preferSupplierId,
  defaultSupplierId,
  placeholder,
  className,
  onAddNew,
  'aria-label': ariaLabel,
}: {
  value: string;
  onValueChange: (value: string) => void;
  /**
   * A part picked from the list, or just added. For a part added from a
   * purchase, `quantity` is how many were bought — the purchase line's
   * quantity.
   */
  onPick: (part: PartOption, quantity?: string) => void;
  mode?: 'text' | 'search';
  /** Which price each part shows: what it sells for, or what it was bought at. */
  price?: 'selling' | 'cost';
  /** Parts not to offer (already on the purchase). */
  exclude?: Set<string>;
  /** This supplier's parts first. */
  preferSupplierId?: string;
  /** The supplier a part added from here is filed under. */
  defaultSupplierId?: string;
  placeholder?: string;
  className?: string;
  /**
   * Invoices: "Add new part" opens the caller's form instead (the part with
   * where it was bought), given what was typed.
   */
  onAddNew?: (typed: string) => void;
  'aria-label'?: string;
}) {
  const catalog = usePartCatalog();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(mode === 'search' ? 0 : -1);
  const [position, setPosition] = useState<CSSProperties | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const parts = catalog?.parts ?? NO_PARTS;
  const found = useMemo(
    () => matching(parts, value, exclude, preferSupplierId),
    [parts, value, exclude, preferSupplierId],
  );
  const canCreate = Boolean(onAddNew ? catalog?.canBuy : catalog?.canCreate);
  const rows: (PartOption | typeof ADD_NEW)[] = [...found, ...(canCreate ? [ADD_NEW] : [])];
  // Text mode stays quiet while a description matches nothing and nothing can be added.
  const shown = open && value.trim() !== '' && (found.length > 0 || canCreate || mode === 'search');

  // The list sits on the page itself, so a table that scrolls sideways never clips it.
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      const box = inputRef.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(Math.max(box.width, 340), window.innerWidth - 16);
      const left = Math.max(8, Math.min(box.left, window.innerWidth - width - 8));
      const below = window.innerHeight - box.bottom;
      const up = below < 260 && box.top > below;
      setPosition({
        position: 'fixed',
        left,
        width,
        ...(up
          ? { bottom: window.innerHeight - box.top + 4, maxHeight: box.top - 12 }
          : { top: box.bottom + 4, maxHeight: below - 12 }),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [shown]);

  function choose(row: PartOption | typeof ADD_NEW) {
    setOpen(false);
    if (row === ADD_NEW) {
      if (onAddNew) onAddNew(value.trim());
      else setAdding(value.trim());
    } else onPick(row);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActive((current) => Math.min(current + 1, rows.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, mode === 'search' ? 0 : -1));
    } else if (event.key === 'Escape' && shown) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Enter') {
      const row = shown && active >= 0 ? rows[active] : undefined;
      if (row) {
        // Picked from the list: Enter does nothing else (no next box, no submit).
        event.preventDefault();
        event.stopPropagation();
        choose(row);
      } else if (mode === 'search') {
        event.preventDefault();
        event.stopPropagation();
      } else {
        setOpen(false);
      }
    }
  }

  const priceOf = (part: PartOption) => {
    const amount = price === 'cost' ? part.cost : part.price;
    return amount ? formatMoney(amount) : price === 'cost' ? 'no cost' : 'no price';
  };

  return (
    <>
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value);
          setOpen(true);
          setActive(mode === 'search' ? 0 : -1);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-expanded={shown}
        aria-autocomplete="list"
        role="combobox"
        autoComplete="off"
        className={className}
      />
      {shown && position
        ? createPortal(
            <ul
              role="listbox"
              style={position}
              // Keep the focus in the box while a row is clicked.
              onMouseDown={(event) => event.preventDefault()}
              className="z-50 overflow-y-auto rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
            >
              {found.length === 0 ? (
                <li className="px-2.5 py-2 text-xs text-muted-foreground">
                  {onAddNew
                    ? 'Not in the parts list yet — add it below, with where it was bought.'
                    : mode === 'text'
                      ? 'No part in stock matches — keep typing to write your own description.'
                      : 'No part matches.'}
                </li>
              ) : null}
              {rows.map((row, index) =>
                row === ADD_NEW ? (
                  <li
                    key={ADD_NEW}
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(row)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-md border-t border-border px-2.5 py-2.5 text-sm font-medium text-primary',
                      index === active && 'bg-muted',
                    )}
                  >
                    <PackagePlus className="size-4 shrink-0" />
                    <span className="min-w-0 truncate">
                      Add new part{value.trim() ? ` “${value.trim()}”` : ''}
                    </span>
                  </li>
                ) : (
                  <li
                    key={row.id}
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(row)}
                    className={cn(
                      'flex cursor-pointer items-center justify-between gap-3 rounded-md px-2.5 py-2 text-sm',
                      index === active && 'bg-muted',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{row.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        <span className="font-mono">{row.sku}</span>
                        {row.supplierName ? ` · ${row.supplierName}` : ''}
                      </span>
                      {row.forJobs?.length ? (
                        <span className="block truncate text-xs font-medium text-primary">
                          {`For ${row.forJobs.join(', ')}`}
                        </span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {priceOf(row)}
                      </span>
                      <StockBadge part={row} />
                    </span>
                  </li>
                ),
              )}
            </ul>,
            document.body,
          )
        : null}
      {adding !== null ? (
        <NewPartDialog
          name={adding}
          defaultSupplierId={defaultSupplierId}
          forPurchase={mode === 'search'}
          onClose={() => setAdding(null)}
          onCreated={(part, quantity) => {
            setAdding(null);
            onPick(part, quantity);
          }}
          onUseExisting={(part) => {
            setAdding(null);
            onPick(part);
          }}
        />
      ) : null}
    </>
  );
}

/** The units a part is counted in, with how a count of them reads. */
export const UNITS: { unit: string; plural: string }[] = [
  { unit: 'piece', plural: 'pieces' },
  { unit: 'set', plural: 'sets' },
  { unit: 'pair', plural: 'pairs' },
  { unit: 'litre', plural: 'litres' },
  { unit: 'bottle', plural: 'bottles' },
  { unit: 'kg', plural: 'kg' },
  { unit: 'metre', plural: 'metres' },
  { unit: 'box', plural: 'boxes' },
];
export const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

/**
 * Parts already in the catalogue that look like the one being added —
 * "Did you mean…?" — each with its code, supplier, price and stock, and a
 * button to use it instead. Shown as the name or number is typed, so a
 * second "Brake pads" is caught before it is made.
 */
export function SimilarParts({
  name,
  sku,
  onUse,
}: {
  name: string;
  sku?: string;
  onUse: (part: PartOption) => void;
}) {
  const catalog = usePartCatalog();
  const parts = catalog?.parts ?? NO_PARTS;
  const found = useMemo(() => similarParts({ name, sku }, parts), [name, sku, parts]);
  if (found.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3">
      <p className="text-sm font-medium">
        Did you mean one of these? They are already in the parts list.
      </p>
      <ul className="flex flex-col gap-1.5">
        {found.map(({ part }) => (
          <li
            key={part.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-card px-2.5 py-2 text-sm"
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{part.name}</span>
              <span className="block truncate text-xs text-muted-foreground">
                <span className="font-mono">{part.sku}</span>
                {part.supplierName ? ` · ${part.supplierName}` : ''}
                {part.cost ? ` · cost ${formatMoney(part.cost)}` : ''}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <StockBadge part={part} />
              <Button type="button" size="sm" variant="outline" onClick={() => onUse(part)}>
                Use this
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Whether the catalogue has a part almost certainly the same — the server refuses it unless confirmed. */
export function useLikelySame(name: string, sku?: string) {
  const catalog = usePartCatalog();
  const parts = catalog?.parts ?? NO_PARTS;
  return useMemo(
    () => similarParts({ name, sku }, parts, { threshold: LIKELY_SAME, limit: 1 }).length > 0,
    [name, sku, parts],
  );
}

/** "This is a different part" — shown only when the catalogue has one almost the same. */
export function ConfirmNewPart() {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" name="confirmNew" value="1" className="mt-1 size-4 accent-primary" />
      <span>
        This is a different part
        <span className="block text-xs text-muted-foreground">
          Only if none of the parts above is the same one.
        </span>
      </span>
    </label>
  );
}

/**
 * The short form for a part not in the catalogue yet: its code, name,
 * supplier, what it was bought for and what it sells for, its VAT, and — on
 * a purchase — how many were bought (the purchase line's quantity, so the
 * stock comes in when the purchase is received, never twice).
 *
 * No stock is added from here: stock comes in on a purchase (or, for a part
 * bought for a job, from the invoice line's "bought for this job" form).
 */
function NewPartDialog({
  name,
  defaultSupplierId,
  forPurchase,
  onClose,
  onCreated,
  onUseExisting,
}: {
  name: string;
  defaultSupplierId?: string;
  forPurchase: boolean;
  onClose: () => void;
  onCreated: (part: PartOption, quantity?: string) => void;
  onUseExisting: (part: PartOption) => void;
}) {
  const catalog = usePartCatalog();
  const [state, onSubmit, isPending] = useFormAction<ActionResult<PartOption>>(
    async (prev, formData) => {
      const result = await quickCreatePartAction(prev, formData);
      if (result.ok && result.data) {
        toast.success(`${result.data.name} added to the inventory`);
        catalog?.add(result.data);
        onCreated(result.data, String(formData.get('quantityBought') ?? '').trim() || undefined);
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const [typedName, setTypedName] = useState(name);
  const [typedSku, setTypedSku] = useState('');
  const likelySame = useLikelySame(typedName, typedSku);
  // The quantity and the prices read in the unit chosen: "Quantity bought (litres)", "per litre".
  const [unit, setUnit] = useState('piece');
  const [supplierId, setSupplierId] = useState(defaultSupplierId ?? '');
  const [addingSupplier, setAddingSupplier] = useState<string | null>(null);
  const plural = UNITS.find((option) => option.unit === unit)?.plural ?? unit;
  // "5.00" → "5": the rate a new part is bought at unless the supplier charges none.
  const rate = catalog?.defaultVat || '5';
  const standardVat = rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate;

  return (
    <Dialog open onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add a new part</DialogTitle>
          <DialogDescription>It goes into the inventory and onto this line.</DialogDescription>
        </DialogHeader>
        {/*
         * The dialog sits inside the invoice or purchase form on the page's
         * component tree: its key presses and its submit stop here, so they
         * never move the lines or save the document behind it.
         */}
        <form
          onSubmit={(event) => {
            event.stopPropagation();
            onSubmit(event);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className="flex flex-col gap-5"
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              id="new-part-name"
              label="Part name"
              name="name"
              required
              autoFocus
              value={typedName}
              onChange={(event) => setTypedName(event.target.value)}
              error={errors.name}
              className={cn(INPUT, 'sm:col-span-2')}
            />
            <TextField
              id="new-part-sku"
              label="Code / part number"
              name="sku"
              value={typedSku}
              onChange={(event) => setTypedSku(event.target.value)}
              error={errors.sku}
              hint="Leave blank to number it automatically."
              className={INPUT}
            />
            <Field label="Supplier" htmlFor="new-part-supplier" error={errors.preferredSupplierId}>
              <NativeSelect
                id="new-part-supplier"
                name="preferredSupplierId"
                value={supplierId}
                onChange={(event) => setSupplierId(event.target.value)}
                onCreate={(typed) => setAddingSupplier(typed)}
                createLabel="Add new supplier"
                className="h-11 text-base md:text-sm"
              >
                <option value="">No supplier</option>
                {(catalog?.suppliers ?? []).map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>
                    {supplier.name}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <div className="sm:col-span-2">
              <SimilarParts name={typedName} sku={typedSku} onUse={onUseExisting} />
            </div>
            <TextField
              id="new-part-cost"
              label="Price bought"
              name="costPrice"
              numeric="money"
              required
              placeholder="0.00"
              error={errors.costPrice}
              hint={`What you pay the supplier per ${unit}, before VAT.`}
              className={INPUT}
            />
            <TextField
              id="new-part-price"
              label="Selling price"
              name="sellingPrice"
              numeric="money"
              placeholder="0.00"
              error={errors.sellingPrice}
              hint={`What the customer pays per ${unit}, before VAT.`}
              className={INPUT}
            />
            <Field label="VAT" htmlFor="new-part-vat" error={errors.taxRate}>
              <NativeSelect
                id="new-part-vat"
                name="taxRate"
                defaultValue={standardVat}
                className="h-11 text-base md:text-sm"
              >
                <option value={standardVat}>{standardVat}% — the supplier charges VAT</option>
                {standardVat !== '0' ? <option value="0">0% — no VAT on the bill</option> : null}
              </NativeSelect>
            </Field>
            <Field label="Unit" htmlFor="new-part-unit" required error={errors.unitOfMeasure}>
              <NativeSelect
                id="new-part-unit"
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
            {forPurchase ? (
              <TextField
                id="new-part-quantity"
                label={`Quantity bought (${plural})`}
                name="quantityBought"
                numeric="quantity"
                defaultValue="1"
                hint="Goes on this purchase; stock comes in when it is received."
                className={INPUT}
              />
            ) : null}
          </div>
          {likelySame || errors.name ? <ConfirmNewPart /> : null}
          <FormError message={state.error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>
              Cancel
            </Button>
            <SubmitButton size="lg" pending={isPending} pendingLabel="Adding…">
              <Save />
              Add part
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
