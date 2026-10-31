'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { NumberInput, type NumberKind } from '@/components/forms/number-input';
import { NativeSelect } from '@/components/forms/fields';
import { Package, Plus, Trash2, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  calculateDocument,
  calculateLine,
  filsToString,
  formatMilli,
  readDiscount,
  signedToMilli,
  toFils,
  type DiscountType,
  type DocumentTotals,
  type LineAmounts,
} from '@/lib/money';
import { formatMoney } from '@/lib/format';
import type { BillDiscount, EditableLine, LineType } from '@/lib/billing/editable-lines';
import { rateFor, VAT_TREATMENTS, type VatTreatment } from '@/lib/vat-treatment';
import { fitInclusivePrice, inclusiveOf, type PriceBasis } from '@/lib/vat-entry';
import { PriceBasisToggle } from '@/components/forms/price-basis-toggle';
import type { TaxCodeOption } from '@/lib/accounting/tax-codes';
import { cn } from '@/lib/utils';
import type { PartCatalog, PartOption } from '@/lib/inventory/part-options';
import {
  PartCatalogProvider,
  PartPicker,
  usePartCatalog,
} from '@/components/inventory/part-picker';
import { BuyPartDialog } from '@/components/inventory/buy-part-dialog';
import type { BoughtPart } from '@/app/(app)/inventory/actions';

/*
 * Typing the lines of a quotation or an invoice, laid out like the
 * workshop's own sheet: one numbered list, each line marked Parts or
 * Labour, then Qty, Price, Discount and Amount, with the totals — and a
 * discount on the whole bill — underneath.
 *
 * Every figure shown while typing comes from lib/money — the same rules the
 * server prices with — so the total on screen is the total on the document.
 * The server still prices every line again; nothing here is trusted.
 */

export type { BillDiscount, EditableLine, LineType };

export const NO_BILL_DISCOUNT: BillDiscount = { type: 'PERCENT', value: '' };

/** "5.00" → "5" for the rate input. */
export const trimRate = (rate: string) => (rate.includes('.') ? rate.replace(/\.?0+$/, '') : rate);

let counter = 0;
export function newEditableLine(
  itemType: LineType,
  defaultVatRate: string,
  /** The workshop's default tax code, when it keeps a tax code master. */
  taxCode?: TaxCodeOption | null,
): EditableLine {
  counter += 1;
  return {
    key: `line-${Date.now()}-${counter}`,
    itemType,
    description: '',
    quantity: '1',
    unitPrice: '',
    taxRate: trimRate(taxCode?.rate ?? defaultVatRate),
    vatTreatment: taxCode?.treatment ?? 'STANDARD',
    taxCodeId: taxCode?.id ?? '',
    discountType: 'PERCENT',
    discount: '',
    accountId: '',
    partId: '',
    unitCost: '',
  };
}

/** The lines as the server expects them — blank lines left out. */
export function linesPayload(lines: EditableLine[]) {
  return lines
    .filter((line) => !isBlankLine(line))
    .map(
      ({
        sourceId,
        itemType,
        description,
        quantity,
        unitPrice,
        vatTreatment,
        taxCodeId,
        discountType,
        discount,
        accountId,
        partId,
        unitCost,
      }) => ({
        ...(sourceId ? { sourceId } : {}),
        itemType,
        description,
        quantity,
        unitPrice,
        vatTreatment,
        taxCodeId,
        discountType,
        discount,
        accountId,
        ...(itemType === 'PART' ? { partId, unitCost } : {}),
      }),
    );
}

/** The bill discount as the server expects it. */
export function billDiscountPayload(bill: BillDiscount) {
  return { discountType: bill.type, discount: bill.value };
}

/** The rate a line is priced at: its tax code's, else its treatment's. */
const lineRate = (line: EditableLine, defaultVatRate: string) =>
  line.taxCodeId ? line.taxRate : rateFor(line.vatTreatment, defaultVatRate);

function price(line: EditableLine, defaultVatRate: string): LineAmounts | null {
  try {
    return calculateLine({
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxRate: lineRate(line, defaultVatRate),
      discount: readDiscount(line.discountType, line.discount),
    });
  } catch {
    return null;
  }
}

/** A line left completely blank is ignored rather than refused. */
export const isBlankLine = (line: EditableLine) =>
  line.description.trim() === '' && line.unitPrice.trim() === '';

