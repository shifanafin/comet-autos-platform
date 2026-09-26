import type { ReactNode } from 'react';
import { LogOut, ShieldCheck } from 'lucide-react';
import { requireUser } from '@/lib/auth/authorize';
import { getAccountProfile } from '@/lib/auth/account';
import { logout } from '@/lib/auth/logout-action';
import { formatCalendarDate, formatDate, formatDateTime } from '@/lib/format';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { StatusPill } from '@/components/shared/status-pill';
import { Button } from '@/components/ui/button';
import { PasswordForm } from './password-form';

export const metadata = { title: 'My profile' };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:gap-6">
      <dt className="w-40 shrink-0 text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm font-medium">{children}</dd>
    </div>
  );
}

export default async function AccountPage() {
  const user = await requireUser();
  const profile = await getAccountProfile(user);
  const initials = profile.fullName
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Account"
        title={profile.fullName}
        leading={
          <span
            className="flex size-14 items-center justify-center rounded-full bg-primary text-lg font-semibold text-primary-foreground"
            aria-hidden
          >
            {initials}
          </span>
        }
        description={
          <>
            {profile.roles.map((role) => role.name).join(' · ') || 'No role assigned'}
            {profile.branch ? ` · ${profile.branch}` : ''}
          </>
        }
        actions={
          <form action={logout}>
            <Button type="submit" variant="outline" size="lg">
              <LogOut />
              Log out
            </Button>
          </form>
        }
      />

      <Grid className="items-start lg:grid-cols-2">
        <Section title="My profile">
          <Panel className="py-2 sm:py-3">
            <dl className="divide-y divide-border">
              <Row label="Full name">{profile.fullName}</Row>
              <Row label="Email">{profile.email}</Row>
              <Row label="Mobile">
                {profile.phone ?? <span className="text-muted-foreground">Not recorded</span>}
              </Row>
              <Row label="Role">
                <span className="flex flex-wrap gap-2">
                  {profile.roles.length === 0 ? (
                    <span className="text-muted-foreground">None</span>
                  ) : null}
                  {profile.roles.map((role) => (
                    <StatusPill key={role.name} tone="primary">
                      {role.name}
                    </StatusPill>
                  ))}
                </span>
              </Row>
              <Row label="Account status">
                <StatusPill tone={profile.isActive ? 'success' : 'danger'}>
                  {profile.isActive ? 'Active' : 'Disabled'}
                </StatusPill>
              </Row>
              <Row label="Joined">{formatDate(profile.joinedAt)}</Row>
              <Row label="Last sign-in">
                {profile.lastLoginAt ? formatDateTime(profile.lastLoginAt) : '—'}
              </Row>
            </dl>
          </Panel>
        </Section>

        <Section title="Employee record">
          <Panel className="py-2 sm:py-3">
            {profile.employee ? (
              <dl className="divide-y divide-border">
                <Row label="Employee code">{profile.employee.employeeCode}</Row>
                <Row label="Job title">{profile.employee.jobTitle ?? '—'}</Row>
                <Row label="Department">{profile.employee.department ?? '—'}</Row>
                <Row label="Hired">{formatCalendarDate(profile.employee.hireDate)}</Row>
              </dl>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">
                This login is not linked to an employee record.
              </p>
            )}
          </Panel>
        </Section>
      </Grid>

      <section id="password" className="flex scroll-mt-24 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold tracking-tight">Change password</h2>
          <p className="text-sm text-muted-foreground">
            You stay signed in here. Any other device or browser signed in to your account is signed
            out.
          </p>
        </div>
        <Panel className="max-w-2xl">
          <PasswordForm />
        </Panel>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="size-4" />
          Signed in on {profile.activeSessions} device{profile.activeSessions === 1 ? '' : 's'}.
          Passwords are stored encrypted and are never shown to anyone.
        </p>
      </section>
    </Stack>
  );
}
