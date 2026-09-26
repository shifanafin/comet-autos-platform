'use client';

import { useState, useTransition } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmAction } from '@/components/shared/confirm-action';
import { deleteDraftQuotationAction } from '@/app/(app)/quotations/actions';

/** Throws away a draft quotation that was never sent. */
export function DeleteDraftQuotationButton({ estimateId }: { estimateId: string }) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  return (
    <span className="flex flex-col gap-1">
      <ConfirmAction
        trigger={
          <Button variant="outline" size="lg" disabled={isPending}>
            <Trash2 />
            Delete draft
          </Button>
        }
        title="Delete this draft quotation?"
        description="It was never sent, so nobody else has seen it. It is removed with its lines."
        confirmLabel="Delete draft"
        onConfirm={async () =>
          startTransition(async () => {
            setError(null);
            const result = await deleteDraftQuotationAction(estimateId);
            if (result && !result.ok) setError(result.error ?? 'Could not delete the draft.');
          })
        }
      />
      {error ? (
        <span role="alert" className="text-sm text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
