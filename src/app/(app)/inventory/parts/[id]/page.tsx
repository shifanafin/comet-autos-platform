import Link from 'next/link';
import { notFound } from 'next/navigation';
import { History, Pencil, ShoppingCart } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getPartDetail } from '@/lib/inventory/parts';
import { formatCalendarDate, formatDate, formatMoney } from '@/lib/format';
import { formatMilli, signedToMilli } from '@/lib/money';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { MovementTable } from '@/components/inventory/movement-table';
import { AdjustStockForm } from '@/components/inventory/stock-actions';
import { ConvertPartUnitButton } from '@/components/inventory/convert-part-unit';
import { PurchaseStatusPill } from '@/components/inventory/purchase-status';
import { StockPill, StockQuantity } from '@/components/inventory/stock-level';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default async function PartDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let detail;
  try {
    detail = await getPartDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const {
    part,
    branch,
    onHandMilli,
    state,
    history,
    purchaseLines,
    lastPurchaseCost,
    usedOnJobsMilli,
  } = detail;
  const canManage = hasPermission(user, 'inventory.create');
  const canAdjust = hasPermission(user, 'inventory.approve', { branchId: branch.id });
  const canPurchase = hasPermission(user, 'purchase.create', { branchId: branch.id });
  const unit = part.unitOfMeasure;

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link
            href="/inventory/parts"
            className="tracking-normal normal-case hover:text-foreground"
          >
            Parts
          </Link>
        }
        title={
          <>
            {part.name}
            {!part.isActive ? <StatusPill tone="neutral">Inactive</StatusPill> : null}
          </>
        }
        description={
          <>
            <span className="font-mono">{part.sku}</span>
            {part.category ? ` · ${part.category}` : ''}
            {part.description ? ` · ${part.description}` : ''}
          </>
        }
        actions={
          <>
            {canAdjust && ['piece', 'bottle', 'box'].includes(unit) ? (
              <ConvertPartUnitButton
                partId={part.id}
                unit={unit}
                onHandMilli={onHandMilli}
                cost={part.defaultCostPrice?.toString() ?? null}
                selling={part.defaultSellingPrice?.toString() ?? null}
              />
            ) : null}
            {canPurchase && part.isActive ? (
              <LinkButton href="/inventory/purchases/new" variant="outline" size="lg">
                <ShoppingCart />
                Receive stock
              </LinkButton>
            ) : null}
            {canManage ? (
              <LinkButton href={`/inventory/parts/${part.id}/edit`} variant="outline" size="lg">
                <Pencil />
                Edit part
              </LinkButton>
            ) : null}
          </>
        }
      />

      <Grid className="lg:grid-cols-3">
        <Panel className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-muted-foreground">On hand · {branch.name}</p>
            <StockPill state={state} />
          </div>
          <StockQuantity onHandMilli={onHandMilli} unit={unit} state={state} size="lg" />
          <dl className="grid grid-cols-2 gap-y-2 border-t border-border pt-4 text-sm">
            <dt className="text-muted-foreground">Minimum stock</dt>
            <dd className="text-right tabular-nums">
              {part.reorderLevel
                ? `${formatMilli(signedToMilli(part.reorderLevel))} ${unit}`
                : 'Not set'}
            </dd>
            <dt className="text-muted-foreground">Used on jobs (net)</dt>
            <dd className="text-right tabular-nums">
              {formatMilli(usedOnJobsMilli)} {unit}
            </dd>
          </dl>
        </Panel>
        <Panel className="flex flex-col gap-4">
          <p className="text-sm font-medium text-muted-foreground">Pricing</p>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Selling price</dt>
            <dd className="text-right text-base font-semibold tabular-nums">
              {part.defaultSellingPrice ? formatMoney(part.defaultSellingPrice) : '—'}
            </dd>
            <dt className="text-muted-foreground">Cost price</dt>
            <dd className="text-right tabular-nums">
              {part.defaultCostPrice ? formatMoney(part.defaultCostPrice) : '—'}
            </dd>
            <dt className="text-muted-foreground">Last purchase cost</dt>
            <dd className="text-right tabular-nums">
              {lastPurchaseCost ? formatMoney(lastPurchaseCost) : '—'}
            </dd>
            <dt className="text-muted-foreground">VAT</dt>
            <dd className="text-right tabular-nums">
              {part.defaultTaxRate ? `${part.defaultTaxRate.toString()}%` : '—'}
            </dd>
          </dl>
        </Panel>
        <Panel className="flex flex-col gap-4">
          <p className="text-sm font-medium text-muted-foreground">Supplier</p>
          {part.preferredSupplier ? (
            <div className="flex flex-col gap-1 text-sm">
              <Link
                href={`/inventory/suppliers/${part.preferredSupplier.id}`}
                className="text-base font-semibold hover:underline"
              >
                {part.preferredSupplier.name}
              </Link>
              {part.preferredSupplier.phone ? (
                <span className="text-muted-foreground tabular-nums">
                  {part.preferredSupplier.phone}
                </span>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No preferred supplier.</p>
          )}
          <p className="mt-auto text-xs text-muted-foreground">Unit: {unit}</p>
        </Panel>
      </Grid>

      {canAdjust ? (
        <Section
          title="Adjust stock"
          description="For counts, damage or loss. Purchases and job usage are recorded from their own screens."
        >
          <Panel className="max-w-3xl">
            <AdjustStockForm partId={part.id} unit={unit} onHandMilli={onHandMilli} />
          </Panel>
        </Section>
      ) : null}

      <Section
        title="Stock history"
        description="Every movement, newest first, with the running balance. Entries are never edited — mistakes are reversed."
        action={
          <Link
            href="/inventory/movements"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <History className="size-4" />
            All movements
          </Link>
        }
      >
        {history.length === 0 ? (
          <EmptyState
            icon={History}
            title="No stock movements yet"
            description="Receive a purchase or adjust the stock to start the history."
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <MovementTable
              movements={history}
              showBalance
              unit={` ${unit}`}
              canReverse={canAdjust}
            />
          </Panel>
        )}
      </Section>

      <Section title="Purchase history" description="Recent purchases of this part.">
        {purchaseLines.length === 0 ? (
          <EmptyState variant="inline" icon={ShoppingCart} title="Not purchased yet" />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Purchase</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {purchaseLines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell>
                        <Link
                          href={`/inventory/purchases/${line.purchase.id}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {line.purchase.purchaseNumber}
                        </Link>
                        {line.purchase.supplierInvoiceNumber ? (
                          <span className="block text-xs text-muted-foreground">
                            Inv. {line.purchase.supplierInvoiceNumber}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>{line.purchase.supplier.name}</TableCell>
                      <TableCell className="whitespace-nowrap">
                        {line.purchase.supplierInvoiceDate
                          ? formatCalendarDate(line.purchase.supplierInvoiceDate)
                          : formatDate(line.purchase.orderedAt)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMilli(signedToMilli(line.quantityReceived))} /{' '}
                        {formatMilli(signedToMilli(line.quantityOrdered))}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(line.unitCost)}
                      </TableCell>
                      <TableCell>
                        <PurchaseStatusPill status={line.purchase.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Panel>
        )}
      </Section>
    </Stack>
  );
}
