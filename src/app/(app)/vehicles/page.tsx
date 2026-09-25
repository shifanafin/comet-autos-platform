import Link from 'next/link';
import { Car, UserPlus } from 'lucide-react';
import { hasPermission, requireUser } from '@/lib/auth/authorize';
import { listVehicles } from '@/lib/vehicles/service';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { SearchField } from '@/components/shared/search-field';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { importColumns } from '@/lib/data-transfer/imports';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export default async function VehiclesPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const user = await requireUser();
  const query = ((await searchParams).q ?? '').trim();
  const canImport = hasPermission(user, 'vehicle.create');
  const vehicles = await listVehicles(user, query);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Customers"
        title="Vehicles"
        description="Search by registration, VIN, or the owner's name or mobile number."
        actions={
          <>
            <ListDataActions
              entity="vehicles"
              label="vehicles"
              search={query ? new URLSearchParams({ q: query }).toString() : ''}
              canImport={canImport}
              columns={importColumns('vehicles')}
            />
            <LinkButton href="/customers/new" size="lg" variant="outline">
              <UserPlus />
              New customer &amp; vehicle
            </LinkButton>
          </>
        }
      />
      <Stack gap="base">
        <SearchField initialQuery={query} placeholder="Registration, VIN, owner or mobile" />
        {vehicles.length === 0 ? (
          <EmptyState
            icon={Car}
            title={query ? `No vehicle matches “${query}”` : 'No vehicles yet'}
            description="Vehicles are added from a customer's page or during Quick Check-In."
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Registration</TableHead>
                  <TableHead>Vehicle</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>VIN</TableHead>
                  <TableHead className="text-right">Last mileage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {vehicles.map((vehicle) => (
                  <TableRow key={vehicle.id} className="relative">
                    <TableCell>
                      <Link href={`/vehicles/${vehicle.id}`} className="after:absolute after:inset-0">
                        <VehiclePlate plateNumber={vehicle.plateNumber} className="px-2 py-0.5 text-xs" />
                      </Link>
                    </TableCell>
                    <TableCell className="font-medium">
                      {vehicle.make} {vehicle.model} {vehicle.year ?? ''}
                    </TableCell>
                    <TableCell>
                      {vehicle.customer.name}
                      <span className="block text-xs text-muted-foreground">{vehicle.customer.phone}</span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{vehicle.vin ?? '—'}</TableCell>
                    <TableCell className="text-right text-muted-foreground tabular-nums">
                      {vehicle.lastMileage !== null ? `${vehicle.lastMileage.toLocaleString('en-AE')} km` : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Panel>
        )}
      </Stack>
    </Stack>
  );
}
