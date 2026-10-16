import Link from 'next/link';
import { AuthError, requireUser } from '@/lib/auth/authorize';
import { advancePrefill } from '@/lib/billing/advances';
import { getCustomerOptions, type CustomerOption } from '@/lib/customers/picker';
import { getAccountChoices } from '@/lib/accounting/reports';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { localDateString } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { ReceiveAdvanceForm } from '@/components/finance/advance-forms';

export const metadata = { title: 'Receive advance' };

/**
 * Taking a deposit before the invoice — always for a job card: opened from
 * one (which fills in the customer, vehicle and job), or from Customer
 * advances, choosing the customer and then their job card.
 */
export default async function ReceiveAdvancePage({
  searchParams,
}: {
  searchParams: Promise<{ customerId?: string; jobCardId?: string; vehicleId?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  let prefill;
  try {
    prefill = await advancePrefill(user, params);
  } catch (error) {
    if (error instanceof AuthError) return <AccessDenied what="customer advances" />;
    throw error;
  }
  let initialCustomer: CustomerOption | null = null;
  if (prefill.customerId) {
    [initialCustomer = null] = await getCustomerOptions(user, [prefill.customerId]);
  }
  const [accounts, modes] = await Promise.all([
    getAccountChoices(user),
    getPaymentModeOptions(user.organizationId, 'receipts'),
  ]);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          prefill.jobCardId ? (
            <Link href={`/job-cards/${prefill.jobCardId}`} className="text-primary hover:underline">
              Job card
            </Link>
          ) : initialCustomer ? (
            <Link href={`/customers/${initialCustomer.id}`} className="text-primary hover:underline">
              {initialCustomer.name}
            </Link>
          ) : (
            'Advance'
          )
        }
        title="Receive advance"
        description="Money a customer pays before their invoice. It is held for them, and applied to their invoice when the job is billed — or paid back."
      />
      <Panel className="w-full sm:p-8">
        <ReceiveAdvanceForm
          initialCustomer={initialCustomer}
          initialVehicleId={prefill.vehicleId}
          initialJobCardId={prefill.jobCardId}
          pinnedJobCard={
            prefill.jobCardId
              ? { id: prefill.jobCardId, jobNumber: prefill.jobNumber, vehicleId: prefill.vehicleId }
              : null
          }
          modes={modes}
          moneyAccounts={accounts.money}
          today={localDateString()}
        />
      </Panel>
    </Stack>
  );
}
