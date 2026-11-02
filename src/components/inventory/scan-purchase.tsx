'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Info, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  attachScannedBill,
  BillNotices,
  BillPreview,
  ScanBillButton,
  useBillScan,
} from '@/components/bill-reader/scan-bill';
import {
  PurchaseForm,
  type PurchaseFormInitial,
  type PurchasePart,
} from '@/components/inventory/purchase-form';
import { createScannedPurchaseAction } from '@/app/(app)/inventory/actions';
import type { TaxCodeOption } from '@/lib/accounting/tax-codes';
import type { ReceiptOptions } from '@/components/inventory/receipt-settlement';
import type { BillDraft } from '@/lib/bill-reader/read';
import type { ActionResult } from '@/lib/errors';

/** The purchase form's starting values from what the reader found. */
function toInitial(draft: BillDraft, fallback: PurchaseFormInitial | undefined, today: string) {
  const subtotal = Number(draft.subtotal ?? 0);
  const vat = Number(draft.vat ?? 0);
  const rate =
    draft.isTaxInvoice && subtotal > 0 ? String(Math.round((vat / subtotal) * 100)) : '0';
  return {
    supplierId: draft.supplier?.id ?? fallback?.supplierId ?? '',
    supplierInvoiceNumber: draft.billNumber ?? '',
    // A purchase can't be dated in the future; a misread date falls back to today.
    supplierInvoiceDate: draft.billDate && draft.billDate <= today ? draft.billDate : today,
    notes: '',
    // Only rows that read as a part on file: a line needs its part.
    items: draft.lines
      .filter((line) => line.partId)
      .map((line) => ({
        partId: line.partId,
        quantity: line.quantity,
        unitCost: line.unitPrice,
        taxRate: rate,
      })),
  } satisfies PurchaseFormInitial;
}

/**
 * New purchase, with "Scan bill": the same form, opened on what a photo or
 * PDF of the supplier's invoice says, with the bill beside it. Saving
 * creates the purchase and keeps the file with it.
 */
export function ScanPurchase({
  action,
  parts,
  canCreateParts,
  suppliers,
  defaultVat,
  taxCodes,
  jobs,
  today,
  initial,
  canReceive,
  cancelHref,
  receipt,
}: {
  /** The usual create action, used when nothing was scanned. */
  action: (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
  parts: PurchasePart[];
  /** Whether a missing part can be added from the line picker. */
  canCreateParts?: boolean;
  suppliers: { id: string; name: string }[];
  defaultVat: string;
  taxCodes: TaxCodeOption[];
  jobs?: { value: string; label: string; hint: string }[];
  today: string;
  initial?: PurchaseFormInitial;
  canReceive: boolean;
  cancelHref: string;
  /** Paying the supplier as the goods are received. */
  receipt?: ReceiptOptions;
}) {
  const router = useRouter();
  const { phase, scan, reset } = useBillScan('purchase');
  const scanned = phase.name === 'ready' ? phase : null;
  const form = {
    parts,
    canCreateParts,
    suppliers,
    defaultVat,
    taxCodes,
    jobs,
    today,
    isNew: true,
    canReceive,
    cancelHref,
    receipt,
  };

  if (!scanned) {
    return (
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            Have the supplier’s invoice? Scan a photo or PDF and the form fills itself for you to
            check.
          </p>
          <ScanBillButton phase={phase} onFile={scan} size="default" />
        </div>
        <PurchaseForm action={action} initial={initial} {...form} />
      </div>
    );
  }

  const { draft, file, previewUrl } = scanned;
  const unmatched = draft.lines.filter((line) => !line.partId);

  async function save(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
    const result = await createScannedPurchaseAction({ ok: false }, formData);
    if (result.data?.id) {
      const problem = await attachScannedBill(`/inventory/purchases/${result.data.id}/bill`, file);
      if (problem) toast.warning(`Purchase saved, but the bill wasn’t attached: ${problem}`);
      router.push(`/inventory/purchases/${result.data.id}`);
    }
    return { ok: result.ok, error: result.error, fieldErrors: result.fieldErrors };
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">Scanned bill — check, then save</p>
          <p className="text-sm text-muted-foreground">
            Filled from the bill where it could be read. Nothing is saved until you save the
            purchase.
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={reset}>
          <X />
          Discard
        </Button>
      </div>
      {/* The bill beside the purchase's details; the parts below get the whole width. */}
      <PurchaseForm
        key={previewUrl}
        action={save}
        initial={toInitial(draft, initial, today)}
        hidden={{ scannedFields: draft.filled.join(',') || 'none' }}
        aside={<BillPreview file={file} previewUrl={previewUrl} />}
        intro={
          <>
            <BillNotices draft={draft} />
            {!draft.supplier ? (
              <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
                <Info className="mt-0.5 size-4 shrink-0" />
                <span>
                  {draft.supplierName
                    ? `“${draft.supplierName}” isn’t a supplier on file.`
                    : 'The supplier couldn’t be read.'}{' '}
                  Choose one below, or{' '}
                  <Link
                    href="/inventory/suppliers/new"
                    target="_blank"
                    className="font-medium underline"
                  >
                    add the supplier
                  </Link>{' '}
                  (with their TRN{draft.supplierTrn ? ` ${draft.supplierTrn}` : ''}) and scan again.
                </span>
              </p>
            ) : null}
            {unmatched.length > 0 ? (
              <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm">
                <p className="font-medium">
                  {unmatched.length} row{unmatched.length === 1 ? '' : 's'} on the bill didn’t match
                  a part on file — add {unmatched.length === 1 ? 'it' : 'them'} below:
                </p>
                <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
                  {unmatched.map((line, index) => (
                    <li key={index} className="tabular-nums">
                      {line.description} — {line.quantity} × {line.unitPrice} = {line.amount}
                    </li>
                  ))}
                </ul>
              </div>
            ) : draft.lines.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                The item rows couldn’t be read reliably, so none were filled in. Add the parts
                below.
              </p>
            ) : null}
          </>
        }
        {...form}
      />
    </div>
  );
}