/** The priced state of the lines and bill, for the parent's buttons and messages. */
export function useLineTotals(
  lines: EditableLine[],
  defaultVatRate: string,
  bill: BillDiscount = NO_BILL_DISCOUNT,
) {
  return useMemo(() => {
    const priced = lines.map((line) => ({ line, amounts: price(line, defaultVatRate) }));
    const used = priced.filter((entry) => !isBlankLine(entry.line));
    const amounts = used.flatMap((entry) => (entry.amounts ? [entry.amounts] : []));
    let totals: DocumentTotals;
    let billError: string | null = null;
    try {
      totals = calculateDocument(amounts, readDiscount(bill.type, bill.value)).totals;
    } catch (error) {
      billError = error instanceof Error ? error.message : 'Check the discount.';
      totals = calculateDocument(amounts).totals;
    }
    const rates = new Set(
      used.map((entry) => formatMilli(signedToMilli(lineRate(entry.line, defaultVatRate)))),
    );
    return {
      priced,
      totals,
      billError,
      vatLabel: rates.size === 1 ? `VAT ${[...rates][0]}%` : 'VAT',
      /** Some line is half-filled, an amount doesn't parse, or the bill discount doesn't. */
      incomplete:
        billError !== null ||
        used.some((entry) => !entry.amounts || entry.line.description.trim() === ''),
      count: used.length,
    };
  }, [lines, defaultVatRate, bill]);
}

