'use client';

import { useRouter } from 'next/navigation';
import { Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { FormError, NativeSelect } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import { linkQuotationToJobAction } from '@/app/(app)/quotations/actions';

/**
 * A quotation raised without a job card: tie it to one of the customer's
 * job cards without a quotation of its own — still before its quotation
 * step, or, for an approved quotation, already past it (lib/workshop/
 * estimates.ts linkQuotationToJob).
 */
export function LinkQuotationJob({
  estimateId,
  jobs,
}: {
  estimateId: string;
  jobs: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await linkQuotationToJobAction(estimateId, prev, formData);
      if (result.ok) {
        toast.success('Quotation linked to the job card');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const error = state.fieldErrors?.jobCardId ?? state.error;

  if (jobs.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No job card to link: each of this customer&apos;s job cards already has its own quotation, or
        has moved past the quotation step — only an approved quotation can go on one of those.
      </p>
    );
  }
  return (
    <form onSubmit={onSubmit} className="@container flex flex-col gap-2">
      <div className="flex flex-col gap-2 @md:flex-row">
        <NativeSelect
          name="jobCardId"
          aria-label="Job card to link"
          defaultValue=""
          required
          className="h-10 @md:w-72"
        >
          <option value="" disabled>
            Choose the job card…
          </option>
          {jobs.map((job) => (
            <option key={job.id} value={job.id}>
              {job.label}
            </option>
          ))}
        </NativeSelect>
        <SubmitButton
          pending={isPending}
          variant="outline"
          className="h-10"
          pendingLabel="Linking…"
        >
          <Link2 />
          Link to job card
        </SubmitButton>
      </div>
      <FormError message={error} />
    </form>
  );
}
