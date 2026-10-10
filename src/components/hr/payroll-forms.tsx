'use client';

import { useState, useTransition, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { BadgeCheck, Ban, Banknote, Calculator, Pencil, Play, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FormError,
  NativeSelect,
  TextField,
  TextareaField,
} from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { ReasonAction } from '@/components/shared/reason-action';
import type { ActionResult } from '@/lib/errors';
import { formatMoney, localDateString } from '@/lib/format';
import {
  adjustDeductionAction,
  approvePayrollAction,
  cancelPayrollAction,
  markPayrollPaidAction,
  recalculatePayrollAction,
  runPayrollAction,
  setPayDetailsAction,
  setSalaryAction,
} from '@/app/(app)/hr/payroll/actions';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';
const AMOUNT = `${INPUT} [&_input]:text-right [&_input]:tabular-nums`;

/** Pick a month and calculate it. The server redirects to the new run. */
export function RunPayrollForm({
  defaultMonth,
  maxMonth,
}: {
  defaultMonth: string;
  maxMonth: string;
}) {
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    (prev, formData) => runPayrollAction(prev, formData),
    { ok: false },
  );
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <TextField
        label="Month"
        name="month"
        type="month"
        required
        defaultValue={defaultMonth}
        max={maxMonth}
        error={state.fieldErrors?.month}
        className={`${INPUT} sm:w-56`}
      />
      <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Calculating…">
        <Play />
        Calculate payroll
      </SubmitButton>
      {state.fieldErrors?.month ? null : <FormError message={state.error} />}
    </form>
  );
}

/** Sets a new salary from a date, or corrects the latest one. */
export function SalaryForm({
  employeeId,
  current,
}: {
  employeeId: string;
  current: { basicSalary: string; allowances: string } | null;
}) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await setSalaryAction(employeeId, prev, formData);
      if (result.ok) {
        toast.success('Salary saved');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="grid gap-6 sm:grid-cols-3">
        <TextField
          label="Basic salary"
          name="basicSalary"
          numeric="money"
          required
          defaultValue={current?.basicSalary}
          placeholder="0.00"
          hint="Per month, AED."
          error={errors.basicSalary}
          className={AMOUNT}
        />
        <TextField
          label="Allowances"
          name="allowances"
          numeric="money"
          defaultValue={current?.allowances}
          placeholder="0.00"
          hint="Housing, transport — per month."
          error={errors.allowances}
          className={AMOUNT}
        />
        <TextField
          label="Starts on"
          name="effectiveFrom"
          type="date"
          required
          defaultValue={localDateString().slice(0, 7) + '-01'}
          error={errors.effectiveFrom}
          className={INPUT}
        />
      </div>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div className="border-t border-border pt-4">
        <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Saving…">
          <Save />
          Save salary
        </SubmitButton>
      </div>
    </form>
  );
}

