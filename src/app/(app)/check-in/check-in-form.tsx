'use client';

import Link from 'next/link';
import { useFormAction } from '@/components/forms/use-form-action';
import { useState } from 'react';
import { ArrowRight, CalendarDays, Camera, CheckCircle2, TriangleAlert, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FormError, NativeSelect, TextField, TextareaField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { VehiclePicker } from '@/components/workshop/vehicle-picker';
import type { VehicleSummary } from '@/lib/vehicles/summary';
import type { ActionResult } from '@/lib/errors';
import type { CheckInResult } from '@/lib/workshop/check-in';
import { formatDateTime, formatKm } from '@/lib/format';
import { PLATE_EMIRATES } from '@/lib/vehicles/constants';
import { checkInAction } from './actions';

export interface AppointmentContext {
  id: string;
  scheduledAt: string;
  notes: string | null;
}

function Step({ number, title, done, children }: { number: number; title: string; done?: boolean; children: React.ReactNode }) {
  return (
    <section className="flex gap-4">
      <span
        className={
          done
            ? 'flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-semibold text-primary-foreground'
            : 'flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-sm font-semibold text-muted-foreground'
        }
      >
        {done ? <CheckCircle2 className="size-4" /> : number}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-4 pt-1">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {children}
      </div>
    </section>
  );
}

export function CheckInForm({
  initialVehicle,
  initialAppointment,
}: {
  initialVehicle: VehicleSummary | null;
  initialAppointment: AppointmentContext | null;
}) {
  const [state, onSubmit, isPending] = useFormAction<ActionResult<CheckInResult>>(checkInAction, { ok: false });
  const [vehicle, setVehicle] = useState<VehicleSummary | null>(initialVehicle);
  const [creatingNew, setCreatingNew] = useState(false);
  const [customerConfirmed, setCustomerConfirmed] = useState(Boolean(initialVehicle && initialAppointment));
  const errors = state.fieldErrors ?? {};

  if (state.ok && state.data) {
    return (
      <div className="animate-in fade-in zoom-in-95 flex flex-col items-center gap-6 rounded-xl border border-success/25 bg-success/5 px-6 py-12 text-center duration-300">
        <CheckCircle2 className="size-10 text-success" />
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold tracking-wider text-success uppercase">Job card created</p>
          <p className="text-4xl font-semibold tracking-tight tabular-nums">{state.data.jobNumber}</p>
          <p className="text-sm text-muted-foreground">
            Photograph the vehicle now, quote the work, or invoice it when it&apos;s done.
          </p>
        </div>
        <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:flex-wrap sm:justify-center">
          <Button
            size="lg"
            className="h-12 w-full sm:w-auto"
            nativeButton={false}
            render={<Link href={`/job-cards/${state.data.jobCardId}#photos`} />}
          >
            <Camera />
            Take photos
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="h-12 w-full sm:w-auto"
            nativeButton={false}
            render={<Link href={`/job-cards/${state.data.jobCardId}`} />}
          >
            Open job card
            <ArrowRight />
          </Button>
          <Button
            size="lg"
            variant="ghost"
            className="h-12 w-full sm:w-auto"
            nativeButton={false}
            render={<a href="/check-in" />}
          >
            New job card
          </Button>
        </div>
      </div>
    );
  }

  // Appointment context applies only to the vehicle it was booked for.
  const appointment =
    initialAppointment && vehicle && initialVehicle && vehicle.vehicleId === initialVehicle.vehicleId
      ? initialAppointment
      : vehicle?.openAppointment ?? null;

  if (creatingNew) {
    return (
      <form onSubmit={onSubmit} className="flex flex-col gap-10">
        <input type="hidden" name="mode" value="new" />
        <Step number={1} title="New customer">
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField label="Customer name" name="name" required error={errors.name} autoFocus />
            <TextField label="Mobile number" name="phone" type="tel" required error={errors.phone} placeholder="050 123 4567" />
            <TextField label="Email" name="email" type="email" error={errors.email} hint="Optional" className="sm:col-span-2" />
          </div>
        </Step>
        <Step number={2} title="Vehicle">
          <div className="grid gap-6 sm:grid-cols-2">
            <TextField label="Registration number" name="plateNumber" required error={errors.plateNumber} placeholder="A 12345" />
            <Field label="Emirate" htmlFor="plateEmirate" hint="Optional">
              <NativeSelect id="plateEmirate" name="plateEmirate" defaultValue="Dubai">
                <option value="">—</option>
                {PLATE_EMIRATES.map((emirate) => (
                  <option key={emirate} value={emirate}>
                    {emirate}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <TextField label="Make" name="make" required error={errors.make} placeholder="Toyota" />
            <TextField label="Model" name="model" required error={errors.model} placeholder="Land Cruiser" />
            <TextField label="Year" name="year" inputMode="numeric" error={errors.year} hint="Optional" />
            <TextField label="VIN" name="vin" error={errors.vin} hint="Optional" />
          </div>
        </Step>
        <VisitStep number={3} errors={errors} lastMileage={null} />
        <FormError message={state.error} />
        <div className="flex flex-wrap items-center gap-3 border-t border-border pt-6">
          <SubmitButton pending={isPending} size="lg" pendingLabel="Creating…">
            Create job card
          </SubmitButton>
          <Button type="button" variant="ghost" size="lg" onClick={() => setCreatingNew(false)}>
            Search instead
          </Button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-10">
      <input type="hidden" name="mode" value="existing" />
      <input type="hidden" name="vehicleId" value={vehicle?.vehicleId ?? ''} />
      <input type="hidden" name="appointmentId" value={appointment?.id ?? ''} />

      <Step number={1} title="Find the vehicle" done={Boolean(vehicle)}>
        {vehicle ? (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-muted/40 p-4">
            <div className="flex min-w-0 items-center gap-4">
              <VehiclePlate plateNumber={vehicle.plateNumber} />
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {vehicle.make} {vehicle.model} {vehicle.year ?? ''}
                </p>
                <p className="truncate text-sm text-muted-foreground">
                  {vehicle.plateEmirate ?? 'Registration'}
                  {vehicle.vin ? ` · VIN ${vehicle.vin}` : ''}
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setVehicle(null);
                setCustomerConfirmed(false);
              }}
            >
              Change vehicle
            </Button>
          </div>
        ) : (
          <VehiclePicker
            autoFocus
            onSelect={(selected) => {
              setVehicle(selected);
              setCustomerConfirmed(false);
            }}
            footer={
              <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                <span>First visit?</span>
                <Button type="button" variant="outline" onClick={() => setCreatingNew(true)}>
                  <UserPlus />
                  New customer &amp; vehicle
                </Button>
              </div>
            }
          />
        )}
      </Step>

      {vehicle ? (
        <Step number={2} title="Confirm the customer" done={customerConfirmed}>
          {vehicle.openJob ? (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-warning/30 bg-warning/5 p-4">
              <p className="flex items-center gap-2 text-sm text-warning">
                <TriangleAlert className="size-4 shrink-0" />
                This vehicle is already in the workshop on job card {vehicle.openJob.jobNumber}.
              </p>
              <Button variant="outline" nativeButton={false} render={<Link href={`/job-cards/${vehicle.openJob.id}`} />}>
                Open that job card
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border p-4">
              <div className="min-w-0">
                <p className="font-medium">{vehicle.customer.name}</p>
                <p className="text-sm text-muted-foreground">{vehicle.customer.phone}</p>
              </div>
              {customerConfirmed ? (
                <Link href={`/customers/${vehicle.customer.id}/edit`} className="text-sm font-medium text-primary hover:underline">
                  Update contact details
                </Link>
              ) : (
                <div className="flex flex-wrap gap-3">
                  <Button variant="outline" nativeButton={false} render={<Link href={`/customers/${vehicle.customer.id}/edit`} />}>
                    Details changed
                  </Button>
                  <Button type="button" onClick={() => setCustomerConfirmed(true)}>
                    Yes, this is the customer
                  </Button>
                </div>
              )}
            </div>
          )}
          {appointment && !vehicle.openJob ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <CalendarDays className="size-4 shrink-0" />
              Arriving for the appointment on {formatDateTime(appointment.scheduledAt)} — it will be marked checked in.
            </p>
          ) : null}
        </Step>
      ) : null}

      {vehicle && customerConfirmed && !vehicle.openJob ? (
        <>
          <VisitStep
            number={3}
            errors={errors}
            lastMileage={vehicle.lastMileage}
            defaultComplaint={appointment?.notes ?? ''}
          />
          <FormError message={errors.vehicleId || errors.appointmentId ? undefined : state.error} />
          {errors.vehicleId || errors.appointmentId ? <FormError message={errors.vehicleId ?? errors.appointmentId} /> : null}
          <div className="border-t border-border pt-6">
            <SubmitButton pending={isPending} size="lg" pendingLabel="Creating…">
              Create job card
            </SubmitButton>
          </div>
        </>
      ) : null}
    </form>
  );
}

function VisitStep({
  number,
  errors,
  lastMileage,
  defaultComplaint = '',
}: {
  number: number;
  errors: Record<string, string>;
  lastMileage: number | null;
  defaultComplaint?: string;
}) {
  return (
    <Step number={number} title="What needs doing">
      <div className="flex flex-col gap-6">
        <TextareaField
          label="Work requested"
          name="complaint"
          required
          defaultValue={defaultComplaint}
          error={errors.complaint}
          placeholder="In the customer's words — e.g. AC not cooling, noise when braking"
          className="[&_textarea]:min-h-28 [&_textarea]:text-base md:[&_textarea]:text-sm"
        />
        {/* Optional: the odometer is often not to hand at drop-off, and the
            job card should not wait on it. */}
        <TextField
          label="Current mileage (km)"
          name="mileage"
          inputMode="numeric"
          error={errors.mileage}
          hint={
            lastMileage !== null
              ? `Optional. Last recorded: ${formatKm(lastMileage)}`
              : 'Optional — add it now or later.'
          }
          className="max-w-xs [&_input]:h-12 [&_input]:text-base md:[&_input]:h-11 md:[&_input]:text-sm"
        />
      </div>
    </Step>
  );
}
