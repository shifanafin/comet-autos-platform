'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Banknote, CheckCircle2, Calculator, XCircle } from 'lucide-react';
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
import { ReasonAction } from '@/components/shared/reason-action';
import type { ActionResult } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  approveSettlementAction,
  cancelSettlementAction,
  paySettlementAction,
  prepareSettlementAction,
} from '@/app/(app)/hr/settlements/actions';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';
const AMOUNT = `${INPUT} [&_input]:text-right [&_input]:tabular-nums`;

/** Works out what someone leaving is owed — saved as a draft to check. */
export function PrepareSettlementForm({
  employeeId,
  defaults,
}: {
  employeeId: string;
  defaults?: {
    terminationDate?: string | null;
    reason?: string;
    noticePay?: string;
    otherAdditions?: string;
    recoveries?: string;
    note?: string | null;
  };
}) {
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    (prev, formData) => prepareSettlementAction(employeeId, prev, formData),
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <TextField
          label="Last working day"
          name="terminationDate"
          type="date"
          required
          defaultValue={defaults?.terminationDate ?? ''}
          error={errors.terminationDate}
          className={INPUT}
        />
        <Field label="Why they are leaving" htmlFor="reason" required error={errors.reason}>
          <NativeSelect
            id="reason"
            name="reason"
            defaultValue={defaults?.reason ?? 'RESIGNATION'}
            className="h-11 text-base md:text-sm"
          >
            <option value="RESIGNATION">Resignation</option>
            <option value="TERMINATION">Termination by the employer</option>
            <option value="END_OF_CONTRACT">End of contract</option>
            <option value="OTHER">Other</option>
          </NativeSelect>
        </Field>
        <TextField
          label="Notice pay"
          name="noticePay"
          inputMode="decimal"
          defaultValue={defaults?.noticePay ?? ''}
          error={errors.noticePay}
          hint="Paid in lieu of notice. A minus amount for notice they owe."
          className={AMOUNT}
        />
        <TextField
          label="Other additions"
          name="otherAdditions"
          numeric="money"
          defaultValue={defaults?.otherAdditions ?? ''}
          error={errors.otherAdditions}
          hint="e.g. an air ticket agreed in the contract."
          className={AMOUNT}
        />
        <TextField
          label="Recoveries"
          name="recoveries"
          numeric="money"
          defaultValue={defaults?.recoveries ?? ''}
          error={errors.recoveries}
          hint="Salary advances they still owe."
          className={AMOUNT}
        />
        <TextField
          label="Note"
          name="note"
          defaultValue={defaults?.note ?? ''}
          error={errors.note}
          className={INPUT}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        End-of-service and unused leave are worked out from their service and salary. Their last
        days&apos; salary is paid by that month&apos;s payroll. Saving marks them as left.
      </p>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Working it out…">
          <Calculator />
          Work out the settlement
        </SubmitButton>
      </div>
    </form>
  );
}

/** Approve, pay or cancel — what the settlement's status allows. */
export function SettlementActions({
  id,
  status,
  net,
  today,
  accounts,
  canApprove,
}: {
  id: string;
  status: 'DRAFT' | 'APPROVED' | 'PAID' | 'CANCELLED';
  net: string;
  today: string;
  accounts: { id: string; code: string; name: string }[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payState, onPay, paying] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await paySettlementAction(id, prev, formData);
      if (result.ok) {
        toast.success('Settlement recorded as paid');
        setOpen(false);
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  if (!canApprove || status === 'PAID' || status === 'CANCELLED') return null;
  const payErrors = payState.fieldErrors ?? {};

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        {status === 'DRAFT' ? (
          <Button
            size="lg"
            className="h-11"
            disabled={approving}
            onClick={async () => {
              setApproving(true);
              setError(null);
              const result = await approveSettlementAction(id);
              setApproving(false);
              if (result.ok) {
                toast.success('Settlement approved and booked');
                router.refresh();
              } else {
                setError(result.error ?? 'It could not be approved.');
              }
            }}
          >
            <CheckCircle2 />
            Approve · {formatMoney(net)}
          </Button>
        ) : null}
        {status === 'APPROVED' ? (
          <Dialog open={open} onOpenChange={setOpen}>
            <Button size="lg" className="h-11" onClick={() => setOpen(true)}>
              <Banknote />
              Record as paid
            </Button>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Final settlement paid · {formatMoney(net)}</DialogTitle>
                <DialogDescription>
                  Paid through WPS or by bank transfer — within 14 days of the leaving date.
                </DialogDescription>
              </DialogHeader>
              <form onSubmit={onPay} className="flex flex-col gap-5">
                <Field label="Paid on" htmlFor={`paidOn-${id}`} required error={payErrors.paidOn}>
                  <Input
                    id={`paidOn-${id}`}
                    name="paidOn"
                    type="date"
                    max={today}
                    defaultValue={today}
                    required
                    className="h-11"
                  />
                </Field>
                <Field label="Paid from" htmlFor={`accountId-${id}`} error={payErrors.accountId}>
                  <NativeSelect
                    id={`accountId-${id}`}
                    name="accountId"
                    defaultValue=""
                    className="h-11"
                  >
                    <option value="">Bank (default)</option>
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.code} · {account.name}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <FormError message={Object.keys(payErrors).length ? undefined : payState.error} />
                <SubmitButton pending={paying} size="lg" pendingLabel="Recording…">
                  <Banknote />
                  Record
                </SubmitButton>
              </form>
            </DialogContent>
          </Dialog>
        ) : null}
        <ReasonAction
          trigger={
            <Button variant="outline" size="lg" className="h-11">
              <XCircle />
              Cancel
            </Button>
          }
          title="Cancel this settlement?"
          description={
            status === 'APPROVED'
              ? 'Its entry is reversed. Work it out again if something was wrong.'
              : 'The draft is withdrawn.'
          }
          confirmLabel="Cancel the settlement"
          placeholder="e.g. The leaving date changed"
          successMessage="Settlement cancelled"
          tone="destructive"
          onConfirm={(input) => cancelSettlementAction(id, input)}
        />
      </div>
      <FormError message={error ?? undefined} />
    </div>
  );
}
