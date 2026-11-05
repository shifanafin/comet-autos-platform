'use client';

import type { PartCatalog } from '@/lib/inventory/part-options';
import type { TaxCodeOption } from '@/lib/accounting/tax-codes';
import type { PaymentModeOption } from '@/lib/accounting/payment-modes';
import { PaymentModeField } from '@/components/accounting/payment-mode-field';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Banknote, FileText, Receipt } from 'lucide-react';
import {
  Field,
  FormError,
  NativeSelect,
  TextField,
  TextareaField,
} from '@/components/forms/fields';
import { ReferenceField } from '@/components/forms/reference-field';
import { PAYMENT_METHODS } from '@/components/finance/invoice-payment-form';
import { MoneyAccountField } from '@/components/accounting/money-account-field';
import type { AccountChoice } from '@/lib/accounting/reports';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { CustomerPicker, type PickedParty } from '@/components/workshop/customer-picker';
import {
  DocumentLinesEditor,
  NO_BILL_DISCOUNT,
  billDiscountPayload,
  linesPayload,
  newEditableLine,
  partIssueMessage,
  partLineIssues,
  useCatalogParts,
  useLineTotals,
  withRoundOff,
  type BillDiscount,
  type EditableLine,
} from '@/components/workshop/document-lines-editor';
import { formatMoney, localDateString } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import type { HeldAdvances } from '@/lib/billing/advances';
import type { ActionResult } from '@/lib/errors';
import type { CustomerOption } from '@/lib/customers/picker';
import { createDirectInvoiceAction, heldAdvancesAction } from '../actions';

/*
 * Billing what was done. Either the lines are typed here — in the numbered
 * Parts / Labour list of the workshop's own sheet — or a quotation fills
 * them in: left untouched it is billed exactly as quoted; any line,
 * discount or price changed and the lines on the form are billed instead.
 *
 * Money the customer paid in advance can be applied as the invoice is
 * issued; a sale paid on the spot then takes only what is still due.
 *
 * Every figure shown while typing is produced by the same lib/money rules
 * the server bills with, so the total on screen is the total on the invoice
 * — but the browser's numbers are never trusted: the server prices the lines
 * again from the description, quantity and rate.
 */

export interface QuotationChoice {
  id: string;
  estimateNumber: string;
  totalAmount: string;
  lineCount: number;
  customerId: string;
  customerName: string;
  vehicleId: string | null;
  jobCardId: string | null;
  /** Its lines and bill discount, ready to edit. */
  lines: EditableLine[];
  bill: BillDiscount;
}

