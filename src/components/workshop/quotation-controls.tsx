'use client';

import { useState, useTransition } from 'react';
import { useFormAction } from '@/components/forms/use-form-action';
import { useRouter } from 'next/navigation';
import { FilePlus2, GitBranch, Link2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Field,
  FormError,
  NativeSelect,
  TextField,
  TextareaField,
} from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { ConfirmAction } from '@/components/shared/confirm-action';
import { SignaturePad } from '@/components/media/signature-pad';
import type { ActionResult } from '@/lib/errors';
import { cn } from '@/lib/utils';
import {
  recordQuotationDecisionAction,
  reissueQuotationLinkAction,
  reviseQuotationAction,
} from '@/app/(app)/quotations/actions';
import { createEstimateAction } from '@/app/(app)/job-cards/[id]/actions';
import { CustomerLinkPanel } from '@/components/workshop/customer-link-panel';

function useSimpleAction() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  function run(action: () => Promise<ActionResult>, success: string) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) return setError(result.error ?? 'Something went wrong.');
      toast.success(success);
      router.refresh();
    });
  }
  return { error, isPending, run };
}

export function CreateEstimateButton({
  jobCardId,
  /** Full-width, for a card on the job card screen. */
  compact = false,
}: {
  jobCardId: string;
  compact?: boolean;
}) {
  const { error, isPending, run } = useSimpleAction();
  return (
    <div className="flex flex-col gap-3">
      <Button
        size="lg"
        className={compact ? 'h-11 w-full' : 'self-start'}
        disabled={isPending}
        onClick={() => run(() => createEstimateAction(jobCardId), 'Quotation created')}
      >
        {isPending ? <Loader2 className="animate-spin" /> : <FilePlus2 />}
        Create quotation
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export function ReviseQuotationButton({
  estimateId,
  variant = 'outline',
}: {
  estimateId: string;
  variant?: 'outline' | 'default';
}) {
  const { error, isPending, run } = useSimpleAction();
  return (
    <div className="flex flex-col gap-2">
      <ConfirmAction
        tone="default"
        trigger={
          <Button variant={variant} disabled={isPending}>
            {isPending ? <Loader2 className="animate-spin" /> : <GitBranch />}
            Revise quotation
          </Button>
        }
        title="Create a revised version?"
        description="A new draft is created from this version. The current version and its history are kept, and its customer link stops working."
        confirmLabel="Create revision"
        onConfirm={async () =>
          run(() => reviseQuotationAction(estimateId), 'Revision created')
        }
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export function NewLinkButton({
  estimateId,
  customerName,
}: {
  estimateId: string;
  customerName: string;
}) {
  const [link, setLink] = useState<{ link: string; whatsappUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (link)
    return (
      <CustomerLinkPanel
        link={link.link}
        whatsappUrl={link.whatsappUrl}
        customerName={customerName}
        onDone={() => setLink(null)}
      />
    );

  return (
    <div className="flex flex-col gap-2">
      <ConfirmAction
        tone="default"
        trigger={
          <Button variant="outline" disabled={isPending}>
            {isPending ? <Loader2 className="animate-spin" /> : <Link2 />}
            Get customer link
          </Button>
        }
        title="Create a new customer link?"
        description="Links are shown only once. A new link is created and any earlier link for this quotation stops working."
        confirmLabel="Create link"
        onConfirm={async () =>
          startTransition(async () => {
            setError(null);
            const result = await reissueQuotationLinkAction(estimateId);
            if (!result.ok || !result.data)
              return setError(result.error ?? 'Could not create a link.');
            setLink(result.data);
          })
        }
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}

export function RecordDecisionForm({
  estimateId,
  customerName,
}: {
  estimateId: string;
  customerName: string;
}) {
  const router = useRouter();
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [method, setMethod] = useState('');
  const [signed, setSigned] = useState(false);
  // The customer can only sign on the workshop device when they are standing here.
  const canSign = decision === 'APPROVED' && method === 'IN_PERSON';
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await recordQuotationDecisionAction(estimateId, prev, formData);
      if (result.ok) {
        toast.success(decision === 'APPROVED' ? 'Approval recorded' : 'Rejection recorded');
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <input type="hidden" name="decision" value={decision} />
      <div role="radiogroup" aria-label="Customer decision" className="grid grid-cols-2 gap-3">
        {(['APPROVED', 'REJECTED'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={decision === value}
            onClick={() => setDecision(value)}
            className={cn(
              'h-11 rounded-lg border text-sm font-medium transition-colors',
              decision === value
                ? value === 'APPROVED'
                  ? 'border-success bg-success text-success-foreground'
                  : 'border-danger bg-danger text-danger-foreground'
                : 'border-border bg-background text-muted-foreground hover:bg-muted',
            )}
          >
            {value === 'APPROVED' ? 'Approved' : 'Rejected'}
          </button>
        ))}
      </div>
      <Field
        label="How did the customer tell you?"
        htmlFor="method"
        required
        error={state.fieldErrors?.method}
      >
        <NativeSelect
          id="method"
          name="method"
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          required
        >
          <option value="" disabled>
            Choose…
          </option>
          <option value="IN_PERSON">In person</option>
          <option value="PHONE">Phone call</option>
          <option value="EMAIL">Email</option>
          <option value="SMS">SMS / WhatsApp message</option>
        </NativeSelect>
      </Field>
      <TextareaField
        label="Notes"
        name="notes"
        placeholder="e.g. Approved by phone, wants the car by Thursday"
      />
      {canSign ? (
        <div className="flex flex-col gap-4 border-t border-border pt-5">
          <SignaturePad
            label="Customer signature"
            optionalNote="Optional — the approval is recorded either way."
            onChange={(value) => setSigned(value !== null)}
          />
          {signed ? (
            <TextField
              label="Who signed"
              name="signerName"
              defaultValue={customerName}
              hint="Leave as is if the customer signed themselves."
            />
          ) : null}
        </div>
      ) : null}
      <FormError message={state.error} />
      <SubmitButton
        pending={isPending}
        variant={decision === 'APPROVED' ? 'default' : 'destructive'}
        size="lg"
        className="self-start"
        pendingLabel="Recording…"
      >
        Record {decision === 'APPROVED' ? 'approval' : 'rejection'}
      </SubmitButton>
    </form>
  );
}
