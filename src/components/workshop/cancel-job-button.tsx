'use client';

import { useState, useTransition } from 'react';
import { XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/shared/confirm-action';
import { changeJobStatusAction } from '@/app/(app)/job-cards/[id]/actions';

/** Cancels a work order that will not be billed — the vehicle left without work. */
export function CancelJobButton({ jobCardId }: { jobCardId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  return (
    <div className="flex flex-col gap-2">
      <ConfirmAction
        trigger={
          <Button variant="ghost" disabled={isPending}>
            <XCircle />
            Cancel work order
          </Button>
        }
        title="Cancel this work order?"
        description="Use this when the vehicle leaves without any work billed. It can't be undone — the vehicle would need a new work order."
        confirmLabel="Cancel work order"
        onConfirm={async () =>
          startTransition(async () => {
            setError(null);
            const result = await changeJobStatusAction(jobCardId, 'CANCELLED');
            if (!result.ok) setError(result.error ?? 'Could not cancel the work order.');
          })
        }
      />
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
