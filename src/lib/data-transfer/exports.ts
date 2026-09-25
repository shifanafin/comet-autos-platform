import type { AuthenticatedUser } from '@/lib/auth/session';
import { NotFoundError } from '@/lib/errors';
import { formatMilli } from '@/lib/money';
import { listCustomers } from '@/lib/customers/service';
import { listVehicles } from '@/lib/vehicles/service';
import { listParts, listMovements } from '@/lib/inventory/parts';
import { listSuppliers } from '@/lib/inventory/suppliers';
import { listPurchases } from '@/lib/inventory/purchases';
import { listInvoices, listPayments } from '@/lib/billing/lists';
import { listQuotations } from '@/lib/workshop/quotations';
import { listJobCards } from '@/lib/workshop/job-card-list';
import { JOB_STATUS_LABEL } from '@/lib/workshop/stages';
import { ESTIMATE_STATUS_LABEL } from '@/lib/workshop/labels';
import { toCsv, type CsvColumn } from '@/lib/data-transfer/csv';

/*
 * Every list, as a spreadsheet.
 *
 * Each export runs the same service the screen runs, with the same search
 * and filters, so what downloads is what was on screen — only without the
 * page limit. Permissions are the service's own: someone who cannot see a
 * list cannot export it either.
 *
 * Amounts are written as plain decimal strings ("1250.00") so a spreadsheet
 * reads them as numbers; dates as ISO so they sort.
 */

/** The most rows one download will produce, so a huge table can't exhaust memory. */
export const EXPORT_LIMIT = 20000;

export interface ExportFilters {
  q?: string;
  status?: string;
  stock?: string;
  category?: string;
  supplierId?: string;
  partId?: string;
  type?: string;
}

interface ExportDefinition<Row> {
  /** Shown in the file name. */
  label: string;
  load: (user: AuthenticatedUser, filters: ExportFilters) => Promise<Row[]>;
  columns: CsvColumn<Row>[];
}

const date = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : '');
const dateTime = (value: Date | null | undefined) => (value ? value.toISOString() : '');
const money = (value: { toString(): string } | null | undefined) =>
  value === null || value === undefined ? '' : Number(value.toString()).toFixed(2);

function definition<Row>(definition: ExportDefinition<Row>): ExportDefinition<unknown> {
  return definition as unknown as ExportDefinition<unknown>;
}

/**
 * The lists that can be downloaded. Adding one here is all a new list needs
 * — the route and the button read this registry.
 */
