'use client';

import { useState, useTransition } from 'react';
import { CalendarClock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/shared/confirm-action';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Field, FormError, NativeSelect, TextareaField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import { changeAppointmentStatusAction, rescheduleAppointmentAction } from './actions';

export function AppointmentStatusButtons({
  appointmentId,
  canConfirm,
}: {
  appointmentId: string;
  canConfirm: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function apply(status: 'CONFIRMED' | 'CANCELLED' | 'NO_SHOW', message: string) {
    setError(null);
    startTransition(async () => {
      const result = await changeAppointmentStatusAction(appointmentId, status);
      if (!result.ok) return setError(result.error ?? 'Could not update the appointment.');
      toast.success(message);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {canConfirm ? (
          <Button
            size="sm"
            variant="outline"
            disabled={isPending}
            onClick={() => apply('CONFIRMED', 'Appointment confirmed')}
          >
            Confirm
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => apply('NO_SHOW', 'Marked as no-show')}
        >
          No-show
        </Button>
        <ConfirmAction
          trigger={
            <Button size="sm" variant="ghost" disabled={isPending}>
              Cancel
            </Button>
          }
          title="Cancel this appointment?"
          description="The booking is kept in the history as cancelled."
          confirmLabel="Cancel appointment"
          onConfirm={async () => apply('CANCELLED', 'Appointment cancelled')}
        />
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

const DURATIONS = [
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '240', label: 'Half day' },
  { value: '480', label: 'Full day' },
];

/** Moves an open booking to another time, and corrects its duration and notes. */
export function RescheduleAppointmentButton({
  appointmentId,
  scheduledAt,
  durationMinutes,
  notes,
}: {
  appointmentId: string;
  /** The current time as a datetime-local value, computed on the server in workshop time. */
  scheduledAt: string;
  durationMinutes: number | null;
  notes: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await rescheduleAppointmentAction(appointmentId, prev, formData);
      if (result.ok) {
        toast.success('Appointment moved');
        setOpen(false);
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};
  const duration = durationMinutes ? String(durationMinutes) : '';

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <CalendarClock />
            Reschedule
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reschedule appointment</DialogTitle>
          <DialogDescription>
            Move the booking, or correct how long it takes and what it is for.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-5">
          <Field
            label="Date and time"
            htmlFor={`when-${appointmentId}`}
            required
            error={errors.scheduledAt}
          >
            <Input
              id={`when-${appointmentId}`}
              name="scheduledAt"
              type="datetime-local"
              step={900}
              defaultValue={scheduledAt}
              required
            />
          </Field>
          <Field label="Expected duration" htmlFor={`duration-${appointmentId}`} hint="Optional">
            <NativeSelect
              id={`duration-${appointmentId}`}
              name="estimatedDurationMinutes"
              defaultValue={duration}
            >
              <option value="">Not set</option>
              {DURATIONS.some((d) => d.value === duration) || !duration ? null : (
                <option value={duration}>{duration} minutes</option>
              )}
              {DURATIONS.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <TextareaField
            label="Work requested"
            name="notes"
            required
            defaultValue={notes ?? ''}
            error={errors.notes}
            className="[&_textarea]:min-h-20"
          />
          <FormError
            message={state.error && !errors.scheduledAt && !errors.notes ? state.error : undefined}
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Never mind
            </Button>
            <SubmitButton pending={isPending} pendingLabel="Saving…">
              Save
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
