import Link from 'next/link';
import { AlertTriangle, Cog, History, PackageX, Plus } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { listParts, type ActiveFilter, type StockFilter } from '@/lib/inventory/parts';
import { formatMoney } from '@/lib/format';
import { formatMilli, signedToMilli } from '@/lib/money';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { importColumns } from '@/lib/data-transfer/imports';
import { StatusPill } from '@/components/shared/status-pill';
import { ListFilters } from '@/components/inventory/list-filters';
import { StockPill, StockQuantity } from '@/components/inventory/stock-level';
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

type Search = { q?: string; category?: string; supplier?: string; stock?: string; status?: string };

export default async function PartsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser();
  const params = await searchParams;
  const stock = (
    ['low', 'out', 'in'].includes(params.stock ?? '') ? params.stock : ''
  ) as StockFilter;
  const status = (
    ['inactive', 'all'].includes(params.status ?? '') ? params.status : 'active'
  ) as ActiveFilter;
  const { branch, parts, summary, categories, suppliers } = await listParts(user, {
    q: params.q,
    category: params.category,
    supplierId: params.supplier,
    stock,
    status,
  });
  const canManage = hasPermission(user, 'inventory.manage');
  const canRemove = hasPermission(user, REMOVAL.parts.permission);
  // Stock on hand would vanish from the count, so only an active part with
  // none here is offered. The server also checks other branches and open
  // purchases.
  const removable = (part: (typeof parts)[number]) => part.isActive && part.onHandMilli === 0;
  const removableRows = parts.filter(removable).map((part) => ({ id: part.id, label: part.name }));
  const filtered = Boolean(
    params.q || params.category || params.supplier || stock || status !== 'active',
  );

  const chip = (
    value: StockFilter,
    label: string,
    count: number,
    tone: string,
    Icon: typeof AlertTriangle,
  ) => {
    const next = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v) as [string, string][],
    );
    if (stock === value) next.delete('stock');
    else next.set('stock', value);
    return (
      <Link
        href={`/inventory/parts${next.size ? `?${next}` : ''}`}
        className={cn(
          'flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-xs transition-colors hover:bg-muted/40',
          stock === value ? 'border-primary ring-2 ring-primary/20' : 'border-border',
        )}
      >
        <span className={cn('flex size-9 items-center justify-center rounded-full', tone)}>
          <Icon className="size-[18px]" />
        </span>
        <span className="flex flex-col">
          <span className="text-xl font-semibold tabular-nums">{count}</span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </span>
      </Link>
    );
  };

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Inventory"
        title="Parts"
        description={`Stock on hand at ${branch.name}. Every change is recorded in the stock history.`}
        actions={
          <>
            <ListDataActions
              entity="parts"
              label="parts"
              search={new URLSearchParams(
                Object.entries(params).filter(([, value]) => Boolean(value)) as [string, string][],
              ).toString()}
              canImport={canManage}
              columns={importColumns('parts')}
            />
            <LinkButton href="/inventory/movements" variant="outline" size="lg">
              <History />
              Stock movements
            </LinkButton>
            {canManage ? (
              <LinkButton href="/inventory/parts/new" size="lg">
                <Plus />
                New part
              </LinkButton>
            ) : null}
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:max-w-2xl">
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-xs">
          <span className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Cog className="size-[18px]" />
          </span>
          <span className="flex flex-col">
            <span className="text-xl font-semibold tabular-nums">{summary.active}</span>
            <span className="text-xs text-muted-foreground">Active parts</span>
          </span>
        </div>
        {chip('low', 'Low stock', summary.low, 'bg-warning/10 text-warning', AlertTriangle)}
        {chip('out', 'Out of stock', summary.out, 'bg-danger/10 text-danger', PackageX)}
      </div>

      <Stack gap="base">
        <ListFilters
          placeholder="Search SKU, name or category"
          selects={[
            {
              name: 'category',
              label: 'Category',
              options: [
                { value: '', label: 'All categories' },
                ...categories.map((c) => ({ value: c, label: c })),
              ],
            },
            {
              name: 'supplier',
              label: 'Supplier',
              options: [
                { value: '', label: 'All suppliers' },
                ...suppliers.map((s) => ({ value: s.id, label: s.name })),
              ],
            },
            {
              name: 'stock',
              label: 'Stock',
              options: [
                { value: '', label: 'Any stock level' },
                { value: 'in', label: 'In stock' },
                { value: 'low', label: 'Low stock' },
                { value: 'out', label: 'Out of stock' },
              ],
            },
            {
              name: 'status',
              label: 'Status',
              options: [
                { value: '', label: 'Active' },
                { value: 'inactive', label: 'Inactive' },
                { value: 'all', label: 'Active & inactive' },
              ],
            },
          ]}
        />

        {parts.length === 0 ? (
          <EmptyState
            icon={Cog}
            title={filtered ? 'No parts match these filters' : 'No parts in the catalogue yet'}
            description={
              filtered
                ? 'Try another search, or clear the filters.'
                : 'Add the parts you stock, with their opening quantity.'
            }
            action={
              canManage && !filtered ? (
                <LinkButton href="/inventory/parts/new">
                  <Plus />
                  New part
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <RecordSelection entity="parts" enabled={canRemove}>
            <Panel padding="none" className="overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <SelectHead rows={removableRows} />
                      <TableHead>Part</TableHead>
                      <TableHead className="hidden md:table-cell">Category</TableHead>
                      <TableHead className="hidden lg:table-cell">Supplier</TableHead>
                      <TableHead className="text-right">On hand</TableHead>
                      <TableHead className="hidden text-right sm:table-cell">Min.</TableHead>
                      <TableHead className="hidden text-right lg:table-cell">Cost</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <RemoveHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {parts.map((part) => (
                      <TableRow
                        key={part.id}
                        className={cn('relative', !part.isActive && 'text-muted-foreground')}
                      >
                        <SelectCell id={part.id} label={part.name} removable={removable(part)} />
                        <TableCell>
                          <Link
                            href={`/inventory/parts/${part.id}`}
                            className="font-medium after:absolute after:inset-0 hover:underline"
                          >
                            {part.name}
                          </Link>
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-mono text-xs text-muted-foreground">
                              {part.sku}
                            </span>
                            {!part.isActive ? (
                              <StatusPill tone="neutral">Inactive</StatusPill>
                            ) : null}
                          </span>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          {part.category ?? <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell">
                          {part.preferredSupplier?.name ?? (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex flex-col items-end gap-1">
                            <StockQuantity
                              onHandMilli={part.onHandMilli}
                              unit={part.unitOfMeasure}
                              state={part.state}
                            />
                            {part.state !== 'IN_STOCK' ? <StockPill state={part.state} /> : null}
                          </div>
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums sm:table-cell">
                          {part.reorderLevel ? formatMilli(signedToMilli(part.reorderLevel)) : '—'}
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums lg:table-cell">
                          {part.defaultCostPrice ? formatMoney(part.defaultCostPrice) : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {part.defaultSellingPrice ? formatMoney(part.defaultSellingPrice) : '—'}
                        </TableCell>
                        <RemoveCell id={part.id} label={part.name} removable={removable(part)} />
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
