'use client';

import { useRef, useState, useTransition } from 'react';
import { NumberInput } from '@/components/forms/number-input';
import { useRouter } from 'next/navigation';
import { ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Field, FormError, TextareaField } from '@/components/forms/fields';
import { Panel } from '@/components/layout/primitives';
import { formatMoney } from '@/lib/format';
import { filsToString, prorateFils, toFils } from '@/lib/money';
import { VAT_TREATMENT_LABEL, type VatTreatment } from '@/lib/vat-treatment';
import { splitInclusive, type PriceBasis } from '@/lib/vat-entry';
import { PriceBasisToggle } from '@/components/forms/price-basis-toggle';
import { createCreditNoteAction } from '@/app/(app)/finance/credit-notes/actions';

/*
 * Issuing a tax credit note: which invoice lines come back, and by how much.
 * Amounts are before VAT; the VAT on each follows the invoice line's own rate
 * (the server works out the exact figures — what is shown here is the same
 * rule, for checking before issuing).
 */

export interface CreditableLine {
  id: string;
  itemType: string | null;
  description: string;
  quantity: string;
  vatTreatment: VatTreatment;
  taxRate: string;
  net: string;
  remaining: string;
  remainingTax: string;
  /** A part sold from stock: what is credited can go back on the shelf. */
  stocked?: boolean;
  /** How many of it can still come back into stock. */
  returnable?: string;
}

const AMOUNT = /^\d+(\.\d{1,2})?$/;

function newRequestKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const milli = (value: string) => Math.round(Number(value) * 1000);

/** The VAT a credit of `amount` fils takes back on a line — the server's rule. */
function vatOn(line: CreditableLine, amount: number) {
  if (amount === toFils(line.remaining)) return toFils(line.remainingTax);
  const hundredths = Math.round(Number(line.taxRate) * 100);
  return Math.min(Math.round((amount * hundredths) / 10000), toFils(line.remainingTax));
}

