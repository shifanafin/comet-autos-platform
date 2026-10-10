'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banknote, FileCheck2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import { formatMoney } from '@/lib/format';
import type { ActionResult } from '@/lib/errors';
import { fileVatReturnAction, settleVatReturnAction } from '@/app/(app)/finance/vat/actions';

/** Records the return shown as filed on EmaraTax. */
export function FileVatReturnForm({
  from,
  to,
  today,
  net,
}: {
  /** The period, YYYY-MM-DD. */
  from: string;
  to: string;
  today: string;
  /** Box 14, as worked out. */
  net: string;
}) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await fileVatReturnAction(prev, formData);
      if (result.ok) {
        toast.success('VAT return recorded as filed');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Filed on EmaraTax on" htmlFor="filedOn" required error={errors.filedOn}>
          <Input
            id="filedOn"
            name="filedOn"
            type="date"
            max={today}
            defaultValue={today}
            required
            className="h-11"
          />
        </Field>
        <TextField
          label="FTA reference"
          name="ftaReference"
          error={errors.ftaReference}
          hint="The reference EmaraTax shows once the return is submitted."
          className="[&_input]:h-11"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Filing closes the books through the period&apos;s last day: what the FTA received can&apos;t
        change. A later correction is made with a credit note, in the period it is issued.
      </p>
      <FormError message={errors.from ?? errors.to ?? state.error} />
      <div>
        <SubmitButton pending={isPending} size="lg" pendingLabel="Recording…">
          <FileCheck2 />
          Record as filed · {formatMoney(net.replace('-', ''))}{' '}
          {net.startsWith('-') ? 'refundable' : 'payable'}
        </SubmitButton>
      </div>
    </form>
  );
}

/** Records the payment to the FTA, or the refund received from it. */
export function SettleVatButton({
  filingId,
  net,
  today,
  accounts,
}: {
  filingId: string;
  net: string;
  today: string;
  accounts: { id: string; code: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const refund = net.startsWith('-');
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await settleVatReturnAction(filingId, prev, formData);
      if (result.ok) {
        toast.success(refund ? 'Refund recorded' : 'VAT payment recorded');
        setOpen(false);
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const id = (name: string) => `${name}-${filingId}`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Banknote />
        {refund ? 'Record refund' : 'Record payment'}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {refund ? 'Refund received' : 'VAT paid to the FTA'} ·{' '}
            {formatMoney(net.replace('-', ''))}
          </DialogTitle>
          <DialogDescription>
            {refund
              ? 'The refund the FTA paid into your account.'
              : 'The payment made through EmaraTax — by bank transfer to the FTA’s GIBAN, or by card.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <Field
            label={refund ? 'Received on' : 'Paid on'}
            htmlFor={id('settledOn')}
            required
            error={errors.settledOn}
          >
            <Input
              id={id('settledOn')}
              name="settledOn"
              type="date"
              max={today}
              defaultValue={today}
              required
              className="h-11"
            />
          </Field>
          <Field
            label={refund ? 'Into' : 'Paid from'}
            htmlFor={id('accountId')}
            error={errors.accountId}
          >
            <NativeSelect id={id('accountId')} name="accountId" defaultValue="" className="h-11">
              <option value="">Bank (default)</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.code} · {account.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <TextField
            label="Reference"
            id={id('reference')}
            name="reference"
            error={errors.reference}
            hint="Optional — the bank or EmaraTax payment reference."
            className="[&_input]:h-11"
          />
          <FormError message={Object.keys(errors).length ? undefined : state.error} />
          <SubmitButton pending={isPending} size="lg" pendingLabel="Recording…">
            <Banknote />
            Record
          </SubmitButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}
