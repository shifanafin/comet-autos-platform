import Link from 'next/link';
import { FileCheck2, Plus, ShoppingCart } from 'lucide-react';
import { prisma } from '@/lib/prisma';
import type { PurchaseStatus } from '@/generated/prisma/enums';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { canExport } from '@/lib/data-transfer/exports';
import { canImport, importColumns, importNote } from '@/lib/data-transfer/imports';
import { listPurchases } from '@/lib/inventory/purchases';
import { PURCHASE_STATUS_LABEL } from '@/lib/inventory/labels';
import { formatCalendarDate, formatDate, formatMoney } from '@/lib/format';
import { PageHeader, Panel, Stack } from '@/components/layout/primitives';
import { ListDataActions } from '@/components/shared/list-data-actions';
import { EmptyState } from '@/components/shared/empty-state';
import { Pagination } from '@/components/shared/pagination';
import { loadPage, pageFrom } from '@/lib/pagination';
import { LinkButton } from '@/components/shared/link-button';
import { ListFilters } from '@/components/inventory/list-filters';
import { PurchaseStatusPill } from '@/components/inventory/purchase-status';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  RecordSelection,
  RemoveCell,
  RemoveHead,
  SelectCell,
  SelectHead,
} from '@/components/shared/record-selection';
import { REMOVAL } from '@/lib/records/removal';

const STATUSES: PurchaseStatus[] = ['DRAFT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];

export default async function PurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; supplier?: string; page?: string }>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const {
    result: { purchases, suppliers },
    info,
  } = await loadPage(pageFrom(params.page), (skip, take) =>
    listPurchases(
      user,
      { q: params.q, status: params.status, supplierId: params.supplier },
      take,
      skip,
    ),
  );
  const canCreate = hasPermission(user, 'purchase.create');
  // Purchases still waiting for the shop's tax invoice (lib/inventory/bills.ts).
  const awaiting = await prisma.purchase.count({
    where: { organizationId: user.organizationId, billStatus: 'PENDING', status: { not: 'CANCELLED' } },
  });
  const canRemove = hasPermission(user, REMOVAL.purchases.permission);
  // Only a purchase with nothing received yet can be cancelled — the same
  // rule as cancelPurchase; the server checks it again.
  const removable = (purchase: (typeof purchases)[number]) =>
    purchase.status === 'DRAFT' || purchase.status === 'ORDERED';
  const removableRows = purchases
    .filter(removable)
    .map((purchase) => ({ id: purchase.id, label: purchase.purchaseNumber }));
  const filtered = Boolean(params.q || params.status || params.supplier);

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow="Parts & Stock"
        title="Purchases"
        description="Supplier invoices and deliveries. Stock goes up only when a purchase is received."
        actions={
          <>
            <ListDataActions
              entity="purchases"
              canExport={canExport(user, 'purchases')}
              label="purchases"
              canImport={canImport(user, 'purchases')}
              columns={importColumns('purchases')}
              note={importNote('purchases')}
              search={new URLSearchParams(
                Object.entries(params).filter(([, value]) => Boolean(value)) as [string, string][],
              ).toString()}
            />
            <LinkButton href="/inventory/purchases/bills" variant="outline" size="lg">
              <FileCheck2 />
              Bills to match{awaiting ? ` (${awaiting})` : ''}
            </LinkButton>
            {canCreate ? (
              <LinkButton href="/inventory/purchases/new" size="lg">
                <Plus />
                New purchase
              </LinkButton>
            ) : null}
          </>
        }
      />
      <Stack gap="base">
        <ListFilters
          placeholder="PO number, supplier invoice, supplier or part"
          selects={[
            {
              name: 'status',
              label: 'Status',
              options: [
                { value: '', label: 'All statuses' },
                ...STATUSES.map((s) => ({ value: s, label: PURCHASE_STATUS_LABEL[s] })),
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
          ]}
        />
        {purchases.length === 0 ? (
          <EmptyState
            icon={ShoppingCart}
            title={filtered ? 'No purchases match these filters' : 'No purchases yet'}
            description={
              filtered
                ? 'Try another search, or clear the filters.'
                : 'Enter a supplier invoice to receive parts into stock.'
            }
            action={
              canCreate && !filtered ? (
                <LinkButton href="/inventory/purchases/new">
                  <Plus />
                  New purchase
                </LinkButton>
              ) : undefined
            }
          />
        ) : (
          <RecordSelection entity="purchases" enabled={canRemove}>
            <Panel padding="none" className="overflow-hidden">
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader className="bg-muted/40">
                    <TableRow className="hover:bg-transparent">
                      <SelectHead rows={removableRows} />
                      <TableHead>Purchase</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead className="hidden sm:table-cell">Date</TableHead>
                      <TableHead className="hidden text-right md:table-cell">Lines</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead>Status</TableHead>
                      <RemoveHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {purchases.map((purchase) => (
                      <TableRow key={purchase.id} className="relative">
                        <SelectCell
                          id={purchase.id}
                          label={purchase.purchaseNumber}
                          removable={removable(purchase)}
                        />
                        <TableCell>
                          <Link
                            href={`/inventory/purchases/${purchase.id}`}
                            className="font-medium row-link hover:underline"
                          >
                            {purchase.purchaseNumber}
                          </Link>
                          {purchase.supplierInvoiceNumber ? (
                            <span className="block text-xs text-muted-foreground">
                              Inv. {purchase.supplierInvoiceNumber}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>{purchase.supplier.name}</TableCell>
                        <TableCell className="hidden whitespace-nowrap sm:table-cell">
                          {purchase.supplierInvoiceDate
                            ? formatCalendarDate(purchase.supplierInvoiceDate)
                            : formatDate(purchase.createdAt)}
                        </TableCell>
                        <TableCell className="hidden text-right tabular-nums md:table-cell">
                          {purchase._count.items}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {purchase.totalAmount ? formatMoney(purchase.totalAmount) : '—'}
                        </TableCell>
                        <TableCell>
                          <PurchaseStatusPill status={purchase.status} />
                        </TableCell>
                        <RemoveCell
                          id={purchase.id}
                          label={purchase.purchaseNumber}
                          removable={removable(purchase)}
                        />
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination
                info={info}
                basePath="/inventory/purchases"
                params={params}
                noun="purchases"
              />
            </Panel>
          </RecordSelection>
        )}
      </Stack>
    </Stack>
  );
}
