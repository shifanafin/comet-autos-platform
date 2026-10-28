import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { AccessDenied } from '@/components/shared/access-denied';
import { NotFoundError } from '@/lib/errors';
import { getCustomerDetail } from '@/lib/customers/service';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { VehicleForm } from '@/components/workshop/vehicle-form';
import { createVehicleAction } from '../../../actions';

export default async function NewVehiclePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string; from?: string }>;
}) {
  const user = await requireUser();
  if (
    !hasPermission(
      user,
      'vehicle.create',
      user.primaryBranchId ? { branchId: user.primaryBranchId } : undefined,
    )
  ) {
    return <AccessDenied what="adding vehicles" />;
  }
  const { id } = await params;
  const query = await searchParams;
  const isNewCustomer = query.new === '1';
  // Started from Vehicles › New vehicle, where the owner was chosen first.
  const fromVehicles = query.from === 'vehicles';
  let detail;
  try {
    detail = await getCustomerDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { customer } = detail;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          isNewCustomer
            ? 'New customer · step 2 of 2'
            : fromVehicles
              ? 'New vehicle · step 2 of 2'
              : 'Customers'
        }
        title="Add vehicle"
        description={
          <>
            Owner: <span className="font-medium text-foreground">{customer.name}</span> ·{' '}
            {customer.phone}
            {fromVehicles ? (
              <>
                {' · '}
                <Link href="/vehicles/new" className="font-medium text-primary hover:underline">
                  Change owner
                </Link>
              </>
            ) : null}
          </>
        }
      />
      <Panel className="w-full sm:p-8">
        <VehicleForm
          action={createVehicleAction.bind(null, customer.id)}
          submitLabel="Save vehicle"
          cancelHref={fromVehicles ? '/vehicles' : `/customers/${customer.id}`}
          offerCheckIn
        />
      </Panel>
    </Stack>
  );
}
