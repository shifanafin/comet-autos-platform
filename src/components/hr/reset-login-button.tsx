'use client';

import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FormError } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import { IssuedPassword } from '@/components/hr/issued-password';
import { resetEmployeeLoginAction } from '@/app/(app)/hr/actions';

type Issued = { username: string; temporaryPassword: string };

/** Gives the login a new one-time password, shown once; asks before doing it. */
export function ResetLoginButton({ employeeId }: { employeeId: string }) {
  const [confirming, setConfirming] = useState(false);
  const [state, onSubmit, isPending] = useFormAction<ActionResult<Issued>>(
    async () => {
      const result = await resetEmployeeLoginAction(employeeId);
      if (result.ok) setConfirming(false);
      return result;
    },
    { ok: false },
  );

  if (state.ok && state.data) {
    return (
      <div className="mt-2">
        <IssuedPassword username={state.data.username} password={state.data.temporaryPassword} />
      </div>
    );
  }
  if (!confirming) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="mt-2 self-start"
        onClick={() => setConfirming(true)}
      >
        <KeyRound />
        Reset password
      </Button>
    );
  }
  return (
    <form onSubmit={onSubmit} className="mt-2 flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        They will be signed out everywhere. A new one-time password is shown once — give it to them
        privately; they choose their own at the next sign-in.
      </p>
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={isPending} size="sm" pendingLabel="Resetting…">
          Reset password
        </SubmitButton>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Cancel
        </Button>
      </div>
      <FormError message={state.error} />
    </form>
  );
}