export function NewInvoiceForm({
  initialCustomer,
  initialWorkOrder = null,
  quotation,
  defaultVatRate,
  initialPayNow = false,
  canTakePayment,
  incomeAccounts,
  moneyAccounts = [],
  taxCodes,
  catalog,
  modes = [],
  initialAdvances = null,
  partsFitted = false,
}: {
  initialCustomer: CustomerOption | null;
  /** Set when arriving from a job card: it is billed, and moves to Invoiced. */
  initialWorkOrder?: { id: string; vehicleId: string } | null;
  /** Set when arriving from an approved quotation: its lines are billed as quoted. */
  quotation: QuotationChoice | null;
  defaultVatRate: string;
  /** Start as a sales receipt — the customer pays on the spot. */
  initialPayNow?: boolean;
  /** Whether this user may record payments at all. */
  canTakePayment: boolean;
  /** Income accounts a line can book to; omitted, every line uses the default. */
  incomeAccounts?: AccountChoice[];
  /** Cash, bank and card accounts a sales receipt's money can go into. */
  moneyAccounts?: AccountChoice[];
  /** The sales tax codes a line can be given. */
  taxCodes?: TaxCodeOption[];
  /** The inventory, for picking a part on a Parts line. */
  catalog?: PartCatalog;
  /** The receipt modes (payment mode master) for a sales receipt. */
  modes?: PaymentModeOption[];
  /** The first customer's advances with money left (null: none, or not allowed). */
  initialAdvances?: HeldAdvances | null;
  /**
   * Billing a job card whose parts were fitted through its repair records:
   * they left stock then, so its Parts lines need not name a part.
   */
  partsFitted?: boolean;
}) {
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(createDirectInvoiceAction, {
    ok: false,
  });
  const [picked, setPicked] = useState<PickedParty | null>(
    initialCustomer
      ? {
          customer: initialCustomer,
          vehicleId:
            quotation?.vehicleId ??
            initialWorkOrder?.vehicleId ??
            (initialCustomer.vehicles.length === 1 ? initialCustomer.vehicles[0].id : ''),
          jobCardId: quotation?.jobCardId ?? initialWorkOrder?.id ?? '',
        }
      : null,
  );
  // A quotation fixes the customer and the car; one not yet on a job card can
  // still be billed against the job, which files the quotation there too.
  const chooseJob = (next: PickedParty | null) => {
    if (next && picked && next.customer.id === picked.customer.id) {
      setPicked({ ...picked, jobCardId: next.jobCardId });
    }
  };
  const [lines, setLinesState] = useState<EditableLine[]>(
    quotation?.lines.length
      ? quotation.lines
      : [newEditableLine('PART', defaultVatRate, taxCodes?.find((code) => code.isDefault) ?? null)],
  );
  const [bill, setBillState] = useState<BillDiscount>(quotation?.bill ?? NO_BILL_DISCOUNT);
  // A quotation left untouched is billed exactly as quoted.
  const [edited, setEdited] = useState(false);
  const setLines = (next: EditableLine[]) => {
    setEdited(true);
    setLinesState(next);
  };
  const setBill = (next: BillDiscount) => {
    setEdited(true);
    setBillState(next);
  };
  const [rounding, setRoundingState] = useState('');
  const setRounding = (next: string) => {
    setEdited(true);
    setRoundingState(next);
  };
  const [payNow, setPayNow] = useState(initialPayNow && canTakePayment);
  const errors = state.fieldErrors ?? {};
  const { totals, incomplete, count } = useLineTotals(lines, defaultVatRate, bill);
  // Every Parts line names a part that is in stock (lib/billing/part-lines.ts).
  const catalogParts = useCatalogParts(catalog);
  const partIssue =
    catalog && !partsFitted ? partIssueMessage(partLineIssues(lines, catalogParts.parts)) : null;
  const ready = Boolean(picked) && count > 0 && !incomplete && !partIssue;
  const asQuoted = quotation !== null && !edited;
  const payload = JSON.stringify(asQuoted ? [] : linesPayload(lines));
  const discount = asQuoted ? null : billDiscountPayload(bill);
  const today = localDateString();

  // The chosen customer's advances: offered on the invoice when there are any.
  const customerId = picked?.customer.id ?? '';
  const [advances, setAdvances] = useState<{ customerId: string; data: HeldAdvances | null }>({
    customerId: initialCustomer?.id ?? '',
    data: initialAdvances,
  });
  useEffect(() => {
    if (!customerId || customerId === advances.customerId) return;
    let live = true;
    heldAdvancesAction(customerId).then((data) => {
      if (live) setAdvances({ customerId, data });
    });
    return () => {
      live = false;
    };
  }, [customerId, advances.customerId]);
  const held = advances.customerId === customerId ? advances.data : null;
  const heldFils = held ? toFils(held.total) : 0;
  const [useAdvance, setUseAdvance] = useState(false);
  const [advanceAmount, setAdvanceAmount] = useState<string | null>(null);
  const totalFils =
    count > 0 && !incomplete ? toFils(withRoundOff(totals.totalAmount, rounding)) : 0;
  const suggested = filsToString(Math.min(heldFils, totalFils));
  const applying = useAdvance && heldFils > 0 && Boolean(held?.canApply);
  const applyFils = applying ? toFils(advanceAmount || suggested || '0') : 0;
  const leftToPay = filsToString(Math.max(totalFils - applyFils, 0));

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-8">
      <input type="hidden" name="customerId" value={picked?.customer.id ?? ''} />
      <input type="hidden" name="vehicleId" value={picked?.vehicleId ?? ''} />
      <input type="hidden" name="jobCardId" value={picked?.jobCardId ?? ''} />
      <input type="hidden" name="estimateId" value={quotation?.id ?? ''} />
      <input type="hidden" name="items" value={payload} />
      {discount ? (
        <>
          <input type="hidden" name="discountType" value={discount.discountType} />
          <input type="hidden" name="discount" value={discount.discount} />
        </>
      ) : null}

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold tracking-tight">Who is this invoice for?</h2>
        <CustomerPicker
          value={picked}
          onChange={quotation ? (quotation.jobCardId ? () => {} : chooseJob) : setPicked}
          autoFocus={!initialCustomer}
        />
      </section>

      {quotation ? (
        <section className="flex flex-col gap-4">
          <h2 className="text-base font-semibold tracking-tight">What is being billed</h2>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-muted/40 p-4">
            <span className="flex min-w-0 items-center gap-3">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">Quotation {quotation.estimateNumber}</span>
                <span className="truncate text-sm text-muted-foreground">
                  {quotation.lineCount} line{quotation.lineCount === 1 ? '' : 's'} ·{' '}
                  {formatMoney(quotation.totalAmount)}
                </span>
              </span>
            </span>
            <Link
              href={`/quotations/${quotation.id}`}
              className="text-sm font-medium text-primary hover:underline"
            >
              View quotation
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            {asQuoted
              ? 'Billed exactly as quoted. Change any line, price or discount below and the invoice is billed as changed.'
              : 'Changed from the quotation: the lines below are what will be billed. The invoice still records which quotation it came from.'}
          </p>
        </section>
      ) : null}
      <section className="flex flex-col gap-4">
        <h2 className="text-base font-semibold tracking-tight">What are you billing?</h2>
        <DocumentLinesEditor
          lines={lines}
          onChange={setLines}
          bill={bill}
          onBillChange={setBill}
          defaultVatRate={defaultVatRate}
          incomeAccounts={incomeAccounts}
          taxCodes={taxCodes}
          catalog={catalog}
          requireParts={!partsFitted}
          onPartAdded={catalogParts.add}
          rounding={rounding}
          onRoundingChange={setRounding}
        />
        {partIssue && count > 0 ? (
          <p className="text-sm font-medium text-warning">{partIssue}</p>
        ) : null}
        <input type="hidden" name="roundingAdjustment" value={rounding} />
      </section>

      {held && heldFils > 0 ? (
        <section className="flex flex-col gap-4 rounded-xl border border-border p-4 sm:p-5">
          {held.canApply ? (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                name="applyAdvance"
                value="1"
                checked={useAdvance}
                onChange={(event) => setUseAdvance(event.target.checked)}
                className="mt-1 size-4 accent-primary"
              />
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">
                  {`Use the customer's advance — ${formatMoney(held.total)} held`}
                </span>
                <span className="text-sm text-muted-foreground">
                  {held.advances
                    .map(
                      (advance) =>
                        `${advance.advanceNumber}${advance.jobNumber ? ` (${advance.jobNumber})` : ''}: ${formatMoney(advance.left)}`,
                    )
                    .join(' · ')}
                  . It settles the invoice like a payment; the invoice&apos;s sales and VAT do not
                  change.
                </span>
              </span>
            </label>
          ) : (
            <p className="text-sm text-muted-foreground">
              {`The customer has ${formatMoney(held.total)} paid in advance. Someone allowed to apply advances can apply it on the invoice once it is issued.`}
            </p>
          )}
          {applying ? (
            <TextField
              label="Advance to apply (AED)"
              name="advanceAmount"
              numeric="money"
              value={advanceAmount ?? suggested}
              onChange={(event) => setAdvanceAmount(event.target.value)}
              error={errors.advanceAmount}
              hint={`Up to ${formatMoney(suggested)}. What is left on the invoice: ${formatMoney(leftToPay)}.`}
              className="max-w-xs [&_input]:h-11"
            />
          ) : null}
        </section>
      ) : null}

      <div className="grid gap-6 sm:grid-cols-2">
        <TextField
          label="Due date"
          name="dueDate"
          type="date"
          min={today}
          defaultValue={today}
          error={errors.dueDate}
          hint="Leave as today when the customer pays on collection."
          className="[&_input]:h-11"
        />
        <TextField
          label="Customer's order no. (LPO)"
          name="customerReference"
          error={errors.customerReference}
          hint="Optional — printed on the invoice."
          className="[&_input]:h-11"
        />
      </div>

      {canTakePayment ? (
        <section className="flex flex-col gap-4 rounded-xl border border-border p-4 sm:p-5">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              name="payNow"
              value="1"
              checked={payNow}
              onChange={(event) => setPayNow(event.target.checked)}
              className="mt-1 size-4 accent-primary"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">The customer is paying now (sales receipt)</span>
              <span className="text-sm text-muted-foreground">
                {applying
                  ? `What is left after the advance (${formatMoney(leftToPay)}) is recorded as received, and a receipt is issued.`
                  : 'The full total is recorded as received with the invoice, and a receipt is issued.'}{' '}
                Leave unticked to bill now and take payment later.
              </span>
            </span>
          </label>
          {payNow ? (
            <div className="grid gap-6 sm:grid-cols-2">
              {modes.length ? (
                <PaymentModeField
                  id="paymentMode"
                  modes={modes}
                  label="Received by"
                  methodName="paymentMethod"
                  accountName="paymentAccountId"
                  error={errors.paymentMethod ?? errors.paymentAccountId}
                  className="h-11"
                />
              ) : (
                <Field
                  label="Paid by"
                  htmlFor="paymentMethod"
                  required
                  error={errors.paymentMethod}
                >
                  <NativeSelect
                    id="paymentMethod"
                    name="paymentMethod"
                    defaultValue="CASH"
                    className="h-11"
                  >
                    {PAYMENT_METHODS.map((method) => (
                      <option key={method.value} value={method.value}>
                        {method.label}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              )}
              <ReferenceField
                label="Payment reference"
                name="paymentReference"
                error={errors.paymentReference}
                hint="Optional — card slip, transfer or cheque number."
                className="[&_input]:h-11"
              />
              {moneyAccounts.length && !modes.length ? (
                <MoneyAccountField
                  id="paymentAccountId"
                  name="paymentAccountId"
                  label="Deposited into"
                  accounts={moneyAccounts}
                  error={errors.paymentAccountId}
                  className="h-11"
                />
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      <TextareaField
        label="Notes on the invoice"
        name="notes"
        error={errors.notes}
        hint="Optional — shown to the customer."
        className="[&_textarea]:min-h-16"
      />

      <FormError
        message={
          state.error ??
          errors.customerId ??
          errors.vehicleId ??
          errors.jobCardId ??
          errors.items ??
          errors.discount ??
          errors.roundingAdjustment ??
          errors.advanceAmount
        }
      />

      <div className="border-t border-border pt-6">
        <SubmitButton
          pending={isPending}
          size="lg"
          disabled={!ready}
          className="h-12 w-full sm:h-11 sm:w-auto"
          pendingLabel="Issuing…"
        >
          {payNow ? <Banknote /> : <Receipt />}
          {payNow ? 'Issue and record payment' : 'Issue invoice'}
          {asQuoted
            ? ` · ${formatMoney(quotation!.totalAmount)}`
            : count > 0 && !incomplete
              ? ` · ${formatMoney(withRoundOff(totals.totalAmount, rounding))}`
              : ''}
        </SubmitButton>
        <p className="mt-3 text-sm text-muted-foreground">
          {payNow
            ? 'The invoice is issued with its own number and marked paid, with a receipt for the payment.'
            : 'The invoice is issued straight away with its own number. Record the payment on the next screen.'}
        </p>
      </div>
    </form>
  );
}
