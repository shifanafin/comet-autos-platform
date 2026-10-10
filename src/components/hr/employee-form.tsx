'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { LinkButton } from '@/components/shared/link-button';
import { Button } from '@/components/ui/button';
import { IssuedPassword } from '@/components/hr/issued-password';
import type { ActionResult } from '@/lib/errors';

const INPUT = '[&_input]:h-11 [&_input]:text-base md:[&_input]:text-sm';

/** A login just made, with its one-time password. */
type IssuedLogin = { id: string; username: string; temporaryPassword: string };

/** The login choice that creates a new login (lib/hr/employees NEW_LOGIN). */
const NEW_LOGIN = 'new';

export interface EmployeeFormOptions {
  branches: { id: string; name: string }[];
  /** Logins not yet anyone's, with what each signs in with. */
  users: { id: string; fullName: string; signsInAs: string }[];
  designations: { id: string; name: string; roleId: string | null }[];
  /** Whether this user may create logins. */
  canCreateLogin: boolean;
}

export function EmployeeForm({
  action,
  options,
  initial,
  cancelHref,
}: {
  action: (
    prev: ActionResult<IssuedLogin>,
    formData: FormData,
  ) => Promise<ActionResult<IssuedLogin>>;
  options: EmployeeFormOptions;
  initial?: {
    firstName: string;
    lastName: string;
    employeeCode: string;
    jobTitle: string | null;
    designationId: string | null;
    phone: string | null;
    email: string | null;
    department: string | null;
    hireDate: string;
    terminationDate: string | null;
    probationEndDate?: string | null;
    normalHoursPerDay?: string | null;
    leaveOpeningDays?: string | null;
    leaveOpeningAsOf?: string | null;
    branchId: string;
    userId: string | null;
    isActive: boolean;
  };
  cancelHref: string;
}) {
  const [state, onSubmit, isPending] = useFormAction<ActionResult<IssuedLogin>>(action, {
    ok: false,
  });
  const router = useRouter();
  const errors = state.fieldErrors ?? {};
  const offerNewLogin = options.canCreateLogin && !initial?.userId;
  const [login, setLogin] = useState(
    initial ? (initial.userId ?? '') : offerNewLogin ? NEW_LOGIN : '',
  );
  const legacyTitle = initial && !initial.designationId ? initial.jobTitle : null;

  // A login was just made: show its one-time password once, then move on.
  if (state.ok && state.data?.temporaryPassword) {
    return (
      <div className="flex flex-col gap-5">
        <IssuedPassword username={state.data.username} password={state.data.temporaryPassword} />
        <div>
          <Button
            size="lg"
            className="h-11"
            onClick={() => router.push(`/hr/employees/${state.data!.id}`)}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-6">
        <legend className="sr-only">Who they are</legend>
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField
            label="First name"
            name="firstName"
            required
            defaultValue={initial?.firstName}
            error={errors.firstName}
            autoFocus={!initial}
            autoComplete="given-name"
            className={INPUT}
          />
          <TextField
            label="Last name"
            name="lastName"
            required
            defaultValue={initial?.lastName}
            error={errors.lastName}
            autoComplete="family-name"
            className={INPUT}
          />
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField
            label="Employee code"
            name="employeeCode"
            defaultValue={initial?.employeeCode}
            error={errors.employeeCode}
            autoCapitalize="characters"
            hint={
              initial
                ? 'Also their sign-in name, if they have a login.'
                : 'Leave empty for the next code (EMP-001, EMP-002…). Also their sign-in name.'
            }
            className={`${INPUT} [&_input]:font-mono`}
          />
          <Field
            label="Designation"
            htmlFor="designationId"
            error={errors.designationId}
            hint={
              <>
                {legacyTitle ? `Job title on record: ${legacyTitle}. ` : null}
                Decides what their login can do.{' '}
                <Link href="/hr/designations" className="underline underline-offset-2">
                  Manage designations
                </Link>
              </>
            }
          >
            <NativeSelect
              id="designationId"
              name="designationId"
              defaultValue={initial?.designationId ?? ''}
              className="h-11 text-base md:text-sm"
            >
              <option value="">No designation</option>
              {options.designations.map((designation) => (
                <option key={designation.id} value={designation.id}>
                  {designation.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField
            label="Mobile number"
            name="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            defaultValue={initial?.phone ?? ''}
            error={errors.phone}
            hint="How the workshop reaches them."
            className={INPUT}
          />
          <TextField
            label="Email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            defaultValue={initial?.email ?? ''}
            error={errors.email}
            className={INPUT}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-6 border-t border-border pt-8">
        <legend className="sr-only">Where they work</legend>
        <div className="grid gap-6 sm:grid-cols-2">
          <Field label="Branch" htmlFor="branchId" required error={errors.branchId}>
            <NativeSelect
              id="branchId"
              name="branchId"
              required
              defaultValue={initial?.branchId ?? options.branches[0]?.id ?? ''}
              className="h-11 text-base md:text-sm"
            >
              {options.branches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <TextField
            label="Department"
            name="department"
            defaultValue={initial?.department ?? ''}
            error={errors.department}
            className={INPUT}
          />
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField
            label="Joined"
            name="hireDate"
            type="date"
            required
            defaultValue={initial?.hireDate}
            error={errors.hireDate}
            className={INPUT}
          />
          <TextField
            label="Left"
            name="terminationDate"
            type="date"
            defaultValue={initial?.terminationDate ?? ''}
            error={errors.terminationDate}
            hint="Leave empty while they still work here."
            className={INPUT}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-6 border-t border-border pt-8">
        <legend className="text-sm font-semibold">Work and leave</legend>
        <div className="grid gap-6 sm:grid-cols-2">
          <TextField
            label="Probation ends"
            name="probationEndDate"
            type="date"
            defaultValue={initial?.probationEndDate ?? ''}
            error={errors.probationEndDate}
            hint="Empty: 6 months after joining. Sick leave in probation is unpaid."
            className={INPUT}
          />
          <TextField
            label="Normal hours a day"
            name="normalHoursPerDay"
            inputMode="decimal"
            defaultValue={initial?.normalHoursPerDay ?? '8'}
            error={errors.normalHoursPerDay}
            hint="8 under UAE law. Hours beyond are overtime."
            className={INPUT}
          />
          <TextField
            label="Annual leave balance carried in (days)"
            name="leaveOpeningDays"
            inputMode="decimal"
            defaultValue={initial?.leaveOpeningDays ?? ''}
            error={errors.leaveOpeningDays}
            hint="Only for someone who joined before these books: the days they had left."
            className={INPUT}
          />
          <TextField
            label="…on this date"
            name="leaveOpeningAsOf"
            type="date"
            defaultValue={initial?.leaveOpeningAsOf ?? ''}
            error={errors.leaveOpeningAsOf}
            hint="Leave builds up from this date on."
            className={INPUT}
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-6 border-t border-border pt-8">
        <legend className="sr-only">System access</legend>
        <Field
          label="System login"
          htmlFor="userId"
          error={errors.userId}
          hint={
            login === NEW_LOGIN
              ? 'They sign in with their employee code. A one-time password is shown once after saving — give it to them privately; they choose their own at the first sign-in. What they can do comes from the designation.'
              : 'Optional. A technician who never signs in is still recorded against their work.'
          }
        >
          <NativeSelect
            id="userId"
            name="userId"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            className="h-11 text-base md:text-sm"
          >
            <option value="">No login</option>
            {offerNewLogin ? (
              <option value={NEW_LOGIN}>Create a login (employee code as username)</option>
            ) : null}
            {options.users.map((account) => (
              <option key={account.id} value={account.id}>
                {account.fullName}
                {account.signsInAs ? ` — ${account.signsInAs}` : ''}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {initial ? (
          <Field
            label="Status"
            htmlFor="isActive"
            hint="An inactive employee keeps all their work history."
          >
            <NativeSelect
              id="isActive"
              name="isActive"
              defaultValue={initial.isActive ? 'true' : 'false'}
              className="h-11 text-base md:text-sm"
            >
              <option value="true">Working here</option>
              <option value="false">No longer working here</option>
            </NativeSelect>
          </Field>
        ) : null}
      </fieldset>

      <FormError message={Object.keys(errors).length ? undefined : state.error} />
      <div className="flex flex-wrap gap-3 border-t border-border pt-6">
        <SubmitButton pending={isPending} size="lg" className="h-11" pendingLabel="Saving…">
          {initial ? 'Save changes' : 'Add employee'}
        </SubmitButton>
        <LinkButton href={cancelHref} variant="ghost" size="lg" className="h-11">
          Cancel
        </LinkButton>
      </div>
    </form>
  );
}
