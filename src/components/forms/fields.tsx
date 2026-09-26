import type { ComponentProps, ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

const CONTROL =
  'w-full min-w-0 rounded-lg border border-input bg-card px-3 text-sm transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20';

/** Label → control (8px) → hint/error (8px). Fields are stacked 24px apart by their parent form. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  required?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? (
          <span className="text-destructive" aria-hidden>
            *
          </span>
        ) : null}
      </Label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * A labelled input. Its id defaults to its name; pass `id` when the same
 * field name appears twice on a page (two forms, or a form in a dialog).
 */
export function TextField({
  id,
  label,
  name,
  error,
  hint,
  required,
  className,
  ...inputProps
}: Omit<ComponentProps<'input'>, 'name'> & {
  label: ReactNode;
  name: string;
  error?: string;
  hint?: ReactNode;
}) {
  const inputId = id ?? name;
  return (
    <Field
      label={label}
      htmlFor={inputId}
      error={error}
      hint={hint}
      required={required}
      className={className}
    >
      <Input
        id={inputId}
        name={name}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...inputProps}
      />
    </Field>
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea className={cn(CONTROL, 'min-h-24 py-2 leading-relaxed', className)} {...props} />
  );
}

/** A labelled textarea. Like TextField, its id defaults to its name. */
export function TextareaField({
  id,
  label,
  name,
  error,
  hint,
  required,
  className,
  ...props
}: Omit<ComponentProps<'textarea'>, 'name'> & {
  label: ReactNode;
  name: string;
  error?: string;
  hint?: ReactNode;
}) {
  const inputId = id ?? name;
  return (
    <Field
      label={label}
      htmlFor={inputId}
      error={error}
      hint={hint}
      required={required}
      className={className}
    >
      <Textarea
        id={inputId}
        name={name}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${inputId}-error` : undefined}
        {...props}
      />
    </Field>
  );
}

export function NativeSelect({ className, ...props }: ComponentProps<'select'>) {
  return <select className={cn(CONTROL, 'h-9 pr-8', className)} {...props} />;
}

/** Form-level error banner. */
export function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
    >
      {message}
    </div>
  );
}
