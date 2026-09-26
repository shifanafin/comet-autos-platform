'use client';

import { useActionState, useState } from 'react';
import { ArrowRight, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { login, type LoginState } from './actions';

const initialState: LoginState = {};

const FIELD =
  'h-12 w-full rounded-md border bg-card px-3.5 text-base text-foreground shadow-xs transition-[border-color,box-shadow] outline-none placeholder:text-muted-foreground/70 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:opacity-60';

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, isPending] = useActionState(login, initialState);
  const [showPassword, setShowPassword] = useState(false);
  const invalid = Boolean(state.error);

  return (
    <form
      action={formAction}
      className="flex flex-col gap-6"
      aria-describedby={invalid ? 'login-error' : undefined}
    >
      <input type="hidden" name="next" value={next} />

      {invalid ? (
        <div
          id="login-error"
          role="alert"
          className="flex gap-3 rounded-md border border-destructive/25 bg-destructive/[0.06] px-3.5 py-3 text-sm text-destructive"
        >
          <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive" />
          {state.error}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="identifier" className="text-sm font-medium">
          Email or mobile number
        </Label>
        <input
          id="identifier"
          name="identifier"
          type="text"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          autoFocus
          placeholder="Email or mobile, e.g. 050 123 4567"
          defaultValue={state.identifier}
          key={state.identifier ?? 'empty'}
          readOnly={isPending}
          aria-invalid={invalid || undefined}
          className={cn(FIELD, invalid ? 'border-destructive/60' : 'border-input')}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password" className="text-sm font-medium">
          Password
        </Label>
        <div className="relative">
          <input
            id="password"
            name="password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            required
            readOnly={isPending}
            aria-invalid={invalid || undefined}
            className={cn(FIELD, 'pr-12', invalid ? 'border-destructive/60' : 'border-input')}
          />
          <button
            type="button"
            onClick={() => setShowPassword((shown) => !shown)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            aria-pressed={showPassword}
            className="absolute top-1/2 right-1.5 flex size-9 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {showPassword ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
          </button>
        </div>
      </div>

      <button
        type="submit"
        disabled={isPending}
        aria-busy={isPending}
        className="mt-2 inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-5 text-[0.95rem] font-semibold text-primary-foreground shadow-sm shadow-primary/25 transition-[background-color,transform] outline-none hover:bg-primary-hover focus-visible:ring-4 focus-visible:ring-primary/30 active:translate-y-px disabled:cursor-wait disabled:opacity-80"
      >
        {isPending ? (
          <>
            <Loader2 className="size-[18px] animate-spin" />
            Signing in…
          </>
        ) : (
          <>
            Sign in
            <ArrowRight className="size-[18px]" />
          </>
        )}
      </button>
    </form>
  );
}
