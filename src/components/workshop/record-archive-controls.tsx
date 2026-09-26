'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { ArchiveRestore, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ReasonAction } from '@/components/shared/reason-action';
import type { ActionResult } from '@/lib/errors';
import {
  archiveCustomerAction,
  archiveVehicleAction,
  restoreCustomerAction,
  restoreVehicleAction,
} from '@/app/(app)/customers/actions';

export function DeleteCustomerButton({ customerId, name }: { customerId: string; name: string }) {
  return (
    <ReasonAction
      trigger={
        <Button variant="outline" size="lg">
          <Trash2 />
          Delete
        </Button>
      }
      title={`Delete ${name}?`}
      description="They and their vehicles leave the customer lists, search and pickers. Their past job cards, invoices and payments are kept, and they can be restored from Customers › Deleted."
      reasonLabel="Why"
      placeholder="e.g. Duplicate of another customer."
      requireReason={false}
      confirmLabel="Delete customer"
      successMessage={`${name} deleted`}
      onConfirm={(input) => archiveCustomerAction(customerId, input)}
    />
  );
}

export function DeleteVehicleButton({ vehicleId, plate }: { vehicleId: string; plate: string }) {
  return (
    <ReasonAction
      trigger={
        <Button variant="outline" size="lg">
          <Trash2 />
          Delete
        </Button>
      }
      title={`Delete ${plate}?`}
      description="It leaves the vehicle lists, search and pickers. Its past job cards and invoices are kept, and it can be restored from Vehicles › Deleted."
      reasonLabel="Why"
      placeholder="e.g. Sold and gone for good, or added twice."
      requireReason={false}
      confirmLabel="Delete vehicle"
      successMessage={`${plate} deleted`}
      onConfirm={(input) => archiveVehicleAction(vehicleId, input)}
    />
  );
}

function RestoreButton({ run, label }: { run: () => Promise<ActionResult>; label: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <span className="flex flex-col gap-1">
      <Button
        size="lg"
        disabled={isPending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const result = await run();
            if (result.ok) {
              toast.success(`${label} restored`);
              router.refresh();
            } else {
              setError(result.error ?? 'Could not restore.');
            }
          })
        }
      >
        <ArchiveRestore />
        {isPending ? 'Restoring…' : 'Restore'}
      </Button>
      {error ? (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function RestoreCustomerButton({ customerId, name }: { customerId: string; name: string }) {
  return <RestoreButton run={() => restoreCustomerAction(customerId)} label={name} />;
}

export function RestoreVehicleButton({ vehicleId, plate }: { vehicleId: string; plate: string }) {
  return <RestoreButton run={() => restoreVehicleAction(vehicleId)} label={plate} />;
}
