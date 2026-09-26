import { requireUser } from '@/lib/auth/authorize';
import { requirePermission } from '@/lib/auth/authorize';
import { getCustomerOptions, type CustomerOption } from '@/lib/customers/picker';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { NewQuotationForm } from './quotation-form';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function NewQuotationPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string }>;
}) {
  const user = await requireUser();
  requirePermission(user, 'job_card.edit', {
    branchId: user.primaryBranchId ?? undefined,
  });
  const { customer } = await searchParams;

  // Arriving from a customer's page: their details are already chosen.
  let initialCustomer: CustomerOption | null = null;
  if (customer && UUID.test(customer)) {
    [initialCustomer = null] = await getCustomerOptions(user, [customer]);
  }

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Quotations"
        title="New quotation"
        description="Who is this quotation for? A job card is not needed — link one only if you want to."
      />
      <Panel className="w-full max-w-3xl sm:p-8">
        <NewQuotationForm initialCustomer={initialCustomer} />
      </Panel>
    </Stack>
  );
}
