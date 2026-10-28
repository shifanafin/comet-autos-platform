import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { AccessDenied } from '@/components/shared/access-denied';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { OwnerStep } from './owner-step';

/** A new vehicle, from the Vehicles list: its owner first, then its details. */
export default async function NewVehicleOwnerPage() {
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

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="New vehicle · step 1 of 2"
        title="Who owns it?"
        description="Find the customer — most owners are already on file with another car. Add them only if they are new."
      />
      <Panel className="w-full sm:p-8">
        <OwnerStep />
      </Panel>
    </Stack>
  );
}
