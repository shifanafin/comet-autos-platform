'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Plus, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import {
  addHolidayAction,
  addOvertimeAction,
  decideOvertimeAction,
  removeHolidayAction,
  setRestDayAction,
} from '@/app/(app)/hr/overtime/actions';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';
export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** Approve (hours editable) or reject one suggested entry. */
export function OvertimeDecision({ id, hours }: { id: string; hours: string }) {
  const router = useRouter();
  const [value, setValue] = useState(hours);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const decide = (decision: 'APPROVED' | 'REJECTED') =>
    start(async () => {
      const form = new FormData();
      form.set('hours', value);
      const result = await decideOvertimeAction(id, decision, { ok: false }, form);
      if (result.ok) {
        toast.success(decision === 'APPROVED' ? 'Overtime approved' : 'Overtime rejected');
        router.refresh();
      } else {
        setError(result.fieldErrors?.hours ?? result.error ?? 'It could not be saved.');
      }
    });
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Hours"
          inputMode="decimal"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className="h-9 w-20 text-right tabular-nums"
        />
        <Button size="sm" disabled={pending} onClick={() => decide('APPROVED')}>
          <Check />
          Approve
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => decide('REJECTED')}>
          <X />
          Reject
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Overtime entered by hand — approved as it is entered. */
export function AddOvertimeForm({
  employees,
  today,
}: {
  employees: { id: string; name: string }[];
  today: string;
}) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await addOvertimeAction(prev, formData);
      if (result.ok) {
        toast.success('Overtime added');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Who" htmlFor="ot-employee" required error={errors.employeeId}>
          <NativeSelect id="ot-employee" name="employeeId" defaultValue="" className="h-11">
            <option value="">Choose…</option>
            {employees.map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <TextField
          id="ot-date"
          label="Day"
          name="workDate"
          type="date"
          required
          max={today}
          defaultValue={today}
          error={errors.workDate}
          className={INPUT}
        />
        <Field label="Kind" htmlFor="ot-kind" required error={errors.kind}>
          <NativeSelect id="ot-kind" name="kind" defaultValue="NORMAL" className="h-11">
            <option value="NORMAL">Working day (+25%)</option>
            <option value="NIGHT">Night 22:00–04:00 (+50%)</option>
            <option value="REST_DAY">Rest day (+50%)</option>
            <option value="HOLIDAY">Public holiday (+50%)</option>
          </NativeSelect>
        </Field>
        <TextField
          id="ot-hours"
          label="Hours"
          name="hours"
          inputMode="decimal"
          required
          placeholder="1.5"
          error={errors.hours}
          className={INPUT}
        />
      </div>
      <TextField id="ot-note" label="Note" name="note" error={errors.note} className={INPUT} />
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div>
        <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Adding…">
          <Plus />
          Add overtime
        </SubmitButton>
      </div>
    </form>
  );
}

/** The weekly rest day: overtime that day is paid at +50%. */
export function RestDayForm({ current }: { current: number | null }) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await setRestDayAction(prev, formData);
      if (result.ok) {
        toast.success('Rest day saved');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <Field label="Weekly rest day" htmlFor="restDay" error={state.fieldErrors?.weeklyRestDay}>
        <NativeSelect
          id="restDay"
          name="weeklyRestDay"
          defaultValue={current === null ? '' : String(current)}
          className="h-11 w-48"
        >
          <option value="">Not set</option>
          {WEEKDAYS.map((name, index) => (
            <option key={name} value={String(index)}>
              {name}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <SubmitButton pending={isPending} className="h-11" pendingLabel="Saving…">
        Save
      </SubmitButton>
      <FormError message={state.error} />
    </form>
  );
}

/** Adds a public holiday. */
export function HolidayForm() {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await addHolidayAction(prev, formData);
      if (result.ok) {
        toast.success('Holiday added');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
      <TextField
        id="holidayDate"
        label="Date"
        name="holidayDate"
        type="date"
        required
        error={errors.holidayDate}
        className={`${INPUT} w-48`}
      />
      <TextField
        id="holidayName"
        label="Holiday"
        name="name"
        required
        placeholder="e.g. Eid Al Fitr"
        error={errors.name}
        className={`${INPUT} w-64`}
      />
      <SubmitButton pending={isPending} className="h-11" pendingLabel="Adding…">
        <Plus />
        Add
      </SubmitButton>
      <FormError message={Object.keys(errors).length ? undefined : state.error} />
    </form>
  );
}

export function RemoveHolidayButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await removeHolidayAction(id);
          if (result.ok) router.refresh();
          else toast.error(result.error ?? 'It could not be removed.');
        })
      }
    >
      <Trash2 />
      Remove
    </Button>
  );
}
