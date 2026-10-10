'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Field,
  FormError,
  NativeSelect,
  TextField,
  TextareaField,
} from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import { requestLeaveAction } from '@/app/(app)/hr/leave/actions';
import { localDateString } from '@/lib/format';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

const TYPES = [
  { value: 'ANNUAL', label: 'Annual leave' },
  { value: 'SICK', label: 'Sick leave' },
  { value: 'UNPAID', label: 'Unpaid leave' },
  { value: 'OTHER', label: 'Other' },
];

/** Calendar days from a to b, both included — the same count the server keeps. */
function daysBetween(a: string, b: string) {
  if (!a || !b || b < a) return 0;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
}

export function LeaveForm({
  employees,
  canApprove,
}: {
  employees: { id: string; name: string; code: string }[];
  canApprove: boolean;
}) {
  const router = useRouter();
  const [start, setStart] = useState(localDateString());
  const [end, setEnd] = useState(localDateString());
  const [state, onSubmit, isPending] = useFormAction<ActionResult<{ payNote: string | null }>>(
    async (prev, formData) => {
      const result = await requestLeaveAction(prev, formData);
      if (result.ok) {
        toast.success(
          formData.get('approveNow') ? 'Leave recorded and approved' : 'Leave recorded',
          // Some days unpaid or half paid under the leave rules: say so.
          result.data?.payNote ? { description: result.data.payNote, duration: 10000 } : undefined,
        );
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const days = daysBetween(start, end);

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Employee" htmlFor="employeeId" error={errors.employeeId} required>
          <NativeSelect
            id="employeeId"
            name="employeeId"
            required
            defaultValue=""
            className="h-11 text-base md:text-sm"
          >
            <option value="" disabled>
              Choose…
            </option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name} ({employee.code})
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Kind of leave" htmlFor="leaveType" error={errors.leaveType} required>
          <NativeSelect
            id="leaveType"
            name="leaveType"
            defaultValue="ANNUAL"
            className="h-11 text-base md:text-sm"
          >
            {TYPES.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <TextField
          label="First day"
          name="startDate"
          type="date"
          required
          value={start}
          onChange={(event) => {
            setStart(event.target.value);
            if (end < event.target.value) setEnd(event.target.value);
          }}
          error={errors.startDate}
          className={INPUT}
        />
        <TextField
          label="Last day"
          name="endDate"
          type="date"
          required
          value={end}
          min={start}
          onChange={(event) => setEnd(event.target.value)}
          error={errors.endDate}
          hint={days > 0 ? `${days} calendar day${days === 1 ? '' : 's'}` : undefined}
          className={INPUT}
        />
      </div>

      <TextareaField
        label="Reason"
        name="reason"
        placeholder="Optional — e.g. family visit, medical certificate received"
        error={errors.reason}
        className="[&_textarea]:min-h-20 [&_textarea]:text-base md:[&_textarea]:text-sm"
      />

      {canApprove ? (
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            name="approveNow"
            defaultChecked
            className="mt-0.5 size-4 accent-primary"
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">Approve it now</span>
            <span className="text-xs text-muted-foreground">
              Untick to leave it waiting for approval.
            </span>
          </span>
        </label>
      ) : null}

      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div className="border-t border-border pt-4">
        <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Recording…">
          <Plus />
          Record leave
        </SubmitButton>
      </div>
    </form>
  );
}
