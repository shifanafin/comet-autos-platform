'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/layout/primitives';
import {
  attachScannedBill,
  BillNotices,
  BillPreview,
  ScanBillButton,
  useBillScan,
} from '@/components/bill-reader/scan-bill';
import { ExpenseForm, type ExpenseDraft } from '@/components/finance/expense-form';
import { recordScannedExpenseAction } from '@/app/(app)/finance/actions';
import type { AccountChoice } from '@/lib/accounting/reports';
import type { TaxCodeOption } from '@/lib/accounting/tax-codes';
import type { JobChoice } from '@/lib/finance/job-costing';
import type { PaymentModeOption } from '@/lib/accounting/payment-modes';
import type { BillDraft } from '@/lib/bill-reader/read';
import type { ActionResult } from '@/lib/errors';

/** The tax code a scanned bill opens on: the standard code at its rate, or one that claims no VAT. */
function codeFor(codes: TaxCodeOption[], draft: BillDraft): string {
  const noVat =
    codes.find((code) => code.treatment === 'OUT_OF_SCOPE') ??
    codes.find((code) => Number(code.rate) === 0);
  const vat = Number(draft.vat ?? 0);
  const subtotal = Number(draft.subtotal ?? 0);
  if (!draft.isTaxInvoice || vat <= 0 || subtotal <= 0) return noVat?.id ?? '';
  const rate = Math.round((vat / subtotal) * 100);
  return (
    codes.find((code) => code.treatment === 'STANDARD' && Math.round(Number(code.rate)) === rate)
      ?.id ?? ''
  );
}

/** The expense form's starting values from what the reader found; the rest stays empty. */
function toPrefill(draft: BillDraft, codes: TaxCodeOption[]) {
  const flags: Record<string, string> = {};
  const prefill: Partial<Omit<ExpenseDraft, 'id'>> = {
    vendorName: draft.supplier?.name ?? draft.supplierName ?? '',
    billNumber: draft.billNumber ?? '',
    supplierTrn: draft.supplierTrn ?? '',
    taxCodeId: codeFor(codes, draft),
  };
  if (draft.billDate) prefill.expenseDate = draft.billDate;

  const reason = draft.warnings[0]?.message;
  if (!draft.isTaxInvoice) {
    // No VAT to reclaim: the whole amount paid is the expense.
    prefill.amount = draft.total ?? draft.subtotal ?? '';
    if (reason) flags.amount = reason;
  } else if (draft.subtotal) {
    prefill.amount = draft.subtotal;
    // The VAT exactly as the bill prints it — that is what is reclaimed.
    if (draft.vat) prefill.taxAmount = draft.vat;
    if (reason) flags.amount = reason;
  } else if (draft.total) {
    flags.amount = `Only the total (${draft.total}) could be read. Enter the amount before VAT.`;
  }
  return { prefill, flags };
}

/**
 * Recording an expense: one form, always there with every field. Type it all
 * by hand — or scan a photo or PDF of the supplier's bill, and whatever the
 * reader gets right is filled in, with the bill shown beside the form. What
 * it could not read stays empty to type; every filled value can be changed.
 * Saving records the expense and keeps the scanned file with it.
 */
export function ScanExpense({
  categories,
  defaultVatRate,
  moneyAccounts,
  taxCodes,
  modes,
  people = [],
  jobs,
  closeTo,
}: {
  categories: { id: string; accountCode: string; accountName: string }[];
  defaultVatRate: string;
  moneyAccounts: AccountChoice[];
  taxCodes: TaxCodeOption[];
  modes: PaymentModeOption[];
  people?: { id: string; name: string }[];
  jobs?: JobChoice[];
  /** On its own page: Save & close goes back here. */
  closeTo?: string;
}) {
  const router = useRouter();
  const { phase, scan, reset } = useBillScan('expense');
  // Each expense recorded by hand clears the form for the next one.
  const [saved, setSaved] = useState(0);
  const scanned = phase.name === 'ready' ? phase : null;
  const form = {
    categories,
    defaultVatRate,
    moneyAccounts,
    taxCodes,
    modes,
    people,
    jobs,
    closeTo,
  };

  async function save(_prev: ActionResult, formData: FormData): Promise<ActionResult> {
    const result = await recordScannedExpenseAction({ ok: false }, formData);
    if (scanned && result.ok && result.data?.id) {
      const problem = await attachScannedBill(
        `/finance/expenses/${result.data.id}/bill`,
        scanned.file,
      );
      if (problem) toast.warning(`Expense recorded, but the bill wasn’t attached: ${problem}`);
      router.refresh();
    }
    return { ok: result.ok, error: result.error, fieldErrors: result.fieldErrors };
  }

  const filled = scanned ? toPrefill(scanned.draft, taxCodes) : null;

  return (
    <Panel className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">
            {scanned ? 'Record an expense: filled from the bill' : 'Record an expense'}
          </p>
          <p className="text-sm text-muted-foreground">
            {scanned
              ? 'Check each value against the bill and change anything that is wrong. Empty fields could not be read: type them in. Nothing is saved until you press Record expense.'
              : 'Type the details, or scan the supplier’s bill to fill in what it can read. Rent, utilities, supplies: anything not bought for a specific job.'}
          </p>
        </div>
        {scanned ? (
          <Button type="button" variant="ghost" size="sm" onClick={reset}>
            <X />
            Clear the scan
          </Button>
        ) : (
          <ScanBillButton phase={phase} onFile={scan} size="default" />
        )}
      </div>
      {scanned && filled ? (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <BillNotices draft={scanned.draft} />
            <ExpenseForm
              key={scanned.previewUrl}
              {...form}
              prefill={filled.prefill}
              flags={filled.flags}
              hidden={{ scannedFields: scanned.draft.filled.join(',') || 'none' }}
              submit={save}
              onDone={reset}
            />
          </div>
          <BillPreview file={scanned.file} previewUrl={scanned.previewUrl} />
        </div>
      ) : (
        <ExpenseForm
          key={`manual-${saved}`}
          {...form}
          onDone={() => setSaved((count) => count + 1)}
        />
      )}
    </Panel>
  );
}