export function DocumentLinesEditor({
  lines,
  onChange,
  bill,
  onBillChange,
  defaultVatRate,
  incomeAccounts,
  taxCodes,
  rounding,
  onRoundingChange,
  catalog,
  requireParts = false,
  heldByDocument,
  onPartAdded,
}: {
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
  /**
   * Invoices: a round-off after VAT ("-0.50"), outside VAT. Omitted
   * (quotations), no round-off row is shown.
   */
  rounding?: string;
  onRoundingChange?: (value: string) => void;
  /** The discount on the whole bill. */
  bill: BillDiscount;
  onBillChange: (bill: BillDiscount) => void;
  defaultVatRate: string;
  /**
   * Invoices: the income accounts a line can book to. Omitted (quotations),
   * no account column is shown.
   */
  incomeAccounts?: { id: string; code: string; name: string }[];
  /** The tax code master. Given, each line picks a code instead of a treatment. */
  taxCodes?: TaxCodeOption[];
  /**
   * The inventory: given, a Parts line's description offers the parts in
   * stock as it is typed, and picking one fills its name and selling price.
   */
  catalog?: PartCatalog;
  /**
   * Invoices: each Parts line shows its part, cost and stock, and a part not
   * in stock (or not in the list) can be recorded as bought for the job right
   * there. A line may also stay typed, with no part from the list.
   */
  requireParts?: boolean;
  /** Editing an issued invoice: what it already took out of stock, per part (thousandths). */
  heldByDocument?: Record<string, number>;
  /** A part added or bought from a line — for the parent's own check of the lines. */
  onPartAdded?: (part: PartOption) => void;
}) {
  const { priced, totals, vatLabel, billError } = useLineTotals(lines, defaultVatRate, bill);
  const billOff = toFils(totals.discountAmount) > 0;
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

  // Prices typed with VAT: what was typed is kept here, and each line carries
  // the price before VAT that comes to it, which is all the server ever sees.
  const [basis, setBasis] = useState<PriceBasis>('EXCLUSIVE');
  const [typedPrices, setTypedPrices] = useState<Record<string, string>>({});
  const fitted = (line: EditableLine, typed: string) =>
    fitInclusivePrice(typed, line.quantity, lineRate(line, defaultVatRate));
  const update = (key: string, patch: Partial<EditableLine>) => {
    // A price from elsewhere (a part picked) replaces what was typed.
    if (patch.unitPrice !== undefined && typedPrices[key] !== undefined) {
      setTypedPrices((current) => {
        const rest = { ...current };
        delete rest[key];
        return rest;
      });
    }
    onChange(
      lines.map((line) => {
        if (line.key !== key) return line;
        const next = { ...line, ...patch };
        const typed = typedPrices[key];
        // A new quantity or VAT code: the same price with VAT, so a new price before it.
        if (basis === 'INCLUSIVE' && typed !== undefined && patch.unitPrice === undefined) {
          next.unitPrice = fitted(next, typed)?.unitPrice ?? next.unitPrice;
        }
        return next;
      }),
    );
  };
  const typePrice = (line: EditableLine, value: string) => {
    if (basis === 'EXCLUSIVE') {
      update(line.key, { unitPrice: value });
      return;
    }
    setTypedPrices((current) => ({ ...current, [line.key]: value }));
    onChange(
      lines.map((entry) =>
        entry.key === line.key
          ? { ...entry, unitPrice: fitted(entry, value)?.unitPrice ?? value }
          : entry,
      ),
    );
  };
  const shownPrice = (line: EditableLine) =>
    basis === 'EXCLUSIVE'
      ? line.unitPrice
      : (typedPrices[line.key] ??
        (line.unitPrice ? inclusiveOf(line.unitPrice, lineRate(line, defaultVatRate)) : ''));
  /** Lines that VAT rounding can't bring to the fil typed. */
  const offLines =
    basis === 'INCLUSIVE'
      ? lines.flatMap((line, index) => {
          const typed = typedPrices[line.key];
          const fit = typed ? fitted(line, typed) : null;
          return fit && !fit.exact ? [{ n: index + 1, ...fit }] : [];
        })
      : [];
  const remove = (key: string) => onChange(lines.filter((line) => line.key !== key));
  /** A part picked for a line: its name, its selling price when it has one, and its last cost. */
  const pick = (line: EditableLine, part: PartOption) =>
    update(line.key, {
      description: part.name,
      unitPrice: part.price || line.unitPrice,
      partId: part.id,
      unitCost: part.cost,
    });
  /** Typing the description: a line cleared lets go of its part. */
  const describe = (line: EditableLine, value: string) =>
    update(
      line.key,
      value.trim() ? { description: value } : { description: value, partId: '', unitCost: '' },
    );
  /** The "bought for this job" form open for a line: its part, or a new one by name. */
  const [buying, setBuying] = useState<{
    key: string;
    part: PartOption | null;
    name: string;
    quantity: string;
    price: string;
  } | null>(null);
  const buy = (line: EditableLine, part: PartOption | null, quantity: string) =>
    setBuying({ key: line.key, part, name: line.description, quantity, price: line.unitPrice });
  const bought = (result: BoughtPart) => {
    if (!buying) return;
    const line = lines.find((entry) => entry.key === buying.key);
    setBuying(null);
    if (!line) return;
    update(line.key, {
      description: line.partId === result.part.id ? line.description : result.part.name,
      unitPrice: line.unitPrice || result.part.price,
      partId: result.part.id,
      unitCost: result.unitCost,
    });
  };
  const addNew = (line: EditableLine) =>
    requireParts && catalog?.canBuy
      ? (typed: string) =>
          setBuying({
            key: line.key,
            part: null,
            name: typed,
            quantity: line.quantity,
            price: line.unitPrice,
          })
      : undefined;
  const picks = (line: EditableLine) => Boolean(catalog) && line.itemType === 'PART';
  const add = (itemType: LineType) => {
    const line = newEditableLine(
      itemType,
      defaultVatRate,
      taxCodes?.find((code) => code.isDefault) ?? null,
    );
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

  const editor = (
    <div ref={rootRef} onKeyDown={onKeyDown} className="flex flex-col gap-4">
      <PriceBasisToggle
        label="Prices are"
        value={basis}
        onChange={(next) => {
          setBasis(next);
          setTypedPrices({});
        }}
      />
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
              {picks(line) ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Description</span>
                  <PartPicker
                    aria-label={`Line ${n} description`}
                    value={line.description}
                    onValueChange={(value) => describe(line, value)}
                    onPick={(part) => pick(line, part)}
                    onAddNew={addNew(line)}
                    placeholder="Type to find a part in stock"
                    className="h-12 text-base"
                  />
                </label>
              ) : null}
              {picks(line) ? (
                <PartLineInfo
                  line={line}
                  lines={lines}
                  required={requireParts}
                  held={heldByDocument}
                  onCost={(unitCost) => update(line.key, { unitCost })}
                  onBuy={(part, quantity) => buy(line, part, quantity)}
                />
              ) : (
                <LabelledInput
                  label="Description"
                  aria={`Line ${n} description`}
                  value={line.description}
                  onChange={(value) => update(line.key, { description: value })}
                  placeholder={
                    line.itemType === 'LABOUR'
                      ? 'e.g. Labour and consumables'
                      : 'e.g. Ignition coil'
                  }
                />
              )}
              <div className="grid grid-cols-[1fr_1.4fr_1fr] gap-2">
                <LabelledInput
                  label="Qty"
                  aria={`Line ${n} quantity`}
                  value={line.quantity}
                  onChange={(value) => update(line.key, { quantity: value })}
                  numeric="quantity"
                />
                <LabelledInput
                  label={basis === 'INCLUSIVE' ? 'Price incl. VAT' : 'Price'}
                  aria={`Line ${n} price`}
                  value={shownPrice(line)}
                  onChange={(value) => typePrice(line, value)}
                  placeholder="0.00"
                  numeric="money"
                />
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">VAT</span>
                  <VatSelect
                    label={`Line ${n} VAT`}
                    line={line}
                    taxCodes={taxCodes}
                    onChange={(patch) => update(line.key, patch)}
                    large
                  />
                </label>
              </div>
              {incomeAccounts ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-medium text-muted-foreground">Account</span>
                  <AccountSelect
                    label={`Line ${n} account`}
                    value={line.accountId}
                    itemType={line.itemType}
                    accounts={incomeAccounts}
                    onChange={(accountId) => update(line.key, { accountId })}
                    large
                  />
                </label>
              ) : null}
              <div className="flex flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">Discount</span>
                <DiscountInput
                  label={`Line ${n} discount`}
                  type={line.discountType}
                  value={line.discount}
                  base={grossFils(line)}
                  computed={amounts?.discountAmount ?? '0.00'}
                  onChange={(discount) =>
                    update(line.key, { discountType: discount.type, discount: discount.value })
                  }
                  large
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
              {incomeAccounts ? <th className="w-44 px-2 py-2.5">Account</th> : null}
              <th className="w-20 px-2 py-2.5 text-right">Qty</th>
              <th className="w-28 px-2 py-2.5 text-right">
                {basis === 'INCLUSIVE' ? 'Price incl. VAT' : 'Price'}
              </th>
              <th className="w-32 px-2 py-2.5">VAT</th>
              <th className="w-36 px-2 py-2.5 text-right">Discount</th>
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
                    {picks(line) ? (
                      <div className="flex flex-col gap-1.5">
                        <PartPicker
                          aria-label={`Line ${n} description`}
                          value={line.description}
                          onValueChange={(value) => describe(line, value)}
                          onPick={(part) => pick(line, part)}
                          onAddNew={addNew(line)}
                          placeholder="Type to find a part in stock"
                        />
                        <PartLineInfo
                          line={line}
                          lines={lines}
                          required={requireParts}
                          held={heldByDocument}
                          onCost={(unitCost) => update(line.key, { unitCost })}
                          onBuy={(part, quantity) => buy(line, part, quantity)}
                        />
                      </div>
                    ) : (
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
                    )}
                  </td>
                  {incomeAccounts ? (
                    <td className="px-2 py-2">
                      <AccountSelect
                        label={`Line ${n} account`}
                        value={line.accountId}
                        itemType={line.itemType}
                        accounts={incomeAccounts}
                        onChange={(accountId) => update(line.key, { accountId })}
                      />
                    </td>
                  ) : null}
                  <td className="px-2 py-2">
                    <NumberInput
                      kind="quantity"
                      aria-label={`Line ${n} quantity`}
                      value={line.quantity}
                      onChange={(event) => update(line.key, { quantity: event.target.value })}
                      className="text-right tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <NumberInput
                      aria-label={`Line ${n} price`}
                      value={shownPrice(line)}
                      placeholder="0.00"
                      onChange={(event) => typePrice(line, event.target.value)}
                      className="text-right tabular-nums"
                    />
                  </td>
                  <td className="px-2 py-2">
                    <VatSelect
                      label={`Line ${n} VAT`}
                      line={line}
                      taxCodes={taxCodes}
                      onChange={(patch) => update(line.key, patch)}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <DiscountInput
                      label={`Line ${n} discount`}
                      type={line.discountType}
                      value={line.discount}
                      base={grossFils(line)}
                      computed={amounts?.discountAmount ?? '0.00'}
                      onChange={(discount) =>
                        update(line.key, { discountType: discount.type, discount: discount.value })
                      }
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

      <dl className="flex flex-col gap-2 self-stretch rounded-xl bg-muted/50 px-4 py-4 text-sm sm:w-96 sm:self-end">
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Subtotal</dt>
          <dd className="tabular-nums">{formatMoney(totals.linesTotal)}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted-foreground">Discount on the bill</dt>
          <dd className="flex items-center gap-3">
            <DiscountInput
              label="Discount on the bill"
              type={bill.type}
              value={bill.value}
              base={toFils(totals.linesTotal)}
              computed={totals.discountAmount}
              onChange={onBillChange}
            />
            <span className="w-24 text-right tabular-nums">
              {billOff ? `−${formatMoney(totals.discountAmount)}` : '—'}
            </span>
          </dd>
        </div>
        {billError ? (
          <p role="alert" className="text-right text-xs font-medium text-destructive">
            {billError}
          </p>
        ) : null}
        {offLines.map((line) => (
          <p key={line.n} className="text-right text-xs text-warning">
            {`Line ${line.n} comes to ${formatMoney(line.actual)}, not ${formatMoney(line.wanted)}: VAT rounds to the fil.${onRoundingChange ? ' Use the round-off if the bill must match.' : ''}`}
          </p>
        ))}
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">Total excl. VAT</dt>
          <dd className="tabular-nums">{formatMoney(totals.subtotal)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">{vatLabel}</dt>
          <dd className="tabular-nums">{formatMoney(totals.taxAmount)}</dd>
        </div>
        {onRoundingChange ? (
          <RoundingRow
            total={totals.totalAmount}
            value={rounding ?? ''}
            onChange={onRoundingChange}
          />
        ) : null}
        <div className="flex justify-between gap-4 border-t border-border pt-2 text-base font-semibold">
          <dt>Total</dt>
          <dd className="tabular-nums">
            {formatMoney(withRoundOff(totals.totalAmount, onRoundingChange ? rounding : ''))}
          </dd>
        </div>
      </dl>
    </div>
  );
  return catalog ? (
    <PartCatalogProvider catalog={catalog} onAdd={onPartAdded}>
      {editor}
      {buying ? (
        <BuyPartDialog
          part={buying.part}
          name={buying.name}
          quantity={buying.quantity}
          sellingPrice={buying.price}
          onClose={() => setBuying(null)}
          onDone={bought}
          onUseExisting={(part) => {
            const line = lines.find((entry) => entry.key === buying.key);
            setBuying(null);
            if (line) pick(line, part);
          }}
        />
      ) : null}
    </PartCatalogProvider>
  ) : (
    editor
  );
}

