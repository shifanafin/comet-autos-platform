import { redirect } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { getCurrentUser } from '@/lib/auth/session';
import { logout } from '@/lib/auth/logout-action';
import { SetPasswordForm } from './set-password-form';

export const metadata = { title: 'Choose your password' };
export const dynamic = 'force-dynamic';

/**
 * Where a login with a password someone else set lands until it chooses its
 * own — an employee's first sign-in uses the one-time password they were given.
 */
export default async function SetPasswordPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (!user.mustChangePassword) redirect('/');

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-2">
          <span className="flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <KeyRound className="size-5" />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Choose your own password</h1>
          <p className="text-sm text-muted-foreground">
            Welcome, {user.fullName}. The password you signed in with was given to you, so choose
            one only you know before you start.
          </p>
        </div>
        <SetPasswordForm />
        <form action={logout}>
          <button
            type="submit"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Sign out instead
          </button>
        </form>
      </div>
    </main>
  );
}
