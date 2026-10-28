'use client';

import { useRouter } from 'next/navigation';
import { CustomerPicker } from '@/components/workshop/customer-picker';

/**
 * Step 1 of a new vehicle: whose it is. A customer already on file is
 * searched for (name, mobile, or one of their registrations) — or added in
 * the popup, which offers the existing customer when the mobile is on file.
 * Choosing one goes straight on to the vehicle's details.
 */
export function OwnerStep() {
  const router = useRouter();
  return (
    <CustomerPicker
      value={null}
      onChange={(picked) => {
        if (picked) router.push(`/customers/${picked.customer.id}/vehicles/new?from=vehicles`);
      }}
      ownerOnly
      allowJobCard={false}
      autoFocus
    />
  );
}
