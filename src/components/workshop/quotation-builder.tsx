'use client';

import type { TaxCodeOption } from '@/lib/accounting/tax-codes';
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Save, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FormError } from '@/components/forms/fields';
import { ConfirmAction } from '@/components/shared/confirm-action';
import { formatMoney } from '@/lib/format';
import {
  saveAndSendQuotationAction,
  saveQuotationDraftAction,
} from '@/app/(app)/quotations/actions';
import { CustomerLinkPanel } from '@/components/workshop/customer-link-panel';
import {
  DocumentLinesEditor,
  billDiscountPayload,
  linesPayload,
  newEditableLine,
  useLineTotals,
  type BillDiscount,
  type EditableLine,
} from '@/components/workshop/document-lines-editor';

/** A quotation line as the builder holds it. */
export type DraftLine = EditableLine;

/**
 * Pricing a quotation: the numbered Parts / Labour list of the workshop's
 * own sheet, a validity date, then save or send. Sending issues the secure
 * link and opens WhatsApp with the message ready.
 */
export function QuotationBuilder({
  estimateId,
  initialLines,
  initialBill,
  initialValidUntil,
  minValidUntil,
  recommendation,
  customerName,
  defaultVatRate,
  taxCodes
}: {
  estimateId: string;
  initialLines: DraftLine[];
  /** The discount on the whole quotation, as saved. */
  initialBill: BillDiscount;
  initialValidUntil: string;
  minValidUntil: string;
  recommendation: string | null;
  customerName: string;
  /** Organization default VAT rate, from lib/tax.ts on the server. */
  defaultVatRate: string;
  /** The sales tax codes a line can be given. */
  taxCodes?: TaxCodeOption[];
}) {
  const router = useRouter();
  // Most lines on a workshop quotation are parts, so a new one starts as a part.
  const [lines, setLines] = useState<DraftLine[]>(
    initialLines.length > 0
      ? initialLines
      : [newEditableLine('PART', defaultVatRate, taxCodes?.find((code) => code.isDefault) ?? null)],
  );
  const [bill, setBill] = useState<BillDiscount>(initialBill);
  const [validUntil, setValidUntil] = useState(initialValidUntil);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ link: string; whatsappUrl: string } | null>(null);
  const [pending, setPending] = useState<'save' | 'send' | null>(null);
  const [isPending, startTransition] = useTransition();
  const { totals, incomplete, count } = useLineTotals(lines, defaultVatRate, bill);

  function payload() {
    return { validUntil, items: linesPayload(lines), ...billDiscountPayload(bill) };
  }

  function save() {
    setError(null);
    setPending('save');
    startTransition(async () => {
      const result = await saveQuotationDraftAction(estimateId, payload());
      setPending(null);
      if (!result.ok) return setError(result.error ?? 'Could not save the quotation.');
      toast.success('Draft saved');
      router.refresh();
    });
  }

  function send() {
    setError(null);
    setPending('send');
    startTransition(async () => {
      const result = await saveAndSendQuotationAction(estimateId, payload());
      setPending(null);
      if (!result.ok || !result.data)
        return setError(result.error ?? 'Could not send the quotation.');
      setLink(result.data);
      toast.success('Quotation sent — share the link with the customer');
    });
  }

  if (link) {
    return (
      <CustomerLinkPanel
        link={link.link}
        whatsappUrl={link.whatsappUrl}
        customerName={customerName}
        onDone={() => router.refresh()}
      />
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {recommendation ? (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-4 sm:px-6">
          <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Recommended work (from diagnosis)
          </p>
          <p className="mt-2 text-sm whitespace-pre-wrap">{recommendation}</p>
        </div>
      ) : null}

      <DocumentLinesEditor
        lines={lines}
        onChange={setLines}
        bill={bill}
        onBillChange={setBill}
        defaultVatRate={defaultVatRate}
        taxCodes={taxCodes}
      />

      <Field
        label="Quotation valid until"
        htmlFor="validUntil"
        required
        hint="The customer's link stops working after this date."
      >
        <Input
          id="validUntil"
          type="date"
          min={minValidUntil}
          value={validUntil}
          onChange={(event) => setValidUntil(event.target.value)}
          className="h-11 max-w-48"
        />
      </Field>

      <FormError message={error ?? undefined} />

      <div className="flex flex-col-reverse gap-3 border-t border-border pt-6 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
        {incomplete ? (
          <p className="text-sm text-muted-foreground sm:mr-auto">
            Every line needs a description and a valid amount before sending.
          </p>
        ) : null}
        <Button
          variant="outline"
          size="lg"
          className="h-12 sm:h-10"
          disabled={isPending}
          onClick={save}
        >
          {pending === 'save' ? <Loader2 className="animate-spin" /> : <Save />}
          Save draft
        </Button>
        <ConfirmAction
          tone="default"
          trigger={
            <Button
              size="lg"
              className="h-12 sm:h-10"
              disabled={isPending || incomplete || count === 0}
            >
              {pending === 'send' ? <Loader2 className="animate-spin" /> : <Send />}
              Send to customer
            </Button>
          }
          title={`Send ${formatMoney(totals.totalAmount)} quotation?`}
          description={`The quotation is locked and ${customerName} gets a secure link to approve or reject it. Changes after this need a new version.`}
          confirmLabel="Send quotation"
          onConfirm={async () => send()}
        />
      </div>
    </div>
  );
}
