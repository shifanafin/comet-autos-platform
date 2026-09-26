import Link from 'next/link';
import { ChevronRight, ShieldCheck, UserPlus, Users2 } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { listUsers, getAccessOptions, type UserRow } from '@/lib/access/users';
import { formatDateTime } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { TableWrap } from '@/components/shared/record-card';
import { UserFilters } from '@/components/access/user-filters';
import { AccessTabs } from '@/components/access/access-tabs';
import { getBrand } from '@/lib/brand/brand';

export const dynamic = 'force-dynamic';

function RoleChips({ roles }: { roles: UserRow['roles'] }) {
  if (roles.length === 0) {
    return <span className="text-xs text-warning">No role — cannot use the system</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {roles.map((role) => (
        <span
          key={role.id}
          className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-xs font-medium"
        >
          {role.isSystem ? <ShieldCheck className="size-3 text-primary" /> : null}
          {role.name}
        </span>
      ))}
    </span>
  );
}

function Status({ active }: { active: boolean }) {
  return (
    <StatusPill tone={active ? 'success' : 'neutral'}>{active ? 'Active' : 'Inactive'}</StatusPill>
  );
}

const lastSeen = (at: Date | null) => (at ? formatDateTime(at) : 'Never signed in');

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    status?: string;
    roleId?: string;
    branchId?: string;
    page?: string;
  }>;
}) {
  const user = await requireUser();
  const { shortName } = await getBrand(user.organizationId);
  if (!hasPermission(user, 'user.view')) {
    return <AccessDenied what={`who can use ${shortName}`} />;
  }
  const params = await searchParams;
  const status = (['active', 'inactive', 'all'] as const).includes(params.status as 'active')
    ? (params.status as 'active' | 'inactive' | 'all')
    : 'active';

  // Independent reads: the page and the filter choices together.
  const [page, options] = await Promise.all([
    listUsers(user, { ...params, status }),
    getAccessOptions(user),
  ]);
  const canManage = hasPermission(user, 'user.manage');
  const filtered = Boolean(params.q || params.roleId || params.branchId || params.status);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Settings"
        title="Users & roles"
        description={`Who can sign in to ${shortName}, and what each of them is allowed to do.`}
        actions={
          canManage ? (
            <LinkButton href="/settings/users/new" size="lg" className="h-11">
              <UserPlus />
              Add user
            </LinkButton>
          ) : null
        }
      />

      <AccessTabs active="users" />

      <UserFilters
        roles={options.roles}
        branches={options.branches}
        current={{
          q: params.q ?? '',
          status,
          roleId: params.roleId ?? '',
          branchId: params.branchId ?? '',
        }}
      />

      {page.users.length === 0 ? (
        <EmptyState
          icon={Users2}
          title={filtered ? 'No one matches those filters' : 'No users yet'}
          description={
            filtered
              ? 'Try a different search, or clear the filters to see everyone.'
              : `Add a login for anyone who needs to use ${shortName}.`
          }
          action={
            canManage && !filtered ? (
              <LinkButton href="/settings/users/new">
                <UserPlus />
                Add the first user
              </LinkButton>
            ) : undefined
          }
        />
      ) : (
        <Stack gap="md">
          {/* Phone & tablet: one tappable row per person, nothing cramped. */}
          <ul className="flex flex-col gap-2 lg:hidden">
            {page.users.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/settings/users/${row.id}`}
                  className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-4 transition-colors active:bg-muted"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium">{row.fullName}</span>
                      {!row.isActive ? <Status active={false} /> : null}
                    </span>
                    <span className="truncate text-sm text-muted-foreground">{row.email}</span>
                    <RoleChips roles={row.roles} />
                    <span className="text-xs text-muted-foreground">
                      {row.primaryBranch?.name ?? 'All branches'} · {lastSeen(row.lastLoginAt)}
                    </span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>

          {/* Desktop: denser, with the columns an administrator scans. */}
          <Panel padding="none" className="hidden overflow-hidden lg:block">
            <TableWrap>
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                  <tr>
                    <th className="px-6 py-4">Name</th>
                    <th className="px-2 py-4">Employee</th>
                    <th className="px-2 py-4">Contact</th>
                    <th className="px-2 py-4">Roles</th>
                    <th className="px-2 py-4">Branch</th>
                    <th className="px-2 py-4">Last signed in</th>
                    <th className="w-24 px-6 py-4">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {page.users.map((row) => (
                    <tr key={row.id} className="transition-colors hover:bg-muted/40">
                      <td className="px-6 py-4">
                        <Link
                          href={`/settings/users/${row.id}`}
                          className="font-medium text-foreground hover:text-primary"
                        >
                          {row.fullName}
                        </Link>
                      </td>
                      <td className="px-2 py-4 text-muted-foreground">
                        {row.employeeName ? (
                          <>
                            {row.employeeName}
                            <span className="block font-mono text-xs">
                              {row.employee?.employeeCode}
                            </span>
                          </>
                        ) : (
                          <span className="text-xs">Not linked</span>
                        )}
                      </td>
                      <td className="px-2 py-4 text-muted-foreground">
                        <span className="block truncate">{row.email}</span>
                        {row.phone ? <span className="block text-xs">{row.phone}</span> : null}
                      </td>
                      <td className="px-2 py-4">
                        <RoleChips roles={row.roles} />
                      </td>
                      <td className="px-2 py-4 text-muted-foreground">
                        {row.primaryBranch?.name ?? 'All branches'}
                      </td>
                      <td className="px-2 py-4 text-muted-foreground">
                        {lastSeen(row.lastLoginAt)}
                      </td>
                      <td className="px-6 py-4">
                        <Status active={row.isActive} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          </Panel>

          <Pager page={page} params={params} />
        </Stack>
      )}
    </Stack>
  );
}

/** Kept to whole pages: an administrator wants "more", not an offset box. */
function Pager({
  page,
  params,
}: {
  page: Awaited<ReturnType<typeof listUsers>>;
  params: Record<string, string | undefined>;
}) {
  if (page.pageCount <= 1) {
    return (
      <p className="px-1 text-xs text-muted-foreground">
        {page.total} {page.total === 1 ? 'person' : 'people'}
      </p>
    );
  }
  const href = (next: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value && key !== 'page') query.set(key, value);
    }
    query.set('page', String(next));
    return `/settings/users?${query.toString()}`;
  };
  return (
    <div className="flex items-center justify-between gap-3 px-1">
      <p className="text-xs text-muted-foreground">
        Page {page.page} of {page.pageCount} · {page.total} people
      </p>
      <div className="flex gap-2">
        {page.page > 1 ? (
          <LinkButton href={href(page.page - 1)} variant="outline" className="h-10">
            Previous
          </LinkButton>
        ) : null}
        {page.page < page.pageCount ? (
          <LinkButton href={href(page.page + 1)} variant="outline" className="h-10">
            Next
          </LinkButton>
        ) : null}
      </div>
    </div>
  );
}