export const EXPORTS: Record<string, ExportDefinition<unknown>> = {
  customers: definition({
    label: 'Customers',
    load: (user, filters) => listCustomers(user, filters.q ?? '', EXPORT_LIMIT),
    columns: [
      { header: 'Name', value: (row) => row.name },
      { header: 'Mobile', value: (row) => row.phone },
      { header: 'Email', value: (row) => row.email },
      { header: 'Vehicles', value: (row) => row.vehicles.map((v) => v.plateNumber).join(' / ') },
      {
        header: 'Vehicle details',
        value: (row) => row.vehicles.map((v) => `${v.make} ${v.model}`).join(' / '),
      },
      { header: 'Added', value: (row) => date(row.createdAt) },
    ],
  }),

  vehicles: definition({
    label: 'Vehicles',
    load: (user, filters) => listVehicles(user, filters.q ?? '', EXPORT_LIMIT),
    columns: [
      { header: 'Registration', value: (row) => row.plateNumber },
      { header: 'Emirate', value: (row) => row.plateEmirate },
      { header: 'Make', value: (row) => row.make },
      { header: 'Model', value: (row) => row.model },
      { header: 'Year', value: (row) => row.year },
      { header: 'VIN', value: (row) => row.vin },
      { header: 'Colour', value: (row) => row.color },
      { header: 'Last mileage (km)', value: (row) => row.lastMileage },
      { header: 'Customer', value: (row) => row.customer.name },
      { header: 'Customer mobile', value: (row) => row.customer.phone },
    ],
  }),

  parts: definition({
    label: 'Parts',
    load: async (user, filters) =>
      (
        await listParts(user, {
          q: filters.q,
          category: filters.category,
          supplierId: filters.supplierId,
          stock: filters.stock as never,
          status: filters.status as never,
        })
      ).parts,
    columns: [
      { header: 'SKU', value: (row) => row.sku },
      { header: 'Name', value: (row) => row.name },
      { header: 'Category', value: (row) => row.category },
      { header: 'Unit', value: (row) => row.unitOfMeasure },
      { header: 'Cost price', value: (row) => money(row.defaultCostPrice) },
      { header: 'Selling price', value: (row) => money(row.defaultSellingPrice) },
      { header: 'VAT %', value: (row) => money(row.defaultTaxRate) },
      { header: 'On hand', value: (row) => formatMilli(row.onHandMilli) },
      { header: 'Reorder level', value: (row) => row.reorderLevel },
      { header: 'Stock state', value: (row) => row.state },
      { header: 'Preferred supplier', value: (row) => row.preferredSupplier?.name ?? '' },
      { header: 'Active', value: (row) => (row.isActive ? 'Yes' : 'No') },
    ],
  }),

  suppliers: definition({
    label: 'Suppliers',
    load: (user, filters) => listSuppliers(user, filters.q ?? ''),
    columns: [
      { header: 'Name', value: (row) => row.name },
      { header: 'Contact name', value: (row) => row.contactName },
      { header: 'Mobile', value: (row) => row.phone },
      { header: 'Email', value: (row) => row.email },
      { header: 'Address', value: (row) => row.address },
      { header: 'Parts supplied', value: (row) => row._count.parts },
      { header: 'Purchases', value: (row) => row._count.purchases },
      { header: 'Paid', value: (row) => money(row.balance.paid) },
      { header: 'Balance owed', value: (row) => money(row.balance.outstanding) },
      { header: 'Last purchase', value: (row) => date(row.lastPurchaseAt) },
      { header: 'Active', value: (row) => (row.isActive ? 'Yes' : 'No') },
    ],
  }),

  'work-orders': definition({
    label: 'Work orders',
    load: (user, filters) =>
      listJobCards(user, { q: filters.q, status: filters.status }, EXPORT_LIMIT),
    columns: [
      { header: 'Work order', value: (row) => row.jobNumber },
      { header: 'Status', value: (row) => JOB_STATUS_LABEL[row.status] },
      { header: 'Customer', value: (row) => row.customer.name },
      { header: 'Mobile', value: (row) => row.customer.phone },
      { header: 'Registration', value: (row) => row.vehicle.plateNumber },
      { header: 'Vehicle', value: (row) => `${row.vehicle.make} ${row.vehicle.model}` },
      { header: 'Mileage (km)', value: (row) => row.odometerReading },
      { header: 'Work requested', value: (row) => row.customerComplaint },
      { header: 'Opened', value: (row) => dateTime(row.openedAt) },
      { header: 'Closed', value: (row) => dateTime(row.closedAt) },
    ],
  }),

  quotations: definition({
    label: 'Quotations',
    load: async (user, filters) =>
      (await listQuotations(user, { q: filters.q, status: filters.status }, EXPORT_LIMIT)).quotations,
    columns: [
      { header: 'Quotation', value: (row) => row.estimateNumber },
      { header: 'Version', value: (row) => row.version },
      {
        header: 'Status',
        value: (row) => (row.expired ? 'Expired' : ESTIMATE_STATUS_LABEL[row.status]),
      },
      { header: 'Customer', value: (row) => row.customer.name },
      { header: 'Mobile', value: (row) => row.customer.phone },
      { header: 'Registration', value: (row) => row.vehicle?.plateNumber ?? '' },
      { header: 'Work order', value: (row) => row.jobCard?.jobNumber ?? '' },
      { header: 'Total', value: (row) => money(row.totalAmount) },
      { header: 'Valid until', value: (row) => date(row.validUntil) },
      { header: 'Sent', value: (row) => dateTime(row.sentAt) },
      { header: 'Created', value: (row) => dateTime(row.createdAt) },
    ],
  }),

  invoices: definition({
    label: 'Invoices',
    load: async (user, filters) =>
      (await listInvoices(user, { q: filters.q, status: filters.status }, EXPORT_LIMIT)).invoices,
    columns: [
      { header: 'Invoice', value: (row) => row.invoiceNumber },
      { header: 'Issue date', value: (row) => date(row.issueDate) },
      { header: 'Customer', value: (row) => row.customerName ?? row.customer.name },
      { header: 'Mobile', value: (row) => row.customer.phone },
      { header: 'Registration', value: (row) => row.vehicle?.plateNumber ?? '' },
      { header: 'Work order', value: (row) => row.jobCard?.jobNumber ?? '' },
      { header: 'Total', value: (row) => money(row.balance.total) },
      { header: 'Paid', value: (row) => money(row.balance.paid) },
      { header: 'Balance due', value: (row) => money(row.balance.balance) },
      { header: 'Payment state', value: (row) => row.balance.state },
    ],
  }),

  payments: definition({
    label: 'Payments',
    load: async (user, filters) =>
      (await listPayments(user, { q: filters.q }, EXPORT_LIMIT)).payments,
    columns: [
      { header: 'Receipt', value: (row) => row.paymentNumber },
      { header: 'Received', value: (row) => dateTime(row.receivedAt) },
      { header: 'Amount', value: (row) => money(row.amount) },
      { header: 'Method', value: (row) => row.methodLabel },
      { header: 'Reference', value: (row) => row.referenceNumber },
      { header: 'Invoice', value: (row) => row.invoice.invoiceNumber },
      { header: 'Customer', value: (row) => row.invoice.customerName },
      { header: 'Work order', value: (row) => row.invoice.jobCard?.jobNumber ?? '' },
      { header: 'Received by', value: (row) => row.receivedBy.fullName },
      { header: 'Reversal of', value: (row) => (row.reversalOfPaymentId ? 'Yes' : '') },
    ],
  }),

  purchases: definition({
    label: 'Purchases',
    load: async (user, filters) =>
      (
        await listPurchases(
          user,
          { q: filters.q, status: filters.status, supplierId: filters.supplierId },
          EXPORT_LIMIT,
        )
      ).purchases,
    columns: [
      { header: 'Purchase', value: (row) => row.purchaseNumber },
      { header: 'Supplier', value: (row) => row.supplier.name },
      { header: 'Status', value: (row) => row.status },
      { header: 'Supplier invoice', value: (row) => row.supplierInvoiceNumber },
      { header: 'Supplier invoice date', value: (row) => date(row.supplierInvoiceDate) },
      { header: 'Lines', value: (row) => row._count.items },
      { header: 'Subtotal', value: (row) => money(row.subtotal) },
      { header: 'VAT', value: (row) => money(row.taxAmount) },
      { header: 'Total', value: (row) => money(row.totalAmount) },
      { header: 'Ordered', value: (row) => dateTime(row.orderedAt) },
      { header: 'Received', value: (row) => dateTime(row.receivedAt) },
    ],
  }),

  'stock-movements': definition({
    label: 'Stock movements',
    load: async (user, filters) =>
      (await listMovements(user, { q: filters.q, type: filters.type }, EXPORT_LIMIT)).movements,
    columns: [
      { header: 'When', value: (row) => dateTime(row.createdAt) },
      { header: 'Type', value: (row) => row.transactionType },
      { header: 'SKU', value: (row) => row.part.sku },
      { header: 'Part', value: (row) => row.part.name },
      { header: 'Quantity', value: (row) => formatMilli(row.quantityMilli) },
      { header: 'Unit cost', value: (row) => money(row.unitCost) },
      { header: 'Note', value: (row) => row.note },
      { header: 'By', value: (row) => row.performedBy?.fullName ?? '' },
      { header: 'Unit', value: (row) => row.part.unitOfMeasure },
    ],
  }),
};

export type ExportEntity = keyof typeof EXPORTS;

export function isExportEntity(entity: string): entity is string {
  return Object.hasOwn(EXPORTS, entity);
}

/** Runs the export and returns the file's text. Permissions are the list service's own. */
export async function buildExport(
  user: AuthenticatedUser,
  entity: string,
  filters: ExportFilters,
): Promise<{ csv: string; label: string; rows: number }> {
  const definition = EXPORTS[entity];
  if (!definition) throw new NotFoundError('export');
  const rows = await definition.load(user, filters);
  return { csv: toCsv(rows, definition.columns), label: definition.label, rows: rows.length };
}
