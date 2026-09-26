import { CalendarDays } from 'lucide-react';
import { requireUser } from '@/lib/auth/authorize';
import { getVehicleSummaries, type VehicleSummary } from '@/lib/vehicles/summary';
import { getOpenAppointment } from '@/lib/appointments/service';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { LinkButton } from '@/components/shared/link-button';
import { CheckInForm, type AppointmentContext } from './check-in-form';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function CheckInPage({
  searchParams,
}: {
  searchParams: Promise<{ vehicle?: string; appointment?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;

  let appointment: AppointmentContext | null = null;
  let vehicleId = params.vehicle && UUID.test(params.vehicle) ? params.vehicle : null;
  if (params.appointment && UUID.test(params.appointment)) {
    const found = await getOpenAppointment(user, params.appointment);
    if (found?.vehicleId) {
      appointment = { id: found.id, scheduledAt: found.scheduledAt.toISOString(), notes: found.notes };
      vehicleId = found.vehicleId;
    }
  }
  let vehicle: VehicleSummary | null = null;
  if (vehicleId) {
    [vehicle] = await getVehicleSummaries(user.organizationId, [vehicleId]);
  }

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Workshop"
        title="New job card"
        description={
          appointment
            ? 'Opening the job card for a booked appointment. Confirm the customer and what they want done.'
            : 'Find the vehicle, confirm the customer, and say what needs doing. Everything else is optional.'
        }
        actions={
          <LinkButton href="/appointments" variant="outline" size="lg">
            <CalendarDays />
            Today&apos;s appointments
          </LinkButton>
        }
      />
      <Panel className="w-full max-w-3xl sm:p-8">
        <CheckInForm initialVehicle={vehicle ?? null} initialAppointment={appointment} />
      </Panel>
    </Stack>
  );
}
