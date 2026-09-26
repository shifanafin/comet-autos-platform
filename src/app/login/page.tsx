import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/auth/session';
import { safeReturnPath } from '@/lib/auth/sign-in';
import { LoginForm } from './login-form';
import { getBrand } from '@/lib/brand/brand';

export const metadata = { title: 'Sign in' };

/** The app's mark (the same initial tile used in the sidebar). */
function Mark({
  initial,
  className = 'size-10 text-base',
}: {
  initial: string;
  className?: string;
}) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg bg-sidebar-primary font-bold text-sidebar-primary-foreground ${className}`}
      aria-hidden
    >
      {initial}
    </span>
  );
}

const JOURNEY = ['Check-in', 'Inspection', 'Estimate', 'Repair', 'Invoice', 'Handover'];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next: rawNext } = await searchParams;
  const next = safeReturnPath(rawNext);
  if (await getCurrentUser()) redirect(next);
  const brand = await getBrand();

  return (
    <main className="flex min-h-dvh flex-col bg-background lg:flex-row">
      {/* Brand side — restrained: dark ground, a fine technical grid, one brand accent. */}
      <section
        aria-label={brand.name}
        className="relative hidden w-[40%] max-w-[640px] shrink-0 flex-col justify-between overflow-hidden bg-sidebar px-12 py-12 text-sidebar-foreground lg:flex xl:px-16"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              'linear-gradient(to right, currentColor 1px, transparent 1px), linear-gradient(to bottom, currentColor 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'linear-gradient(to bottom, black 0%, transparent 85%)',
          }}
        />
        <div
          aria-hidden
          className="absolute top-0 left-12 h-24 w-px bg-sidebar-primary xl:left-16"
        />

        <div className="relative flex items-center gap-3.5 pt-8">
          <Mark initial={brand.initial} />
          <div className="flex flex-col">
            <span className="text-sm font-semibold tracking-[0.18em] uppercase">
              {brand.shortName}
            </span>
            <span className="text-xs text-sidebar-foreground/55">Workshop Management System</span>
          </div>
        </div>

        <div className="relative flex max-w-md flex-col gap-5">
          <p className="text-[2.1rem] leading-[1.15] font-semibold tracking-tight">
            One place to manage every vehicle, job and customer.
          </p>
          <ol className="flex flex-wrap items-center gap-x-2 gap-y-1.5 font-mono text-[11px] tracking-wide text-sidebar-foreground/45 uppercase">
            {JOURNEY.map((step, index) => (
              <li key={step} className="flex items-center gap-2">
                {index > 0 ? (
                  <span aria-hidden className="h-px w-3 bg-sidebar-foreground/25" />
                ) : null}
                {step}
              </li>
            ))}
          </ol>
        </div>

        <div className="relative flex items-center justify-between border-t border-white/10 pt-5 text-xs text-sidebar-foreground/45">
          <span>Staff access only</span>
        </div>
      </section>

      {/* Compact brand bar on phones and tablets. */}
      <header className="flex items-center gap-3 bg-sidebar px-5 py-4 text-sidebar-foreground lg:hidden">
        <Mark initial={brand.initial} className="size-9 text-sm" />
        <div className="flex flex-col">
          <span className="text-xs font-semibold tracking-[0.18em] uppercase">
            {brand.shortName}
          </span>
          <span className="text-[11px] text-sidebar-foreground/55">Workshop Management System</span>
        </div>
      </header>

      {/* The sign-in form — the focus of the page. */}
      <section className="flex flex-1 items-start justify-center px-5 pt-10 pb-16 sm:items-center sm:px-8 sm:py-16">
        <div className="w-full max-w-[400px]">
          <h1 className="text-[1.75rem] leading-tight font-semibold tracking-tight">
            Welcome back
          </h1>
          <p className="mt-2 text-[0.95rem] text-muted-foreground">
            Sign in to your workshop workspace.
          </p>
          <div className="mt-9">
            <LoginForm next={next} />
          </div>
          <p className="mt-10 border-t border-border pt-5 text-xs leading-relaxed text-muted-foreground">
            Use the account the workshop created for you. Signing in keeps you signed in on this
            device for 7 days, until you log out.
          </p>
        </div>
      </section>
    </main>
  );
}
