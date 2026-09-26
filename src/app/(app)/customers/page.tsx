import Link from 'next/link';
import { UserPlus, Users } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { listCustomers } from '@/lib/customers/service';
import { formatDate } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { SearchField } from '@/components/shared/search-field';
import { ActiveDeletedTabs } from '@/components/shared/active-deleted-tabs';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { importColumns } from '@/lib/data-transfer/imports';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import {
  RecordSelection,
  RemoveCell,
  RemoveHead,
  SelectCell,
  SelectHead,
} from '@/components/shared/record-selection';
import { REMOVAL } from '@/lib/records/removal';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; show?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const query = (params.q ?? '').trim();
  const deleted = params.show === 'deleted';
  const canImport = hasPermission(user, 'customer.create');
  const customers = await listCustomers(user, query, 50, deleted);
  // Nothing on the Deleted tab can be deleted again; it is restored from its page.
  const canRemove = !deleted && hasPermission(user, REMOVAL.customers.permission);
  const rows = customers.map((customer) => ({ id: customer.id, label: customer.name }));

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Customers"
        title="Customers"
        description="Find a customer by name, mobile number, vehicle registration or VIN."
        actions={
          <>
            <ListDataActions
              entity="customers"
              label="customers"
              search={query ? new URLSearchParams({ q: query }).toString() : ''}
              canImport={canImport}
              columns={importColumns('customers')}
            />
            <LinkButton href="/customers/new" size="lg">
              <UserPlus />
              New customer
            </LinkButton>
          </>
        }
      />

      <Stack gap="base">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <SearchField
            initialQuery={query}
            placeholder={deleted ? 'Name or mobile' : 'Name, mobile, registration or VIN'}
            keep={deleted ? { show: 'deleted' } : undefined}
          />
          <ActiveDeletedTabs basePath="/customers" deleted={deleted} query={query} />
        </div>

        {customers.length === 0 ? (
          <EmptyState
            icon={Users}
            title={
              query
                ? `No customer matches “${query}”`
                : deleted
                  ? 'No deleted customers'
                  : 'No customers yet'
            }
            description={
              query
                ? 'Check the spelling, or search by registration or mobile number instead.'
                : 'Customers are added here or during Quick Check-In.'
            }
            action={
              <LinkButton href="/customers/new">
                <UserPlus />
                New customer
              </LinkButton>
            }
          />
        ) : (
          <RecordSelection entity="customers" enabled={canRemove}>
            <Panel padding="none" className="overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <SelectHead rows={rows} />
                    <TableHead>Customer</TableHead>
                    <TableHead>Mobile</TableHead>
                    <TableHead>Vehicles</TableHead>
                    <TableHead>Customer since</TableHead>
                    <RemoveHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customers.map((customer) => (
                    <TableRow key={customer.id} className="relative">
                      <SelectCell id={customer.id} label={customer.name} />
                      <TableCell>
                        <Link
                          href={`/customers/${customer.id}`}
                          className="font-medium after:absolute after:inset-0 hover:underline"
                        >
                          {customer.name}
                        </Link>
                        {customer.email ? (
                          <span className="block text-xs text-muted-foreground">
                            {customer.email}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular-nums">{customer.phone}</TableCell>
                      <TableCell>
                        {customer.vehicles.length === 0 ? (
                          <span className="text-muted-foreground">None yet</span>
                        ) : (
                          <div className="flex flex-wrap gap-2">
                            {customer.vehicles.slice(0, 3).map((vehicle) => (
                              <VehiclePlate
                                key={vehicle.id}
                                plateNumber={vehicle.plateNumber}
                                className="px-2 py-0.5 text-xs"
                              />
                            ))}
                            {customer.vehicles.length > 3 ? (
                              <span className="text-xs text-muted-foreground">
                                +{customer.vehicles.length - 3}
                              </span>
                            ) : null}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(customer.createdAt)}
                      </TableCell>
                      <RemoveCell id={customer.id} label={customer.name} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Panel>
          </RecordSelection>
        )}
      </Stack>
    </Stack>
  );
}
