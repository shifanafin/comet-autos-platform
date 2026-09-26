import Link from 'next/link';
import { Plus, Truck } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { listSuppliers } from '@/lib/inventory/suppliers';
import { formatDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { importColumns } from '@/lib/data-transfer/imports';
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
import { cn } from '@/lib/utils';
import {
  RecordSelection,
  RemoveCell,
  RemoveHead,
  SelectCell,
  SelectHead,
} from '@/components/shared/record-selection';
import { REMOVAL } from '@/lib/records/removal';

export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const user = await requireUser();
  const query = ((await searchParams).q ?? '').trim();
  const suppliers = await listSuppliers(user, query);
  const canManage = hasPermission(user, 'inventory.manage');
  const canRemove = hasPermission(user, REMOVAL.suppliers.permission);
  // Money still owed would drop out of Payables, so only an active supplier
  // owed nothing is offered. The server also checks open purchases.
  const removable = (supplier: (typeof suppliers)[number]) =>
    supplier.isActive && supplier.balance.outstanding === '0.00';
  const removableRows = suppliers
    .filter(removable)
    .map((supplier) => ({ id: supplier.id, label: supplier.name }));

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Inventory"
        title="Suppliers"
        description="Who you buy parts from, what has been received from them and what is still owed."
        actions={
          <>
            <ListDataActions
              entity="suppliers"
              label="suppliers"
              search={query ? new URLSearchParams({ q: query }).toString() : ''}
              canImport={canManage}
              columns={importColumns('suppliers')}
            />
            {canManage ? (
              <LinkButton href="/inventory/suppliers/new" size="lg">
                <Plus />
                New supplier
              </LinkButton>
            ) : null}
          </>
        }
      />
      <Stack gap="base">
        <SearchField initialQuery={query} placeholder="Name, contact, phone or email" />
        {suppliers.length === 0 ? (
          <EmptyState
            icon={Truck}
            title={query ? `No supplier matches “${query}”` : 'No suppliers yet'}
            description={
              query
                ? 'Check the spelling or search by phone.'
                : 'Add the suppliers you buy parts from.'
            }
            action={
              canManage && !query ? (
                <LinkButton href="/inventory/suppliers/new">
                  <Plus />
                  New supplier
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <RecordSelection entity="suppliers" enabled={canRemove}>
            <Panel padding="none" className="overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <SelectHead rows={removableRows} />
                      <TableHead>Supplier</TableHead>
                      <TableHead className="hidden sm:table-cell">Contact</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Parts</TableHead>
                      <TableHead className="hidden md:table-cell">Last purchase</TableHead>
                      <TableHead className="text-right">Outstanding</TableHead>
                      <RemoveHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {suppliers.map((supplier) => (
                      <TableRow
                        key={supplier.id}
                        className={cn('relative', !supplier.isActive && 'text-muted-foreground')}
                      >
                        <SelectCell
                          id={supplier.id}
                          label={supplier.name}
                          removable={removable(supplier)}
                        />
                        <TableCell>
                          <Link
                            href={`/inventory/suppliers/${supplier.id}`}
                            className="font-medium after:absolute after:inset-0 hover:underline"
                          >
                            {supplier.name}
                          </Link>
                          {!supplier.isActive ? (
                            <StatusPill tone="neutral" className="ml-2">
                              Inactive
                            </StatusPill>
                          ) : null}
                          {supplier.phone ? (
                            <span className="block text-xs text-muted-foreground tabular-nums sm:hidden">
                              {supplier.phone}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {supplier.contactName ?? '—'}
                          {supplier.phone ? (
                            <span className="block text-xs text-muted-foreground tabular-nums">
                              {supplier.phone}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">
                          {supplier._count.parts}
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {supplier.lastPurchaseAt ? (
                            formatDate(supplier.lastPurchaseAt)
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'text-right font-medium tabular-nums',
                            supplier.balance.outstanding === '0.00' && 'text-muted-foreground',
                          )}
                        >
                          {formatMoney(supplier.balance.outstanding)}
                        </TableCell>
                        <RemoveCell
                          id={supplier.id}
                          label={supplier.name}
                          removable={removable(supplier)}
                        />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </Panel>
          </RecordSelection>
        )}
      </Stack>
    </Stack>
  );
}
