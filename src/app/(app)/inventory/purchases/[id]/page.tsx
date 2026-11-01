import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PackageCheck, Pencil } from 'lucide-react';
import { requireUser, hasPermission } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { canPayOnReceipt, getPurchaseDetail } from '@/lib/inventory/purchases';
import { getPaymentModeOptions } from '@/lib/accounting/payment-modes';
import { getAccountChoices } from '@/lib/accounting/reports';
import { PAYMENT_METHOD_LABEL } from '@/lib/documents/build';
import { formatCalendarDate, formatDateTime, formatMoney, localDateString } from '@/lib/format';
import { formatMilli, signedToMilli, toFils } from '@/lib/money';
import { Grid, PageHeader, Panel, Section, Stack } from '@/components/layout/primitives';
import { EmptyState } from '@/components/shared/empty-state';
import { LinkButton } from '@/components/shared/link-button';
import { StatusPill } from '@/components/shared/status-pill';
import { PurchaseStatusPill } from '@/components/inventory/purchase-status';
import { CancelPurchaseButton, ReceivePurchaseForm } from '@/components/inventory/stock-actions';
import { EditPurchaseDetailsButton } from '@/components/inventory/purchase-details-form';
import { ExpenseBills } from '@/components/finance/expense-bills';
import { listAttachments } from '@/lib/documents/attachments';
import { removePurchaseBillAction } from '../../actions';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default async function PurchaseDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  let detail;
  try {
    detail = await getPurchaseDetail(user, id);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const {
    purchase,
    lines,
    receivedValue,
    receipts,
    paid,
    owed,
    linesGross,
    discountTotal,
    billDifference,
    billDifferenceSign,
  } = detail;
  const hasDiscount = toFils(discountTotal) > 0;
  const billDiscount = toFils(purchase.billDiscountAmount.toString());
  // A reversal and the payment it reversed are not payments.
  const reversed = new Set(
    purchase.supplierPayments.map((payment) => payment.reversalOfSupplierPaymentId).filter(Boolean),
  );
  const payments = purchase.supplierPayments.filter(
    (payment) => !payment.reversalOfSupplierPaymentId,
  );
  const bills = (await listAttachments(user, 'Purchase', [purchase.id])).get(purchase.id) ?? [];
  const receivable = ['DRAFT', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(purchase.status);
  const canReceive =
    receivable && hasPermission(user, 'purchase.approve', { branchId: purchase.branchId });
  const nothingReceived = lines.every((line) => line.receivedMilli === 0);
  const canEdit =
    purchase.status === 'DRAFT' &&
    hasPermission(user, 'purchase.edit', { branchId: purchase.branchId });
  // Past draft, only the details can change — never the lines or amounts.
  const canEditDetails =
    purchase.status !== 'DRAFT' &&
    purchase.status !== 'CANCELLED' &&
    hasPermission(user, 'purchase.edit', { branchId: purchase.branchId });
  const canCancel =
    purchase.status === 'DRAFT' &&
    hasPermission(user, 'purchase.delete', { branchId: purchase.branchId });
  const canPay = canReceive && canPayOnReceipt(user);
  const [modes, accounts] = canPay
    ? await Promise.all([
        getPaymentModeOptions(user.organizationId, 'spending'),
        getAccountChoices(user),
      ])
    : [[], null];

  return (
    <Stack gap="2xl" className="animate-in fade-in duration-300">
      <PageHeader
        eyebrow={
          <Link
            href="/inventory/purchases"
            className="tracking-normal normal-case hover:text-foreground"
          >
            Purchases
          </Link>
        }
        title={
          <>
            {purchase.purchaseNumber}
            <PurchaseStatusPill status={purchase.status} />
          </>
        }
        description={
          <>
            <Link
              href={`/inventory/suppliers/${purchase.supplier.id}`}
              className="font-medium text-foreground hover:underline"
            >
              {purchase.supplier.name}
            </Link>
            {purchase.supplierInvoiceNumber
              ? ` · supplier invoice ${purchase.supplierInvoiceNumber}`
              : ''}
            {purchase.supplierInvoiceDate
              ? ` · ${formatCalendarDate(purchase.supplierInvoiceDate)}`
              : ''}
            {purchase.dueDate ? ` · due ${formatCalendarDate(purchase.dueDate)}` : ''}
          </>
        }
        actions={
          <>
            {canEdit ? (
              <LinkButton
                href={`/inventory/purchases/${purchase.id}/edit`}
                variant="outline"
                size="lg"
              >
                <Pencil />
                Edit draft
              </LinkButton>
            ) : null}
            {canEditDetails ? (
              <EditPurchaseDetailsButton
                today={localDateString()}
                purchase={{
                  id: purchase.id,
                  purchaseNumber: purchase.purchaseNumber,
                  supplierInvoiceNumber: purchase.supplierInvoiceNumber,
                  supplierInvoiceDate:
                    purchase.supplierInvoiceDate?.toISOString().slice(0, 10) ?? null,
                  dueDate: purchase.dueDate?.toISOString().slice(0, 10) ?? null,
                  notes: purchase.notes,
                  receivedOn: purchase.receivedAt ? localDateString(purchase.receivedAt) : null,
                }}
              />
            ) : null}
            {canCancel && nothingReceived ? (
              <CancelPurchaseButton
                purchaseId={purchase.id}
                purchaseNumber={purchase.purchaseNumber}
              />
            ) : null}
          </>
        }
      />
      {purchase.billStatus === 'PENDING' && purchase.status !== 'CANCELLED' ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-sm sm:px-5">
          <span>
            <span className="font-medium">The shop&apos;s tax invoice is awaited.</span>{' '}
            <span className="text-muted-foreground">
              Its VAT ({formatMoney(purchase.taxAmount?.toString() ?? '0')}) can&apos;t be claimed until
              the bill is matched.
            </span>
          </span>
          <LinkButton href={`/inventory/purchases/${purchase.id}/match`} variant="outline">
            Match tax invoice
          </LinkButton>
        </div>
      ) : purchase.billStatus === 'NO_TAX_INVOICE' ? (
        <p className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground sm:px-5">
          No tax invoice from the shop{purchase.billNote ? ` — ${purchase.billNote}` : ''}. Its VAT is part of the cost.
        </p>
      ) : purchase.billMatchedByUserId && purchase.billReceivedOn ? (
        <p className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground sm:px-5">
          Tax invoice matched after the parts arrived; its VAT is claimed from{' '}
          {formatCalendarDate(purchase.billReceivedOn)}.
          {billDifferenceSign !== 0
            ? ` Corrected to the bill: ${formatMoney(billDifference)} ${billDifferenceSign > 0 ? 'more' : 'less'} than recorded${purchase.billNote ? ` — ${purchase.billNote}` : ''}.`
            : ''}
        </p>
      ) : null}

      <Grid className="sm:grid-cols-3">
        <Panel>
          <p className="text-sm text-muted-foreground">Purchase total</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">
            {purchase.totalAmount ? formatMoney(purchase.totalAmount) : '—'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatMoney(purchase.subtotal ?? 0)} + VAT {formatMoney(purchase.taxAmount ?? 0)}
            {hasDiscount ? ` · after ${formatMoney(discountTotal)} discount` : ''}
          </p>
        </Panel>
        <Panel>
          <p className="text-sm text-muted-foreground">Still owed to the supplier</p>
          <p className="mt-2 text-2xl font-semibold tabular-nums">{formatMoney(owed)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatMoney(receivedValue)} received (cost + VAT) · {formatMoney(paid)} paid
            {purchase.dueDate && toFils(owed) > 0
              ? ` · due ${formatCalendarDate(purchase.dueDate)}`
              : ''}
          </p>
        </Panel>
        <Panel>
          <p className="text-sm text-muted-foreground">Entered</p>
          <p className="mt-2 text-sm">
            {formatDateTime(purchase.createdAt)} by {purchase.createdBy.fullName}
          </p>
          {purchase.receivedAt ? (
            <p className="mt-1 text-sm text-muted-foreground">
              Last received {formatDateTime(purchase.receivedAt)}
              {purchase.receivedBy ? ` by ${purchase.receivedBy.fullName}` : ''}
            </p>
          ) : null}
        </Panel>
      </Grid>

      <Panel className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <p className="text-sm font-medium">Supplier’s bill</p>
        <ExpenseBills
          expenseId={purchase.id}
          bills={bills}
          basePath="/inventory/purchases"
          removeAction={removePurchaseBillAction}
          canAttach={hasPermission(user, 'purchase.create')}
          canRemove={hasPermission(user, 'purchase.edit')}
        />
      </Panel>

      {canReceive ? (
        <Section
          title="Receive stock"
          description="Check the quantities against what actually arrived. Anything not received now stays open on the purchase."
        >
          <Panel className="max-w-4xl">
            <ReceivePurchaseForm
              // Remount after each receipt so every line defaults to what is still outstanding.
              key={lines.map((line) => line.receivedMilli).join(':')}
              purchaseId={purchase.id}
              receipt={{
                modes,
                moneyAccounts: accounts?.money ?? [],
                canPay,
                canUpdateCost: hasPermission(user, 'inventory.create'),
              }}
              lines={lines.map((line) => ({
                id: line.id,
                sku: line.part.sku,
                name: line.part.name,
                unit: line.part.unitOfMeasure,
                orderedMilli: line.orderedMilli,
                receivedMilli: line.receivedMilli,
                outstandingMilli: line.outstandingMilli,
              }))}
            />
          </Panel>
        </Section>
      ) : null}

      <Section title="Lines">
        <Panel padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader className="bg-muted/40">
                <TableRow className="hover:bg-transparent">
                  <TableHead>Part</TableHead>
                  <TableHead className="text-right">Ordered</TableHead>
                  <TableHead className="text-right">Received</TableHead>
                  <TableHead className="text-right">Unit cost</TableHead>
                  {hasDiscount ? <TableHead className="text-right">Discount</TableHead> : null}
                  <TableHead className="text-right">VAT</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>
                      <Link
                        href={`/inventory/parts/${line.part.id}`}
                        className="font-medium hover:underline"
                      >
                        {line.part.name}
                      </Link>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {line.part.sku}
                      </span>
                      {line.costDiffers ? (
                        <span className="text-xs text-warning">
                          Catalogue cost is {formatMoney(line.part.defaultCostPrice!)} — not changed
                          by this purchase
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMilli(line.orderedMilli)} {line.part.unitOfMeasure}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="tabular-nums">{formatMilli(line.receivedMilli)}</span>
                      {line.outstandingMilli > 0 && line.receivedMilli > 0 ? (
                        <StatusPill tone="warning" className="ml-2">
                          {formatMilli(line.outstandingMilli)} to come
                        </StatusPill>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(line.unitCost)}
                    </TableCell>
                    {hasDiscount ? (
                      <TableCell className="text-right tabular-nums">
                        {toFils(line.amounts.discountAmount) > 0
                          ? `−${formatMoney(line.amounts.discountAmount)}`
                          : '—'}
                        {line.amounts.discountType === 'PERCENT' && line.amounts.discountValue ? (
                          <span className="block text-xs text-muted-foreground">
                            {`${Number(line.amounts.discountValue)}%`}
                          </span>
                        ) : null}
                      </TableCell>
                    ) : null}
                    <TableCell className="text-right tabular-nums">
                      {line.amounts.taxAmount}{' '}
                      <span className="text-xs text-muted-foreground">
                        ({Number(line.taxRate)}%)
                      </span>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {formatMoney(line.amounts.net)}
                      {billDiscount > 0 && line.amounts.net !== line.amounts.lineTotal ? (
                        <span className="block text-xs font-normal text-muted-foreground">
                          after its share of the bill discount
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <dl className="ml-auto grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 border-t border-border p-4 text-sm sm:p-6">
            {hasDiscount ? (
              <>
                <dt className="text-muted-foreground">Lines subtotal</dt>
                <dd className="text-right tabular-nums">{formatMoney(linesGross)}</dd>
                <dt className="text-muted-foreground">
                  Discount
                  {billDiscount > 0
                    ? ` (incl. ${formatMoney(purchase.billDiscountAmount)} on the whole bill${purchase.billDiscountType === 'PERCENT' && purchase.billDiscountValue ? `, ${Number(purchase.billDiscountValue)}%` : ''})`
                    : ''}
                </dt>
                <dd className="text-right tabular-nums">−{formatMoney(discountTotal)}</dd>
              </>
            ) : null}
            <dt className="text-muted-foreground">
              {hasDiscount ? 'Subtotal after discount' : 'Subtotal'}
            </dt>
            <dd className="text-right tabular-nums">{formatMoney(purchase.subtotal ?? 0)}</dd>
            <dt className="text-muted-foreground">VAT</dt>
            <dd className="text-right tabular-nums">{formatMoney(purchase.taxAmount ?? 0)}</dd>
            {purchase.roundingAdjustment.isZero() ? null : (
              <>
                <dt className="text-muted-foreground">Adjustment (round-off)</dt>
                <dd className="text-right tabular-nums">
                  {formatMoney(purchase.roundingAdjustment.toFixed(2))}
                </dd>
              </>
            )}
            <dt className="font-semibold">Total</dt>
            <dd className="text-right font-semibold tabular-nums">
              {formatMoney(purchase.totalAmount ?? 0)}
            </dd>
            {toFils(paid) > 0 ? (
              <>
                <dt className="text-muted-foreground">Paid</dt>
                <dd className="text-right tabular-nums">−{formatMoney(paid)}</dd>
                <dt className="font-semibold">Still owed</dt>
                <dd className="text-right font-semibold tabular-nums">{formatMoney(owed)}</dd>
              </>
            ) : null}
          </dl>
          {hasDiscount ? (
            <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
              The supplier’s discount lowers what these parts cost and the VAT claimed back. Stock
              is valued at the cost after discount.
            </p>
          ) : null}
        </Panel>
      </Section>

      {payments.length > 0 && hasPermission(user, 'supplier_payment.view') ? (
        <Section
          title="Payments to the supplier"
          description="Money paid against this purchase, whether as the goods arrived or later from Suppliers owed."
        >
          <Panel padding="none">
            <ul className="divide-y divide-border">
              {payments.map((payment) => {
                const isReversed = reversed.has(payment.id) || payment.status !== 'COMPLETED';
                return (
                  <li
                    key={payment.id}
                    className="flex flex-col gap-0.5 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6"
                  >
                    <span
                      className={isReversed ? 'text-muted-foreground line-through' : 'font-medium'}
                    >
                      {`${formatMoney(payment.amount.toString())} · ${PAYMENT_METHOD_LABEL[payment.method]}`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {`${payment.supplierPaymentNumber ?? ''} · ${formatDateTime(payment.paidAt)} · ${payment.paidBy.fullName}${payment.referenceNumber ? ` · ref ${payment.referenceNumber}` : ''}${isReversed ? ' · reversed' : ''}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Panel>
        </Section>
      ) : null}

      <Section
        title="Stock received"
        description="The stock-history entries this purchase created."
      >
        {receipts.length === 0 ? (
          <EmptyState
            variant="inline"
            icon={PackageCheck}
            title="Nothing received yet"
            description="Stock doesn't change until the purchase is received."
          />
        ) : (
          <Panel padding="none" className="overflow-hidden">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableHead>When</TableHead>
                    <TableHead>Part</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead>By</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {receipts.map((receipt) => (
                    <TableRow key={receipt.id}>
                      <TableCell className="whitespace-nowrap tabular-nums">
                        {formatDateTime(receipt.createdAt)}
                      </TableCell>
                      <TableCell>
                        {receipt.name}{' '}
                        <span className="font-mono text-xs text-muted-foreground">
                          {receipt.sku}
                        </span>
                      </TableCell>
                      <TableCell className="text-right font-semibold text-success tabular-nums">
                        +{formatMilli(signedToMilli(receipt.quantity))}
                      </TableCell>
                      <TableCell>{receipt.performedBy?.fullName ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Panel>
        )}
      </Section>

      {purchase.notes ? (
        <Section title="Notes">
          <p className="text-sm whitespace-pre-line">{purchase.notes}</p>
        </Section>
      ) : null}
    </Stack>
  );
}