export function CreditNoteForm({
  invoiceId,
  lines,
  today,
  due,
  advanceApplied = '0.00',
}: {
  invoiceId: string;
  lines: CreditableLine[];
  /** Today, as YYYY-MM-DD in workshop time. */
  today: string;
  /** What the customer still owes on the invoice now. */
  due: string;
  /** Settled from customer advances: any excess goes back to them first. */
  advanceApplied?: string;
}) {
  const router = useRouter();
  const requestKey = useRef(newRequestKey());
  const [issueDate, setIssueDate] = useState(today);
  const [reason, setReason] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  /** Lines whose units came back onto the shelf. */
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();
  // Credits typed with VAT: what was typed is kept here; `amounts` stays before VAT.
  const [basis, setBasis] = useState<PriceBasis>('EXCLUSIVE');
  const [typedCredits, setTypedCredits] = useState<Record<string, string>>({});
  const inclusive = basis === 'INCLUSIVE';

  const open = lines.filter((line) => toFils(line.remaining) > 0);
  const valid = (value: string | undefined) => (value && AMOUNT.test(value) ? toFils(value) : 0);
  let net = 0;
  let vat = 0;
  for (const line of open) {
    const amount = Math.min(valid(amounts[line.id]), toFils(line.remaining));
    net += amount;
    vat += amount > 0 ? vatOn(line, amount) : 0;
  }
  const total = net + vat;
  const excess = Math.max(total - toFils(due), 0);
  // Back to the customer's advances first, as far as advances settled it; the rest in cash.
  const toAdvances = Math.min(excess, toFils(advanceApplied));
  const refund = excess - toAdvances;

  function creditAll() {
    setAmounts(Object.fromEntries(open.map((line) => [line.id, line.remaining])));
    setQuantities({});
    setTypedCredits({});
  }

  /** A credit typed for a line: before VAT, or with it when typing with VAT. */
  function typeCredit(line: CreditableLine, value: string) {
    let credit = value;
    if (inclusive) {
      setTypedCredits((current) => ({ ...current, [line.id]: value }));
      // The whole of what is left stays exact, whatever the rounding on the way.
      const everything = toFils(line.remaining) + toFils(line.remainingTax);
      credit =
        AMOUNT.test(value) && toFils(value) === everything
          ? line.remaining
          : (splitInclusive(value, line.taxRate)?.net ?? '');
    }
    setAmounts((current) => ({ ...current, [line.id]: credit }));
    setQuantities((current) => ({ ...current, [line.id]: '' }));
  }

  function shownCredit(line: CreditableLine) {
    if (!inclusive) return amounts[line.id] ?? '';
    const typed = typedCredits[line.id];
    if (typed !== undefined) return typed;
    const amount = Math.min(valid(amounts[line.id]), toFils(line.remaining));
    return amount > 0 ? filsToString(amount + vatOn(line, amount)) : '';
  }

  function setQuantity(line: CreditableLine, value: string) {
    setQuantities((current) => ({ ...current, [line.id]: value }));
    setTypedCredits((current) => {
      const rest = { ...current };
      delete rest[line.id];
      return rest;
    });
    const qty = milli(value);
    if (!Number.isFinite(qty) || qty <= 0) return;
    // Units coming back from a part sold from stock go back on the shelf,
    // unless unticked (a part the customer kept, or one thrown away).
    if (line.stocked && restock[line.id] === undefined) {
      setRestock((current) => ({ ...current, [line.id]: true }));
    }
    // That share of the line, never more than what is left on it.
    const amount = Math.min(
      prorateFils(toFils(line.net), qty, milli(line.quantity)),
      toFils(line.remaining),
    );
    setAmounts((current) => ({ ...current, [line.id]: filsToString(amount) }));
  }

  function submit() {
    setError(null);
    setFieldErrors({});
    startTransition(async () => {
      const result = await createCreditNoteAction(invoiceId, {
        issueDate,
        reason,
        lines: open.map((line) => ({
          invoiceItemId: line.id,
          amount: amounts[line.id] ?? '',
          quantity: quantities[line.id] || undefined,
          restock: line.stocked && restock[line.id] ? '1' : undefined,
        })),
        requestKey: requestKey.current,
      });
      if ((result.ok || result.duplicate) && result.data) {
        toast.success(
          toFils(result.data.refundAmount) > 0
            ? `Credit note issued. ${formatMoney(result.data.refundAmount)} is owed back to the customer.`
            : toFils(result.data.returnedToAdvances) > 0
              ? `Credit note issued. ${formatMoney(result.data.returnedToAdvances)} is back on the customer's advance.`
              : 'Credit note issued',
        );
        router.push(`/finance/credit-notes/${result.data.creditNoteId}`);
        return;
      }
      setError(result.error ?? 'The credit note could not be issued.');
      setFieldErrors(result.fieldErrors ?? {});
    });
  }

  if (open.length === 0) {
    return (
      <Panel>
        <p className="text-sm text-muted-foreground">Every line has been credited in full.</p>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Panel padding="none" className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
          <p className="text-sm text-muted-foreground">
            Enter what each line is credited by — or how many of its units come back.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <PriceBasisToggle
              label="Credits are"
              value={basis}
              onChange={(next) => {
                setBasis(next);
                setTypedCredits({});
              }}
            />
            <Button type="button" variant="outline" size="sm" onClick={creditAll}>
              Credit everything left
            </Button>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-3 pl-6">Line</th>
                <th className="w-28 px-2 py-3 text-right">Left to credit</th>
                <th className="w-24 px-2 py-3 text-right">Qty back</th>
                <th className="w-36 px-2 py-3 text-right">
                  {inclusive ? 'Credit (incl. VAT)' : 'Credit (excl. VAT)'}
                </th>
                <th className="w-28 px-4 py-3 pr-6 text-right">VAT</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {lines.map((line, index) => {
                const left = toFils(line.remaining);
                const amount = Math.min(valid(amounts[line.id]), left);
                const lineError = fieldErrors[`lines.${index}.amount`] ?? fieldErrors[`lines.${index}`];
                return (
                  <tr key={line.id} className={left === 0 ? 'text-muted-foreground' : undefined}>
                    <td className="px-4 py-3 pl-6">
                      <span className="block font-medium">{line.description}</span>
                      <span className="block text-xs text-muted-foreground">
                        Qty {Number(line.quantity)} · {formatMoney(line.net)} ·{' '}
                        {VAT_TREATMENT_LABEL[line.vatTreatment]}
                      </span>
                      {lineError ? (
                        <span className="block text-xs text-destructive">{lineError}</span>
                      ) : null}
                    </td>
                    <td className="px-2 py-3 text-right tabular-nums">
                      {left === 0
                        ? 'Credited'
                        : formatMoney(
                            inclusive
                              ? filsToString(left + toFils(line.remainingTax))
                              : line.remaining,
                          )}
                    </td>
                    <td className="px-2 py-3">
                      {left > 0 ? (
                        <NumberInput kind="quantity"
                          aria-label={`${line.description}: quantity coming back`}
                          value={quantities[line.id] ?? ''}
                          onChange={(event) => setQuantity(line, event.target.value)}
                          className="text-right tabular-nums"
                        />
                      ) : null}
                      {left > 0 && line.stocked && Number(line.returnable ?? 0) > 0 ? (
                        <label className="mt-1.5 flex items-center justify-end gap-1.5 text-xs text-muted-foreground">
                          <input
                            type="checkbox"
                            checked={Boolean(restock[line.id])}
                            onChange={(event) =>
                              setRestock((current) => ({
                                ...current,
                                [line.id]: event.target.checked,
                              }))
                            }
                            className="size-3.5 accent-primary"
                          />
                          Back in stock
                        </label>
                      ) : null}
                    </td>
                    <td className="px-2 py-3">
                      {left > 0 ? (
                        <NumberInput
                          aria-label={`${line.description}: amount to credit`}
                          placeholder="0.00"
                          value={shownCredit(line)}
                          onChange={(event) => typeCredit(line, event.target.value)}
                          className="text-right tabular-nums"
                        />
                      ) : null}
                    </td>
                    <td className="px-4 py-3 pr-6 text-right tabular-nums">
                      {amount > 0 ? formatMoney(filsToString(vatOn(line, amount))) : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="border-t border-border bg-muted/20 text-sm">
              <tr>
                <td colSpan={3} className="px-4 py-2 pl-6 text-right text-muted-foreground">
                  Total excl. VAT
                </td>
                <td className="px-2 py-2 text-right tabular-nums">{formatMoney(filsToString(net))}</td>
                <td className="px-4 py-2 pr-6 text-right tabular-nums">
                  {formatMoney(filsToString(vat))}
                </td>
              </tr>
              <tr className="font-semibold">
                <td colSpan={3} className="px-4 py-3 pl-6 text-right">
                  Total credited
                </td>
                <td colSpan={2} className="px-4 py-3 pr-6 text-right tabular-nums">
                  {formatMoney(filsToString(total))}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Panel>

      <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
        <Field label="Credit note date" htmlFor="issueDate" required error={fieldErrors.issueDate}>
          <Input
            id="issueDate"
            type="date"
            value={issueDate}
            max={today}
            onChange={(event) => setIssueDate(event.target.value)}
            className="h-11"
          />
        </Field>
        <TextareaField
          label="Reason"
          name="reason"
          required
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          error={fieldErrors.reason}
          hint="Printed on the credit note, e.g. part returned unused, or price agreed after the job."
          className="[&_textarea]:min-h-16"
        />
      </div>

      {total > 0 ? (
        <p className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-sm">
          {excess > 0
            ? [
                `The customer owes ${formatMoney(due)} now.`,
                toAdvances > 0
                  ? `${formatMoney(filsToString(toAdvances))} of this credit goes back on the customer's advance, to use on another invoice or refund.`
                  : null,
                refund > 0
                  ? `${formatMoney(filsToString(refund))} is to be refunded to them. Record the refund on the credit note once it is paid.`
                  : null,
              ]
                .filter(Boolean)
                .join(' ')
            : `The customer will owe ${formatMoney(filsToString(toFils(due) - total))} on the invoice after this credit.`}
        </p>
      ) : null}

      <FormError message={error ?? undefined} />
      <div className="border-t border-border pt-4">
        <Button
          type="button"
          size="lg"
          className="h-11"
          disabled={isPending || total === 0}
          onClick={submit}
        >
          <ReceiptText />
          {isPending ? 'Issuing…' : 'Issue credit note'}
        </Button>
      </div>
    </div>
  );
}