/**
 * The catalogue's parts as the page knows them now — those it loaded with,
 * and any added or bought from a line since (pass `add` to the editor's
 * onPartAdded).
 */
export function useCatalogParts(catalog: PartCatalog | undefined) {
  const [added, setAdded] = useState<PartOption[]>([]);
  const add = useCallback(
    (part: PartOption) => setAdded((current) => [...current.filter((p) => p.id !== part.id), part]),
    [],
  );
  const parts = useMemo(() => {
    const ids = new Set(added.map((part) => part.id));
    return [...(catalog?.parts ?? []).filter((part) => !ids.has(part.id)), ...added];
  }, [catalog, added]);
  return { parts, add };
}

/** "2 lines need a part from the list" / "1 part is short of stock", or null. */
export function partIssueMessage(issues: { unlinked: number; short: number }) {
  // A Parts line may be typed without a part from the list (the owners, 26 Oct
  // 2026: parts are often bought only after the customer says yes); only a
  // part picked from the list with too little in stock holds the document back.
  if (issues.short) {
    return `${issues.short} part${issues.short === 1 ? ' is' : 's are'} short of stock — record it as bought for this job on the line.`;
  }
  return null;
}

/** Thousandths from a typed quantity (0 while it doesn't parse). */
function quantityMilli(value: string) {
  try {
    return signedToMilli(value || '0');
  } catch {
    return 0;
  }
}

