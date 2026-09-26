'use client';

import { Ban, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ReasonAction } from '@/components/shared/reason-action';
import {
  reverseInvoicePaymentAction,
  voidInvoiceAction,
} from '@/app/(app)/finance/invoices/actions';

/** Withdraws an unpaid invoice, keeping it on record as void. */
export function VoidInvoiceButton({
  invoiceId,
  invoiceNumber,
  hasWorkOrder,
}: {
  invoiceId: string;
  invoiceNumber: string;
  hasWorkOrder: boolean;
}) {
  return (
    <ReasonAction
      trigger={
        <Button variant="outline" className="h-10">
          <Ban />
          Void
        </Button>
      }
      title={`Void invoice ${invoiceNumber}?`}
      description={`It stays on record, marked void, and its number is not reused.${
        hasWorkOrder ? ' The job card goes back to where it was, ready to be invoiced again.' : ''
      }`}
      placeholder="e.g. Wrong customer, or billed twice."
      confirmLabel="Void invoice"
      successMessage={`Invoice ${invoiceNumber} voided`}
      onConfirm={(input) => voidInvoiceAction(invoiceId, input)}
    />
  );
}

/** Undoes a payment recorded in error. The payment itself stays on record. */
export function ReversePaymentButton({
  invoiceId,
  paymentId,
  label,
}: {
  invoiceId: string;
  paymentId: string;
  /** e.g. "AED 250.00 cash" — what is being reversed, in words. */
  label: string;
}) {
  return (
    <ReasonAction
      trigger={
        <Button variant="ghost" size="sm">
          <Undo2 />
          Reverse
        </Button>
      }
      title="Reverse this payment?"
      description={`${label} stops counting against the invoice, and the balance goes back up by that amount. The payment and its reversal both stay on record.`}
      placeholder="e.g. Entered twice, or the card payment failed."
      confirmLabel="Reverse payment"
      successMessage="Payment reversed"
      onConfirm={(input) => reverseInvoicePaymentAction(invoiceId, paymentId, input)}
    />
  );
}
