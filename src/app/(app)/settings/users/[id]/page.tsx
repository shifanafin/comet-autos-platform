import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Clock, IdCard, Mail, MapPin, Phone, Pencil, ShieldCheck } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getUserDetail } from '@/lib/access/users';
import { formatDateTime } from '@/lib/format';
import { PERMISSION_MODULES } from '@/lib/auth/permission-catalog';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { UserAccountActions } from '@/components/access/user-account-actions';

export const dynamic = 'force-dynamic';

function Line({ icon: Icon, label, value }: { icon: typeof Mail; label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="text-xs text-muted-foreground">{label}</span>
        <span className="text-sm break-words">{value}</span>
      </span>
    </div>
  );
}

export default async function UserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, 'user.view')) {
    return <AccessDenied what="this user's access" />;
  }
  const { id } = await params;
  const { created } = await searchParams;

  let detail;
  try {
    detail = await getUserDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  const canManage = hasPermission(user, 'user.manage');
  const isSelf = detail.id === user.id;
  const held = new Set(detail.permissions);
  const modules = PERMISSION_MODULES.map((module) => ({
    ...module,
    granted: module.permissions.filter((permission) => held.has(permission.code)),
  })).filter((module) => module.granted.length > 0);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <Link
        href="/settings/users"
        className="-ml-2 inline-flex h-11 w-fit items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Users & roles
      </Link>

      <PageHeader
        eyebrow="User"
        title={detail.fullName}
        description={
          detail.isActive
            ? `Last signed in ${detail.lastLoginAt ? formatDateTime(detail.lastLoginAt) : 'never'}.`
            : 'This account is deactivated and cannot sign in.'
        }
        actions={
          canManage ? (
            <LinkButton href={`/settings/users/${detail.id}/edit`} className="h-11">
              <Pencil />
              Edit
            </LinkButton>
          ) : null
        }
      />

      {created ? (
        <p className="rounded-xl border border-success/30 bg-success/5 px-4 py-3 text-sm text-success">
          Account created. Give them the password you set — they can change it from their own
          account page.
        </p>
      ) : null}

      <Grid gap="xl" className="items-start lg:grid-cols-12">
        <Stack gap="xl" className="lg:col-span-5">
          <Section title="Account">
            <Panel className="flex flex-col gap-5">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-medium">Status</span>
                <StatusPill tone={detail.isActive ? 'success' : 'neutral'}>
                  {detail.isActive ? 'Active' : 'Inactive'}
                </StatusPill>
              </div>
              <div className="flex flex-col gap-4 border-t border-border pt-5">
                <Line icon={Mail} label="Email" value={detail.email} />
                {detail.phone ? <Line icon={Phone} label="Mobile" value={detail.phone} /> : null}
                <Line
                  icon={MapPin}
                  label="Branch"
                  value={detail.primaryBranch?.name ?? 'All branches'}
                />
                <Line
                  icon={IdCard}
                  label="Employee record"
                  value={
                    detail.employeeName
                      ? `${detail.employeeName} · ${detail.employee?.employeeCode}${
                          detail.employee?.jobTitle ? ` · ${detail.employee.jobTitle}` : ''
                        }`
                      : 'Not linked to an employee'
                  }
                />
                <Line
                  icon={Clock}
                  label="Account created"
                  value={formatDateTime(detail.createdAt)}
                />
              </div>
            </Panel>
          </Section>

          <Section title="Roles" description="What they hold, and who granted it.">
            <Panel padding="none" className="overflow-hidden">
              {detail.grants.length === 0 ? (
                <p className="px-4 py-5 text-sm text-warning sm:px-6">
                  No role. This account can sign in but cannot reach anything.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {detail.grants.map((grant) => (
                    <li key={grant.id} className="flex flex-col gap-1 px-4 py-4 sm:px-6">
                      <span className="flex items-center gap-1.5 font-medium">
                        {grant.isSystem ? <ShieldCheck className="size-4 text-primary" /> : null}
                        {grant.roleName}
                        {grant.scope ? (
                          <span className="text-xs font-normal text-muted-foreground">
                            · {grant.scope} only
                          </span>
                        ) : null}
                      </span>
                      {grant.description ? (
                        <span className="text-sm text-muted-foreground">{grant.description}</span>
                      ) : null}
                      <span className="text-xs text-muted-foreground">
                        Granted {formatDateTime(grant.assignedAt)}
                        {grant.assignedBy ? ` by ${grant.assignedBy}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Section>

          {canManage ? (
            <Section title="Account actions" description="Sensitive changes are recorded.">
              <Panel>
                <UserAccountActions
                  userId={detail.id}
                  name={detail.fullName}
                  isActive={detail.isActive}
                  isSelf={isSelf}
                />
              </Panel>
            </Section>
          ) : null}
        </Stack>

        <Stack gap="xl" className="lg:col-span-7">
          <Section
            title="What they can do"
            description={
              detail.permissions.length === 0
                ? 'Nothing — their roles carry no permissions.'
                : `${detail.permissions.length} permissions, from the roles above.`
            }
          >
            <Panel padding="none" className="overflow-hidden">
              {modules.length === 0 ? (
                <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">
                  Give them a role to let them reach anything.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {modules.map((module) => (
                    <li key={module.key} className="flex flex-col gap-2 px-4 py-4 sm:px-6">
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-medium">{module.label}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {module.granted.length} of {module.permissions.length}
                        </span>
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {module.granted.map((permission) => (
                          <span
                            key={permission.code}
                            title={permission.detail}
                            className="rounded-md bg-muted px-2 py-0.5 text-xs"
                          >
                            {permission.label}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Section>

          <Section title="Recent activity" description="The last changes this person made.">
            <Panel padding="none" className="overflow-hidden">
              {detail.activity.length === 0 ? (
                <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">
                  Nothing recorded for this account yet.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {detail.activity.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm sm:px-6"
                    >
                      <span className="font-mono text-xs">{entry.action}</span>
                      <span className="text-xs text-muted-foreground">
                        {entry.entityType} · {formatDateTime(entry.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </Section>
        </Stack>
      </Grid>
    </Stack>
  );
}