/**
 * What a document's Parts lines still need before it can be issued: lines
 * naming no part, and parts with less in stock than the lines sell. The
 * server checks the same again; this only keeps the button honest.
 */
export function partLineIssues(
  lines: EditableLine[],
  parts: PartOption[],
  held: Record<string, number> = {},
) {
  const byId = new Map(parts.map((part) => [part.id, part]));
  const used = lines.filter((line) => line.itemType === 'PART' && !isBlankLine(line));
  const unlinked = used.filter((line) => !line.partId && !line.sourceId).length;
  const need = new Map<string, number>();
  for (const line of used) {
    if (line.partId)
      need.set(line.partId, (need.get(line.partId) ?? 0) + quantityMilli(line.quantity));
  }
  let short = 0;
  for (const [partId, milli] of need) {
    const part = byId.get(partId);
    if (part && signedToMilli(part.stock) + (held[partId] ?? 0) < milli) short += 1;
  }
  return { unlinked, short };
}

/**
 * Under a Parts line: the part it sells — code, usual supplier, what it
 * cost (editable: the invoice writer decides the cost) and the stock — or,
 * with no part picked, why one is needed. When the stock is short, the part
 * is recorded as bought for the job from here.
 */
function PartLineInfo({
  line,
  lines,
  required,
  held,
  onCost,
  onBuy,
}: {
  line: EditableLine;
  lines: EditableLine[];
  required: boolean;
  held?: Record<string, number>;
  onCost: (unitCost: string) => void;
  onBuy: (part: PartOption | null, quantity: string) => void;
}) {
  const catalog = usePartCatalog();
  if (isBlankLine(line)) return null;
  const part = line.partId ? catalog?.parts.find((option) => option.id === line.partId) : undefined;

  if (!line.partId) {
    // Kept from an invoice issued before parts were tied to stock, or quoted.
    if (!required || line.sourceId) return null;
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span>Typed, not from the parts list: it won’t come out of stock.</span>
        {catalog?.canBuy ? (
          <button
            type="button"
            onClick={() => onBuy(null, line.quantity)}
            className="font-medium text-primary hover:underline"
          >
            Add it as bought for this job
          </button>
        ) : null}
      </p>
    );
  }
  if (!part) {
    return <p className="text-xs text-muted-foreground">Linked to a part from the list.</p>;
  }

  // Every line of this document selling the same part draws on the same stock.
  const need = lines
    .filter((other) => other.itemType === 'PART' && other.partId === part.id)
    .reduce((sum, other) => sum + quantityMilli(other.quantity), 0);
  const available = signedToMilli(part.stock) + (held?.[part.id] ?? 0);
  const shortBy = need - available;

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        <span className="font-mono">{part.sku}</span>
        {part.supplierName ? ` · ${part.supplierName}` : ''}
      </span>
      {/* Invoices only: the cost of what is sold, decided here. */}
      {required ? (
        <label className="flex items-center gap-1.5">
          <span>Cost</span>
          <NumberInput
            kind="money"
            aria-label={`Cost of ${part.name}`}
            value={line.unitCost}
            placeholder={part.cost || '0.00'}
            onChange={(event) => onCost(event.target.value)}
            className="h-7 w-20 text-right text-xs tabular-nums"
          />
        </label>
      ) : null}
      {shortBy > 0 ? (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium text-destructive">
            {available > 0 ? `Only ${formatMilli(available)} in stock` : 'Not in stock'}
          </span>
          {catalog?.canBuy ? (
            <button
              type="button"
              onClick={() => onBuy(part, formatMilli(shortBy))}
              className="font-medium text-primary hover:underline"
            >
              Bought for this job
            </button>
          ) : null}
        </span>
      ) : (
        <span className="text-success">{formatMilli(available)} in stock</span>
      )}
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

