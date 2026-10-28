import Link from 'next/link';
import { ArrowRight, FileWarning, IdCard, Plus } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { listEmployees } from '@/lib/hr/employees';
import { getExpiringEmployeeDocuments } from '@/lib/hr/employee-documents';
import { formatCalendarDate, formatDate } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { AccessDenied } from '@/components/shared/access-denied';
import { EmptyState } from '@/components/shared/empty-state';
import { Pagination } from '@/components/shared/pagination';
import { pageFrom, slicePage } from '@/lib/pagination';
import { LinkButton } from '@/components/shared/link-button';
import { SearchField } from '@/components/shared/search-field';
import { StatusPill } from '@/components/shared/status-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const SHOW = ['active', 'inactive', 'all'] as const;
type Show = (typeof SHOW)[number];

export default async function EmployeesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; show?: string; page?: string }>;
}) {
  const user = await requireUser();
  if (!hasPermission(user, 'employee.view')) return <AccessDenied what="the team" />;

  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const show: Show = SHOW.includes(params.show as Show) ? (params.show as Show) : 'active';
  const { rows: employees, info } = slicePage(
    await listEmployees(user, { query, show }),
    pageFrom(params.page),
  );
  const canManage = hasPermission(user, 'employee.create');
  const filtered = Boolean(query) || show !== 'active';
  // Papers past or near their expiry — only for those who keep employees' papers.
  const expiring = await getExpiringEmployeeDocuments(user);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="HR & Payroll"
        title="Employees"
        description="Everyone who works on vehicles here. Their work stays attributed to them even after they leave."
        actions={
          canManage ? (
            <LinkButton href="/hr/employees/new" size="lg">
              <Plus />
              Add employee
            </LinkButton>
          ) : null
        }
      />

      {expiring.length > 0 ? (
        <Panel padding="none" className="overflow-hidden border-warning/40">
          <p className="flex items-center gap-2 border-b border-border bg-warning/5 px-4 py-3 text-sm font-medium sm:px-6">
            <FileWarning className="size-4 shrink-0 text-warning" />
            Documents to renew
          </p>
          <ul className="divide-y divide-border">
            {expiring.map((row) => (
              <li key={row.id}>
                <Link
                  href={`/hr/employees/${row.employeeId}#documents`}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm hover:bg-muted/60 sm:px-6"
                >
                  <span className="min-w-0">
                    <span className="font-medium">{row.employeeName}</span>
                    <span className="text-muted-foreground"> · {row.label}</span>
                  </span>
                  <StatusPill tone={row.status === 'expired' ? 'danger' : 'warning'}>
                    {row.status === 'expired'
                      ? `Expired ${formatCalendarDate(row.expiryDate)}`
                      : row.days === 0
                        ? 'Expires today'
                        : `Expires in ${row.days} days`}
                  </StatusPill>
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <Stack gap="base">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <SearchField initialQuery={query} placeholder="Name, code or job title" />
          </div>
          <nav aria-label="Filter by status" className="flex gap-1 rounded-lg bg-muted p-1">
            {SHOW.map((option) => (
              <Link
                key={option}
                href={`/hr/employees?${new URLSearchParams({ ...(query ? { q: query } : {}), show: option })}`}
                aria-current={show === option ? 'page' : undefined}
                className={
                  show === option
                    ? 'rounded-md bg-card px-3 py-1.5 text-sm font-medium shadow-card'
                    : 'rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground'
                }
              >
                {option === 'active' ? 'Working' : option === 'inactive' ? 'Left' : 'All'}
              </Link>
            ))}
          </nav>
        </div>

        {employees.length === 0 ? (
          <EmptyState
            icon={IdCard}
            title={filtered ? 'Nobody matches those filters' : 'No employees yet'}
            description={
              filtered
                ? 'Try a different search, or switch to “All”.'
                : 'Add the technicians and advisors who work on vehicles here.'
            }
            action={
              canManage && !filtered ? (
                <LinkButton href="/hr/employees/new">
                  <Plus />
                  Add employee
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            {/* Phone: one tappable card per person. */}
            <ul className="divide-y divide-border md:hidden">
              {employees.map((employee) => (
                <li key={employee.id}>
                  <Link
                    href={`/hr/employees/${employee.id}`}
                    className="flex items-center gap-3 px-4 py-4 active:bg-muted"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium">{employee.name}</span>
                        {!employee.isActive ? <StatusPill tone="neutral">Left</StatusPill> : null}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        <span className="font-mono">{employee.employeeCode}</span>
                        {employee.jobTitle ? ` · ${employee.jobTitle}` : ''} ·{' '}
                        {employee.branch.name}
                      </span>
                    </div>
                    <ArrowRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>

            <div className="hidden md:block">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Employee</TableHead>
                    <TableHead>Job title</TableHead>
                    <TableHead className="hidden lg:table-cell">Branch</TableHead>
                    <TableHead className="hidden lg:table-cell">Joined</TableHead>
                    <TableHead className="text-right">Open jobs</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {employees.map((employee) => (
                    <TableRow key={employee.id} className="relative">
                      <TableCell>
                        <Link
                          href={`/hr/employees/${employee.id}`}
                          className="font-medium row-link hover:underline"
                        >
                          {employee.name}
                        </Link>
                        <span className="block font-mono text-xs text-muted-foreground">
                          {employee.employeeCode}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {employee.jobTitle ?? '—'}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground lg:table-cell">
                        {employee.branch.name}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground tabular-nums lg:table-cell">
                        {formatDate(employee.hireDate)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {employee._count.jobAssignments}
                      </TableCell>
                      <TableCell>
                        {employee.isActive ? (
                          <StatusPill tone="success">Working</StatusPill>
                        ) : (
                          <StatusPill tone="neutral">Left</StatusPill>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <Pagination info={info} basePath="/hr/employees" params={params} noun="people" />
          </Panel>
        )}
      </Stack>
    </Stack>
  );
}
