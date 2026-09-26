import Link from 'next/link';
import { CalendarDays, CalendarPlus, LogIn } from 'lucide-react';
import { requireUser } from '@/lib/auth/authorize';
import { getAppointmentBoard } from '@/lib/appointments/service';
import {
  formatDateTime,
  formatDayHeading,
  formatTime,
  localDateString,
  toLocalDateTimeInput,
} from '@/lib/format';
import { PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { AppointmentStatusPill } from '@/components/workshop/status-pills';
import { AppointmentStatusButtons, RescheduleAppointmentButton } from './appointment-actions';

type Board = Awaited<ReturnType<typeof getAppointmentBoard>>;
type Appointment = Board['today'][number];

export default async function AppointmentsPage() {
  const user = await requireUser();
  const board = await getAppointmentBoard(user);

  const upcomingByDay = new Map<string, Appointment[]>();
  for (const appointment of board.upcoming) {
    const day = localDateString(appointment.scheduledAt);
    upcomingByDay.set(day, [...(upcomingByDay.get(day) ?? []), appointment]);
  }
  const waitingToday = board.today.filter((a) => a.status === 'SCHEDULED' || a.status === 'CONFIRMED').length;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Workshop"
        title="Appointments"
        description={
          board.today.length === 0
            ? 'Nothing booked for today. Walk-ins go straight to Quick Check-In.'
            : `${board.today.length} booked today · ${waitingToday} still expected`
        }
        actions={
          <>
            <LinkButton href="/check-in" variant="outline" size="lg">
              <LogIn />
              Walk-in check-in
            </LinkButton>
            <LinkButton href="/appointments/new" size="lg">
              <CalendarPlus />
              Book appointment
            </LinkButton>
          </>
        }
      />

      {board.overdue.length > 0 ? (
        <Section title="Missed — needs follow-up" description="Past bookings that were never checked in, cancelled or marked no-show.">
          <AppointmentList appointments={board.overdue} showDate />
        </Section>
      ) : null}

      <Section title="Today">
        {board.today.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No appointments today"
            description="Book one, or check in a walk-in customer."
            action={
              <LinkButton href="/check-in">
                <LogIn />
                Walk-in check-in
              </LinkButton>
            }
          />
        ) : (
          <AppointmentList appointments={board.today} />
        )}
      </Section>

      <Section title="Next 14 days">
        {upcomingByDay.size === 0 ? (
          <p className="text-sm text-muted-foreground">No upcoming bookings.</p>
        ) : (
          <Stack gap="xl">
            {[...upcomingByDay.entries()].map(([day, appointments]) => (
              <div key={day} className="flex flex-col gap-3">
                <h3 className="text-sm font-medium text-muted-foreground">{formatDayHeading(appointments[0].scheduledAt)}</h3>
                <AppointmentList appointments={appointments} />
              </div>
            ))}
          </Stack>
        )}
      </Section>
    </Stack>
  );
}

function AppointmentList({ appointments, showDate }: { appointments: Appointment[]; showDate?: boolean }) {
  return (
    <Panel padding="none">
      <ul className="divide-y divide-border">
        {appointments.map((appointment) => {
          const open = appointment.status === 'SCHEDULED' || appointment.status === 'CONFIRMED';
          return (
            <li key={appointment.id} className="flex flex-col gap-4 px-4 py-4 sm:px-6 lg:flex-row lg:items-center">
              <div className="w-28 shrink-0 text-sm font-semibold tabular-nums">
                {showDate ? formatDateTime(appointment.scheduledAt) : formatTime(appointment.scheduledAt)}
                {appointment.estimatedDurationMinutes ? (
                  <span className="block text-xs font-normal text-muted-foreground">{appointment.estimatedDurationMinutes} min</span>
                ) : null}
              </div>
              <div className="flex min-w-0 flex-1 items-start gap-4">
                {appointment.vehicle ? (
                  <Link href={`/vehicles/${appointment.vehicle.id}`}>
                    <VehiclePlate plateNumber={appointment.vehicle.plateNumber} className="w-28 justify-center px-2 py-0.5 text-xs" />
                  </Link>
                ) : null}
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="truncate text-sm font-medium">
                    {appointment.vehicle ? `${appointment.vehicle.make} ${appointment.vehicle.model} · ` : ''}
                    <Link href={`/customers/${appointment.customer.id}`} className="hover:underline">
                      {appointment.customer.name}
                    </Link>
                  </p>
                  <p className="text-xs text-muted-foreground">{appointment.customer.phone}</p>
                  {appointment.notes ? <p className="mt-1 text-sm text-muted-foreground">{appointment.notes}</p> : null}
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-3 lg:justify-end">
                <AppointmentStatusPill status={appointment.status} />
                {appointment.jobCards[0] ? (
                  <LinkButton href={`/job-cards/${appointment.jobCards[0].id}`} size="sm" variant="outline">
                    {appointment.jobCards[0].jobNumber}
                  </LinkButton>
                ) : null}
                {open ? (
                  <>
                    <LinkButton href={`/check-in?appointment=${appointment.id}`} size="sm">
                      <LogIn />
                      Check in
                    </LinkButton>
                    <RescheduleAppointmentButton
                      appointmentId={appointment.id}
                      scheduledAt={toLocalDateTimeInput(appointment.scheduledAt)}
                      durationMinutes={appointment.estimatedDurationMinutes}
                      notes={appointment.notes}
                    />
                    <AppointmentStatusButtons appointmentId={appointment.id} canConfirm={appointment.status === 'SCHEDULED'} />
                  </>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