/** A plain confirm dialog for a forward step (approve, mark paid, recalculate). */
function StepButton({
  label,
  icon,
  title,
  description,
  confirmLabel,
  successMessage,
  variant = 'default',
  run,
}: {
  label: string;
  icon: ReactNode;
  title: string;
  description: string;
  confirmLabel: string;
  successMessage: string;
  variant?: 'default' | 'outline';
  run: () => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setError(null);
      }}
    >
      <Button variant={variant} size="lg" className="h-11" onClick={() => setOpen(true)}>
        {icon}
        {label}
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Never mind
          </Button>
          <Button
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                const result = await run();
                if (result.ok) {
                  toast.success(successMessage);
                  setOpen(false);
                  router.refresh();
                } else {
                  setError(result.error ?? 'That did not work. Try again.');
                }
              })
            }
          >
            {isPending ? 'Working…' : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The run's next step, and cancelling it, for whoever may take them. */
export function PayrollRunActions({
  payrollId,
  label,
  status,
  net,
  canPrepare,
  canApprove,
}: {
  payrollId: string;
  label: string;
  status: string;
  net: string;
  canPrepare: boolean;
  canApprove: boolean;
}) {
  const cancellable =
    (status === 'CALCULATED' || status === 'DRAFT' || status === 'APPROVED') &&
    canPrepare &&
    (status !== 'APPROVED' || canApprove);

  return (
    <div className="flex flex-wrap gap-3">
      {status === 'CALCULATED' && canApprove ? (
        <StepButton
          label="Approve"
          icon={<BadgeCheck />}
          title={`Approve payroll for ${label}?`}
          description={`${formatMoney(net)} net pay. Once approved the figures are fixed; the next step is recording it as paid.`}
          confirmLabel="Approve payroll"
          successMessage="Payroll approved"
          run={() => approvePayrollAction(payrollId)}
        />
      ) : null}
      {status === 'APPROVED' && canApprove ? (
        <StepButton
          label="Mark as paid"
          icon={<Banknote />}
          title={`Record ${label} as paid?`}
          description={`Confirms ${formatMoney(net)} has been paid to the team. A paid payroll can’t be changed or cancelled.`}
          confirmLabel="Mark as paid"
          successMessage="Payroll recorded as paid"
          run={() => markPayrollPaidAction(payrollId)}
        />
      ) : null}
      {(status === 'CALCULATED' || status === 'DRAFT') && canPrepare ? (
        <StepButton
          label="Recalculate"
          icon={<Calculator />}
          variant="outline"
          title="Recalculate from current salaries and leave?"
          description="Use this after correcting a salary or approving late leave. Any deductions changed by hand are replaced."
          confirmLabel="Recalculate"
          successMessage="Payroll recalculated"
          run={() => recalculatePayrollAction(payrollId)}
        />
      ) : null}
      {cancellable ? (
        <ReasonAction
          trigger={
            <Button variant="ghost" size="lg" className="h-11 text-muted-foreground">
              <Ban />
              Cancel run
            </Button>
          }
          title={`Cancel payroll for ${label}?`}
          description="The run is kept, marked cancelled. Running the same month again reopens it."
          confirmLabel="Cancel payroll"
          placeholder="e.g. Salaries were wrong — will re-run after correcting them"
          successMessage="Payroll cancelled"
          onConfirm={(input) => cancelPayrollAction(payrollId, input)}
        />
      ) : null}
    </div>
  );
}

/** Changes one person's deduction on a calculated run, with a reason. */
export function AdjustDeductionButton({
  payrollId,
  itemId,
  employeeName,
  gross,
  deductions,
  kind,
  leaveDeduction,
}: {
  payrollId: string;
  itemId: string;
  employeeName: string;
  gross: string;
  /** The hand-entered deduction (advance, penalty, other) — the leave deduction is calculated. */
  deductions: string;
  kind?: string | null;
  leaveDeduction?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await adjustDeductionAction(payrollId, itemId, prev, formData);
      if (result.ok) {
        toast.success('Deduction updated');
        setOpen(false);
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="ghost"
        size="sm"
        className="h-11 text-muted-foreground sm:h-8"
        onClick={() => setOpen(true)}
      >
        <Pencil />
        Deduction
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deduction for {employeeName}</DialogTitle>
          <DialogDescription>
            Gross pay is {formatMoney(gross)}
            {leaveDeduction && leaveDeduction !== '0.00'
              ? `; unpaid leave and absence already take ${formatMoney(leaveDeduction)}`
              : ''}
            . UAE law caps this deduction at half the month&apos;s wage. The reason is kept in the
            audit trail.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <TextField
            label="Deduction"
            name="deductions"
            numeric="money"
            required
            defaultValue={deductions}
            error={errors.deductions}
            hint="0 removes it."
            className={AMOUNT}
          />
          <Field label="For" htmlFor={`kind-${itemId}`} error={errors.kind}>
            <NativeSelect
              id={`kind-${itemId}`}
              name="kind"
              defaultValue={kind ?? 'ADVANCE'}
              className="h-11 text-base md:text-sm"
            >
              <option value="ADVANCE">Salary advance or loan recovered</option>
              <option value="PENALTY">Penalty (internal regulations)</option>
              <option value="OTHER">Other</option>
            </NativeSelect>
          </Field>
          <TextareaField
            label="Why?"
            name="reason"
            required
            placeholder="e.g. Two unauthorised absences; salary advance recovered"
            error={errors.reason}
            className="[&_textarea]:min-h-20 [&_textarea]:text-base md:[&_textarea]:text-sm"
          />
          <FormError message={Object.keys(errors).length ? undefined : state.error} />
          <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Saving…">
            <Save />
            Save deduction
          </SubmitButton>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** How the salary reaches them through WPS: MOHRE person code, bank routing code, IBAN. */
export function PayDetailsForm({
  employeeId,
  current,
}: {
  employeeId: string;
  current: { wpsPersonCode: string | null; wpsAgentCode: string | null; salaryIban: string | null };
}) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await setPayDetailsAction(employeeId, prev, formData);
      if (result.ok) {
        toast.success('Bank details saved');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="grid gap-6 sm:grid-cols-3">
        <TextField
          label="MOHRE person code"
          name="wpsPersonCode"
          inputMode="numeric"
          defaultValue={current.wpsPersonCode ?? ''}
          hint="14 digits, on the labour card or work permit."
          error={errors.wpsPersonCode}
          className={INPUT}
        />
        <TextField
          label="Bank routing code"
          name="wpsAgentCode"
          inputMode="numeric"
          defaultValue={current.wpsAgentCode ?? ''}
          hint="9 digits — their bank or exchange house gives it."
          error={errors.wpsAgentCode}
          className={INPUT}
        />
        <TextField
          label="IBAN"
          name="salaryIban"
          defaultValue={current.salaryIban ?? ''}
          placeholder="AE07 0331 2345 6789 0123 456"
          hint="Their salary account. Salary card: the card's IBAN."
          error={errors.salaryIban}
          className={INPUT}
        />
      </div>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div className="border-t border-border pt-4">
        <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Saving…">
          <Save />
          Save bank details
        </SubmitButton>
      </div>
    </form>
  );
}