/** Signed fils from a round-off as typed ("-0.50"): 0 while it doesn't parse. */
export function roundOffFils(value: string | undefined) {
  const text = value?.trim() ?? '';
  if (!text || text === '-') return 0;
  return text.startsWith('-') ? -safeFils(text.slice(1)) : safeFils(text);
}

/** A total with its round-off, as the invoice will show it. */
export function withRoundOff(total: string, rounding: string | undefined) {
  return filsToString(safeFils(total) + roundOffFils(rounding));
}

/**
 * The round-off after VAT: a small plus or minus amount, outside VAT, and a
 * one-tap "round to whole AED" that fills it in.
 */
export function RoundingRow({
  total,
  value,
  onChange,
  label = 'Round-off',
  className,
}: {
  total: string;
  value: string;
  onChange: (value: string) => void;
  label?: string;
  className?: string;
}) {
  const totalFils = safeFils(total);
  // To the nearest whole dirham: down when under half, up from half.
  const cents = totalFils % 100;
  const toWhole = cents === 0 ? 0 : cents < 50 ? -cents : 100 - cents;
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <dt className="flex flex-col text-muted-foreground">
        {label}
        {toWhole !== 0 ? (
          <button
            type="button"
            onClick={() => onChange(filsToString(toWhole))}
            className="self-start text-xs font-medium text-primary hover:underline"
          >
            Round to whole AED
          </button>
        ) : null}
      </dt>
      <dd>
        <NumberInput
          kind="money"
          allowNegative
          aria-label="Round-off (AED, minus to round down)"
          value={value}
          placeholder="0.00"
          onChange={(event) => onChange(event.target.value)}
          className="h-9 w-24 text-right tabular-nums"
        />
      </dd>
    </div>
  );
}

