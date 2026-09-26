'use client';

import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { Package, Plus, Trash2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  calculateLine,
  calculateTotals,
  formatMilli,
  signedToMilli,
  type LineAmounts,
} from '@/lib/money';
import { formatMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/*
 * Typing the lines of a quotation or an invoice, laid out like the
 * workshop's own sheet: one numbered list, each line marked Parts or
 * Labour, then Qty, Price and Amount, with the totals underneath.
 *
 * Every figure shown while typing comes from lib/money — the same rules the
 * server prices with — so the total on screen is the total on the document.
 * The server still prices every line again; nothing here is trusted.
 */

export type LineType = 'PART' | 'LABOUR';

export interface EditableLine {
  key: string;
  itemType: LineType;
  description: string;
  quantity: string;
  unitPrice: string;
  /** Percent; defaults to the organization's rate. */
  taxRate: string;
}

/** "5.00" → "5" for the rate input. */
export const trimRate = (rate: string) => (rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate);

let counter = 0;
export function newEditableLine(itemType: LineType, defaultVatRate: string): EditableLine {
  counter += 1;
  return {
    key: `line-${Date.now()}-${counter}`,
    itemType,
    description: '',
    quantity: '1',
    unitPrice: '',
    taxRate: trimRate(defaultVatRate),
  };
}

function price(line: EditableLine, defaultVatRate: string): LineAmounts | null {
  try {
    return calculateLine({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxRate: line.taxRate || defaultVatRate,
    });
  } catch {
    return null;
  }
}

/** A line left completely blank is ignored rather than refused. */
export const isBlankLine = (line: EditableLine) =>
  line.description.trim() === '' && line.unitPrice.trim() === '';

/** The priced state of the lines, for the parent's buttons and messages. */
export function useLineTotals(lines: EditableLine[], defaultVatRate: string) {
  return useMemo(() => {
    const priced = lines.map((line) => ({ line, amounts: price(line, defaultVatRate) }));
    const used = priced.filter((entry) => !isBlankLine(entry.line));
    const totals = calculateTotals(used.flatMap((entry) => (entry.amounts ? [entry.amounts] : [])));
    const rates = new Set(
      used.map((entry) => formatMilli(signedToMilli(entry.line.taxRate || defaultVatRate))),
    );
    return {
      priced,
      totals,
      vatLabel: rates.size === 1 ? `VAT ${[...rates][0]}%` : 'VAT',
      /** Some line is half-filled or has an amount that doesn't parse. */
      incomplete: used.some((entry) => !entry.amounts || entry.line.description.trim() === ''),
      count: used.length,
    };
  }, [lines, defaultVatRate]);
}

export function DocumentLinesEditor({
  lines,
  onChange,
  defaultVatRate,
}: {
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
  defaultVatRate: string;
}) {
  const { priced, totals, vatLabel } = useLineTotals(lines, defaultVatRate);
  const rootRef = useRef<HTMLDivElement>(null);
  /** A line just added, whose description should take the focus once it renders. */
  const focusLine = useRef<string | null>(null);

  useEffect(() => {
    const key = focusLine.current;
    if (!key) return;
    focusLine.current = null;
    // Both layouts are rendered; focus the one on screen.
    const inputs =
      rootRef.current?.querySelectorAll<HTMLInputElement>(`[data-line="${key}"] input`) ?? [];
    Array.from(inputs)
      .find((input) => input.offsetParent !== null)
      ?.focus();
  }, [lines]);

  const update = (key: string, patch: Partial<EditableLine>) =>
    onChange(lines.map((line) => (line.key === key ? { ...line, ...patch } : line)));
  const remove = (key: string) => onChange(lines.filter((line) => line.key !== key));
  const add = (itemType: LineType) => {
    const line = newEditableLine(itemType, defaultVatRate);
    focusLine.current = line.key;
    onChange([...lines, line]);
  };

  /*
   * Enter never submits the document from here — that issued invoices
   * half-typed. It moves to the next box, like a spreadsheet, and from the
   * last box of the last line it starts a new line.
   */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    const layout = event.target.closest<HTMLElement>('[data-layout]');
    if (!layout) return;
    const inputs = Array.from(layout.querySelectorAll<HTMLInputElement>('input'));
    const next = inputs[inputs.indexOf(event.target) + 1];
    if (next) {
      next.focus();
      next.select();
    } else {
      add(lines.at(-1)?.itemType ?? 'PART');
    }
  }

  return (
    <div ref={rootRef} onKeyDown={onKeyDown} className="flex flex-col gap-4">
      {/* Phone: each line a small card with labelled fields — never a sideways table. */}
      <ol data-layout="cards" className="flex flex-col gap-3 md:hidden">
        {priced.map(({ line, amounts }, index) => {
          const n = index + 1;
          return (
            <li
              key={line.key}
              data-line={line.key}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3.5"
            >
              <div className="flex items-center gap-2">
                <span className="w-6 text-sm font-semibold text-muted-foreground tabular-nums">
                  {n}
                </span>
                <TypeSwitch
                  value={line.itemType}
                  onChange={(itemType) => update(line.key, { itemType })}
                  label={`Line ${n} type`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-auto size-11"
                  aria-label={`Remove line ${n}`}
                  onClick={() => remove(line.key)}
                  disabled={lines.length === 1}
                >
                  <Trash2 />
                </Button>
              </div>
              <LabelledInput
                label="Description"
                aria={`Line ${n} description`}
                value={line.description}
                onChange={(value) => update(line.key, { description: value })}
                placeholder={
                  line.itemType === 'LABOUR' ? 'e.g. Labour and consumables' : 'e.g. Ignition coil'
                }
              />
              <div className="grid grid-cols-[1fr_1.4fr_1fr] gap-2">
                <LabelledInput
                  label="Qty"
                  aria={`Line ${n} quantity`}
                  value={line.quantity}
                  onChange={(value) => update(line.key, { quantity: value })}
                  numeric
                />
                <LabelledInput
                  label="Price"
                  aria={`Line ${n} price`}
                  value={line.unitPrice}
                  onChange={(value) => update(line.key, { unitPrice: value })}
                  placeholder="0.00"
                  numeric
                />
                <LabelledInput
                  label="VAT %"
                  aria={`Line ${n} VAT rate`}
                  value={line.taxRate}
                  onChange={(value) => update(line.key, { taxRate: value })}
                  numeric
                />
              </div>
              <p className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Amount</span>
                <LineAmount line={line} amounts={amounts} />
              </p>
            </li>
          );
        })}
      </ol>

      {/* Tablet and up: the sheet itself. */}
      <div
        data-layout="sheet"
        className="hidden overflow-x-auto rounded-xl border border-border md:block"
      >
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            <tr>
              <th className="w-12 px-3 py-2.5 text-right">S.No</th>
              <th className="w-40 px-2 py-2.5">Type</th>
              <th className="px-2 py-2.5">Description</th>
              <th className="w-20 px-2 py-2.5 text-right">Qty</th>
              <th className="w-28 px-2 py-2.5 text-right">Price</th>
              <th className="w-20 px-2 py-2.5 text-right">VAT %</th>
              <th className="w-28 px-3 py-2.5 text-right">Amount</th>
              <th className="w-12 px-2 py-2.5">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {priced.map(({ line, amounts }, index) => {
              const n = index + 1;
              return (
                <tr key={line.key} data-line={line.key} className="align-middle">
                  <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">{n}</td>
                  <td className="px-2 py-2">
                    <TypeSwitch
                      value={line.itemType}
                      onChange={(itemType) => update(line.key, { itemType })}
                      label={`Line ${n} type`}
                      compact
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label={`Line ${n} description`}
                      value={line.description}
                      onChange={(event) => update(line.key, { description: event.target.value })}
                      placeholder={
                        line.itemType === 'LABOUR'
                          ? 'e.g. Labour and consumables'
                          : 'e.g. Ignition coil'
                      }
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label={`Line ${n} quantity`}
                      inputMode="decimal"
                      value={line.quantity}
                      onChange={(event) => update(line.key, { quantity: event.target.value })}
                      className="text-right tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label={`Line ${n} price`}
                      inputMode="decimal"
                      value={line.unitPrice}
                      placeholder="0.00"
                      onChange={(event) => update(line.key, { unitPrice: event.target.value })}
                      className="text-right tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label={`Line ${n} VAT rate`}
                      inputMode="decimal"
                      value={line.taxRate}
                      onChange={(event) => update(line.key, { taxRate: event.target.value })}
                      className="text-right tabular-nums"
                    />
                  </td>
                  <td className="px-3 py-2 text-right">
                    <LineAmount line={line} amounts={amounts} />
                  </td>
                  <td className="px-2 py-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove line ${n}`}
                      onClick={() => remove(line.key)}
                      disabled={lines.length === 1}
                    >
                      <Trash2 />
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button
          type="button"
          variant="outline"
          className="h-12 sm:h-10"
          onClick={() => add('PART')}
        >
          <Plus />
          <Package />
          Add part
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-12 sm:h-10"
          onClick={() => add('LABOUR')}
        >
          <Plus />
          <Wrench />
          Add labour
        </Button>
      </div>

      <dl className="flex flex-col gap-2 self-stretch rounded-xl bg-muted/50 px-4 py-4 text-sm sm:self-end sm:w-80">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Total excl. VAT</dt>
          <dd className="tabular-nums">{formatMoney(totals.subtotal)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{vatLabel}</dt>
          <dd className="tabular-nums">{formatMoney(totals.taxAmount)}</dd>
        </div>
        <div className="flex justify-between gap-4 border-t border-border pt-2 text-base font-semibold">
          <dt>Total</dt>
          <dd className="tabular-nums">{formatMoney(totals.totalAmount)}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Parts / Labour, as a two-button switch — one tap, no dropdown. */
function TypeSwitch({
  value,
  onChange,
  label,
  compact = false,
}: {
  value: LineType;
  onChange: (value: LineType) => void;
  label: string;
  compact?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5"
    >
      {(['PART', 'LABOUR'] as const).map((option) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'rounded-md px-3 text-xs font-semibold tracking-wide uppercase transition-colors',
            compact ? 'h-8' : 'h-10',
            value === option
              ? 'bg-card text-foreground shadow-xs'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {option === 'PART' ? 'Parts' : 'Labour'}
        </button>
      ))}
    </div>
  );
}

function LineAmount({ line, amounts }: { line: EditableLine; amounts: LineAmounts | null }) {
  if (amounts)
    return <span className="font-semibold tabular-nums">{formatMoney(amounts.lineTotal)}</span>;
  if (line.unitPrice.trim() === '') return <span className="text-muted-foreground">—</span>;
  return <span className="text-xs font-medium text-destructive">Check the numbers</span>;
}

function LabelledInput({
  label,
  aria,
  value,
  onChange,
  placeholder,
  numeric = false,
}: {
  label: string;
  aria: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  numeric?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Input
        aria-label={aria}
        value={value}
        inputMode={numeric ? 'decimal' : undefined}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn('h-12 text-base', numeric && 'text-right tabular-nums')}
      />
    </label>
  );
}