/** Fils from an amount that may not parse (a half-typed figure): 0 then. */
function safeFils(value: string) {
  try {
    return toFils(value);
  } catch {
    return 0;
  }
}

/** Quantity × price before any discount, in fils (0 while it doesn't parse). */
function grossFils(line: EditableLine) {
  try {
    return calculateLine({ quantity: line.quantity, unitPrice: line.unitPrice, taxRate: '0' })
      .lineTotalFils;
  } catch {
    return 0;
  }
}

function LineAmount({ line, amounts }: { line: EditableLine; amounts: LineAmounts | null }) {
  if (amounts) {
    const off = toFils(amounts.discountAmount) > 0;
    return (
      <span className="inline-flex flex-col items-end">
        <span className="font-semibold tabular-nums">{formatMoney(amounts.lineTotal)}</span>
        {off ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            less {formatMoney(amounts.discountAmount)}
          </span>
        ) : null}
      </span>
    );
  }
  if (line.unitPrice.trim() === '') return <span className="text-muted-foreground">—</span>;
  return <span className="text-xs font-medium text-destructive">Check the numbers</span>;
}

/**
 * How a line is treated for VAT. The rate follows from it (the workshop's
 * rate for standard-rated, nothing otherwise), so it can never be mistyped.
 */
function VatSelect({
  label,
  line,
  taxCodes,
  onChange,
  large = false,
}: {
  label: string;
  line: EditableLine;
  /** The tax code master; without it, the four treatments are offered. */
  taxCodes?: TaxCodeOption[];
  onChange: (patch: Partial<EditableLine>) => void;
  large?: boolean;
}) {
  const className = cn(
    'w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
    large ? 'h-12 text-base' : 'h-9',
  );
  if (taxCodes?.length) {
    // A line saved before tax codes shows the code of its treatment.
    const value =
      line.taxCodeId || taxCodes.find((code) => code.treatment === line.vatTreatment)?.id || '';
    return (
      <NativeSelect
        aria-label={label}
        value={value}
        onChange={(event) => {
          const code = taxCodes.find((option) => option.id === event.target.value);
          if (code) {
            onChange({
              taxCodeId: code.id,
              vatTreatment: code.treatment,
              taxRate: trimRate(code.rate),
            });
          }
        }}
        className={className}
        title={taxCodes.find((code) => code.id === value)?.name}
      >
        {value === '' ? <option value="">—</option> : null}
        {taxCodes.map((code) => (
          <option key={code.id} value={code.id}>
            {code.code}
            {code.treatment === 'STANDARD' ? ` ${trimRate(code.rate)}%` : ''}
          </option>
        ))}
      </NativeSelect>
    );
  }
  return (
    <NativeSelect
      aria-label={label}
      value={line.vatTreatment}
      onChange={(event) =>
        onChange({ vatTreatment: event.target.value as VatTreatment, taxCodeId: '' })
      }
      className={className}
    >
      {VAT_TREATMENTS.map((treatment) => (
        <option key={treatment.value} value={treatment.value}>
          {treatment.short}
        </option>
      ))}
    </NativeSelect>
  );
}

/** Which income account a line books to; blank is the default for its type. */
function AccountSelect({
  label,
  value,
  itemType,
  accounts,
  onChange,
  large = false,
}: {
  label: string;
  value: string;
  itemType: LineType;
  accounts: { id: string; code: string; name: string }[];
  onChange: (accountId: string) => void;
  large?: boolean;
}) {
  return (
    <NativeSelect
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        'w-full min-w-0 rounded-lg border border-input bg-card px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50',
        large ? 'h-12 text-base' : 'h-9',
      )}
    >
      <option value="">Default — {itemType === 'LABOUR' ? 'labour' : 'parts'} sales</option>
      {accounts.map((account) => (
        <option key={account.id} value={account.id}>
          {account.code} · {account.name}
        </option>
      ))}
    </NativeSelect>
  );
}

/** "12.5" from a discount of `off` fils on `base` fils — the percentage it comes to. */
function percentOf(off: number, base: number) {
  if (base <= 0 || off <= 0) return '';
  return String(Math.round((off * 10000) / base) / 100);
}

/**
 * A discount box: the value, and a switch between a percentage and an AED
 * amount beside it. Blank means no discount.
 *
 * Given `base` (what it is taken off, in fils) and `computed` (what it
 * comes to, in AED), it shows both instead — a % box and an AED box, side
 * by side, either of which can be typed in: typing a percentage makes it a
 * percentage discount, typing an amount an AED one, and the other box shows
 * what that comes to.
 */
export function DiscountInput({
  label,
  type,
  value,
  onChange,
  large = false,
  base,
  computed,
}: {
  label: string;
  type: DiscountType;
  value: string;
  onChange: (discount: BillDiscount) => void;
  large?: boolean;
  /** What the discount is taken off, in fils. */
  base?: number;
  /** What it comes to, in AED. */
  computed?: string;
}) {
  if (base !== undefined && computed !== undefined) {
    const off = value.trim() ? safeFils(computed) : 0;
    const percent = type === 'PERCENT' ? value : percentOf(off, base);
    const amount = type === 'AMOUNT' ? value : off > 0 ? computed : '';
    // Fixed widths, so the pair never crowds out the boxes beside it in a row.
    const box = cn('min-w-0 text-right tabular-nums', large ? 'h-11 text-base md:text-sm' : 'h-9');
    return (
      <span className="flex items-center gap-1">
        <span className="relative">
          <NumberInput
            kind="rate"
            aria-label={`${label} (percent)`}
            value={percent}
            placeholder="0"
            onChange={(event) => onChange({ type: 'PERCENT', value: event.target.value })}
            className={cn(box, 'w-[4.5rem] pr-5')}
          />
          <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-xs text-muted-foreground">
            %
          </span>
        </span>
        <NumberInput
          kind="money"
          aria-label={`${label} (AED)`}
          value={amount}
          placeholder="0.00"
          onChange={(event) => onChange({ type: 'AMOUNT', value: event.target.value })}
          className={cn(box, large ? 'w-24' : 'w-[4.5rem]')}
        />
      </span>
    );
  }
  const other: DiscountType = type === 'PERCENT' ? 'AMOUNT' : 'PERCENT';
  const unit = (kind: DiscountType) => (kind === 'PERCENT' ? 'percent' : 'AED');
  return (
    <span className="flex">
      <NumberInput
        kind={type === 'PERCENT' ? 'rate' : 'money'}
        aria-label={`${label} (${unit(type)})`}
        value={value}
        placeholder="0"
        onChange={(event) => onChange({ type, value: event.target.value })}
        className={cn(
          'min-w-0 rounded-r-none text-right tabular-nums',
          large ? 'h-12 text-base' : 'w-20',
        )}
      />
      <button
        type="button"
        onClick={() => onChange({ type: other, value })}
        title={`Switch to ${unit(other)}`}
        aria-label={`${label}: switch to ${unit(other)}`}
        className={cn(
          'shrink-0 rounded-r-lg border border-l-0 border-input bg-muted/40 px-2.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
          large ? 'h-12 min-w-14' : 'h-9 min-w-11',
        )}
      >
        {type === 'PERCENT' ? '%' : 'AED'}
      </button>
    </span>
  );
}

function LabelledInput({
  label,
  aria,
  value,
  onChange,
  placeholder,
  numeric,
}: {
  label: string;
  aria: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** A number box, in the app's one standard. */
  numeric?: NumberKind;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {numeric ? (
        <NumberInput
          kind={numeric}
          aria-label={aria}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="h-12 text-base"
        />
      ) : (
        <Input
          aria-label={aria}
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          className="h-12 text-base"
        />
      )}
    </label>
  );
}
