import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { DomainError, NotFoundError } from '@/lib/errors';
import { claimRequestKey } from '@/lib/request-keys';
import { compactPlate, phoneCore } from '@/lib/normalize';
import { createCustomer } from '@/lib/customers/service';
import { createVehicle } from '@/lib/vehicles/service';
import { createPart } from '@/lib/inventory/parts';
import { createSupplier } from '@/lib/inventory/suppliers';
import { csvTemplate, field, parseCsv } from '@/lib/data-transfer/csv';

/*
 * Bringing a spreadsheet of master data in.
 *
 * Every row goes through the same service the screen's form uses, so a row
 * is validated, normalized and audited exactly as if it had been typed —
 * there is no second set of rules here. The whole file is one transaction:
 * if any row is wrong, nothing is written and the report says which row and
 * why. A row that already exists is reported as skipped, not duplicated.
 *
 * Documents (quotations, invoices, payments, work orders) are deliberately
 * not importable: their numbering, VAT and audit trail have to come from the
 * system that issued them.
 */

/** A file bigger than this is refused rather than read into memory. */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 2000;

export interface ImportColumn {
  header: string;
  required?: boolean;
  example?: string;
  hint?: string;
}

export interface ImportOutcome {
  /** Rows written. */
  created: number;
  /** Rows that already existed, with what matched. */
  skipped: { row: number; reason: string }[];
  /** Rows that could not be read. Any of these and nothing is written. */
  errors: { row: number; message: string }[];
  total: number;
}

interface ImportDefinition {
  label: string;
  /** What the list is called on screen, for the report. */
  noun: string;
  permission: string;
  columns: ImportColumn[];
  run: (
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    records: Record<string, string>[],
    outcome: ImportOutcome,
  ) => Promise<void>;
}

/** Row numbers in the report are the spreadsheet's own (header is row 1). */
const rowNumber = (index: number) => index + 2;

function fail(outcome: ImportOutcome, index: number, error: unknown) {
  const message =
    error instanceof DomainError
      ? error.message
      : 'This row could not be read. Check the columns against the template.';
  outcome.errors.push({ row: rowNumber(index), message });
}

export const IMPORTS: Record<string, ImportDefinition> = {
  customers: {
    label: 'Customers',
    noun: 'customer',
    permission: 'customer.create',
    columns: [
      { header: 'Name', required: true, example: 'Ahmed Al Qasimi' },
      { header: 'Mobile', required: true, example: '050 123 4567' },
      { header: 'Email', example: 'ahmed@example.com' },
      { header: 'Address', example: 'Al Qusais, Dubai' },
      { header: 'TRN', example: '100000000000003', hint: 'Tax registration number' },
    ],
    async run(tx, user, records, outcome) {
      // One lookup for the whole file rather than one per row.
      const existing = await tx.customer.findMany({
        where: { organizationId: user.organizationId },
        select: { phone: true, name: true },
      });
      const byPhone = new Map(existing.map((c) => [phoneCore(c.phone), c.name]));

      for (const [index, record] of records.entries()) {
        const phone = field(record, 'Mobile', 'Phone', 'Mobile number');
        const name = field(record, 'Name', 'Customer', 'Customer name');
        const core = phoneCore(phone);
        if (core && byPhone.has(core)) {
          outcome.skipped.push({
            row: rowNumber(index),
            reason: `${phone} is already on file as ${byPhone.get(core)}`,
          });
          continue;
        }
        try {
          await createCustomer(tx, user, {
            name,
            phone,
            email: field(record, 'Email'),
            address: field(record, 'Address'),
            taxNumber: field(record, 'TRN', 'Tax number'),
          });
          if (core) byPhone.set(core, name);
          outcome.created += 1;
        } catch (error) {
          fail(outcome, index, error);
        }
      }
    },
  },

  vehicles: {
    label: 'Vehicles',
    noun: 'vehicle',
    permission: 'vehicle.create',
    columns: [
      { header: 'Registration', required: true, example: 'A 12345' },
      {
        header: 'Customer mobile',
        required: true,
        example: '050 123 4567',
        hint: 'The owner must already be a customer',
      },
      { header: 'Make', required: true, example: 'Toyota' },
      { header: 'Model', required: true, example: 'Land Cruiser' },
      { header: 'Year', example: '2021' },
      { header: 'VIN', example: 'JTMHV05J104123456' },
      { header: 'Emirate', example: 'Dubai' },
      { header: 'Colour', example: 'White' },
    ],
    async run(tx, user, records, outcome) {
      const [customers, vehicles] = await Promise.all([
        tx.customer.findMany({
          where: { organizationId: user.organizationId, isActive: true },
          select: { id: true, phone: true, name: true },
        }),
        tx.vehicle.findMany({
          where: { organizationId: user.organizationId },
          select: { plateNumber: true },
        }),
      ]);
      const byPhone = new Map(customers.map((c) => [phoneCore(c.phone), c]));
      const plates = new Set(vehicles.map((v) => compactPlate(v.plateNumber)));

      for (const [index, record] of records.entries()) {
        const plate = field(record, 'Registration', 'Plate', 'Plate number');
        if (plate && plates.has(compactPlate(plate))) {
          outcome.skipped.push({ row: rowNumber(index), reason: `${plate} is already on file` });
          continue;
        }
        const phone = field(record, 'Customer mobile', 'Mobile', 'Phone');
        const owner = byPhone.get(phoneCore(phone));
        if (!owner) {
          outcome.errors.push({
            row: rowNumber(index),
            message: `No customer has the mobile number ${phone || '(blank)'}. Import the customers first.`,
          });
          continue;
        }
        try {
          await createVehicle(tx, user, owner.id, {
            plateNumber: plate,
            plateEmirate: field(record, 'Emirate'),
            make: field(record, 'Make'),
            model: field(record, 'Model'),
            year: field(record, 'Year'),
            vin: field(record, 'VIN'),
            color: field(record, 'Colour', 'Color'),
          });
          if (plate) plates.add(compactPlate(plate));
          outcome.created += 1;
        } catch (error) {
          fail(outcome, index, error);
        }
      }
    },
  },

  parts: {
    label: 'Parts',
    noun: 'part',
    permission: 'inventory.manage',
    columns: [
      { header: 'SKU', required: true, example: 'BRK-PAD-001' },
      { header: 'Name', required: true, example: 'Front brake pad set' },
      { header: 'Unit', required: true, example: 'piece' },
      { header: 'Cost price', example: '95.00' },
      { header: 'Selling price', example: '180.00' },
      { header: 'VAT %', example: '5' },
      { header: 'Category', example: 'Brakes' },
      { header: 'Reorder level', example: '4' },
    ],
    async run(tx, user, records, outcome) {
      const existing = await tx.part.findMany({
        where: { organizationId: user.organizationId },
        select: { sku: true },
      });
      const skus = new Set(existing.map((p) => p.sku.trim().toUpperCase()));

      for (const [index, record] of records.entries()) {
        const sku = field(record, 'SKU', 'Code');
        if (sku && skus.has(sku.trim().toUpperCase())) {
          outcome.skipped.push({ row: rowNumber(index), reason: `SKU ${sku} is already on file` });
          continue;
        }
        try {
          await createPart(
            user,
            {
              sku,
              name: field(record, 'Name', 'Part'),
              unitOfMeasure: field(record, 'Unit', 'Unit of measure') || 'piece',
              costPrice: field(record, 'Cost price', 'Cost'),
              sellingPrice: field(record, 'Selling price', 'Price'),
              taxRate: field(record, 'VAT %', 'VAT', 'Tax rate'),
              category: field(record, 'Category'),
              reorderLevel: field(record, 'Reorder level', 'Minimum'),
            },
            tx,
          );
          if (sku) skus.add(sku.trim().toUpperCase());
          outcome.created += 1;
        } catch (error) {
          fail(outcome, index, error);
        }
      }
    },
  },

  suppliers: {
    label: 'Suppliers',
    noun: 'supplier',
    permission: 'inventory.manage',
    columns: [
      { header: 'Name', required: true, example: 'Gulf Auto Parts LLC' },
      { header: 'Contact name', example: 'Rashid' },
      { header: 'Mobile', example: '04 123 4567' },
      { header: 'Email', example: 'sales@gulfautoparts.ae' },
      { header: 'Address', example: 'Deira, Dubai' },
    ],
    async run(tx, user, records, outcome) {
      const existing = await tx.supplier.findMany({
        where: { organizationId: user.organizationId },
        select: { name: true },
      });
      const names = new Set(existing.map((s) => s.name.trim().toLowerCase()));

      for (const [index, record] of records.entries()) {
        const name = field(record, 'Name', 'Supplier');
        if (name && names.has(name.trim().toLowerCase())) {
          outcome.skipped.push({ row: rowNumber(index), reason: `${name} is already on file` });
          continue;
        }
        try {
          await createSupplier(
            user,
            {
              name,
              contactName: field(record, 'Contact name', 'Contact'),
              phone: field(record, 'Mobile', 'Phone'),
              email: field(record, 'Email'),
              address: field(record, 'Address'),
            },
            tx,
          );
          if (name) names.add(name.trim().toLowerCase());
          outcome.created += 1;
        } catch (error) {
          fail(outcome, index, error);
        }
      }
    },
  },
};

export function isImportable(entity: string): boolean {
  return Object.hasOwn(IMPORTS, entity);
}

/** The blank file to start from, with the headings and one example row. */
export function importTemplate(entity: string): { csv: string; label: string } {
  const definition = IMPORTS[entity];
  if (!definition) throw new NotFoundError('import');
  return { csv: csvTemplate(definition.columns), label: definition.label };
}

export function importColumns(entity: string): ImportColumn[] {
  return IMPORTS[entity]?.columns ?? [];
}

/**
 * Reads the file and writes every row, or writes nothing at all.
 *
 * The transaction is rolled back when any row fails, so a half-imported
 * spreadsheet is impossible; the caller shows the report and the person
 * fixes the file and tries again.
 */
export async function importCsv(
  user: AuthenticatedUser,
  entity: string,
  text: string,
  requestKey?: string,
): Promise<ImportOutcome> {
  const definition = IMPORTS[entity];
  if (!definition) throw new NotFoundError('import');
  requirePermission(user, definition.permission);

  const sheet = parseCsv(text);
  if (sheet.records.length === 0) {
    throw new DomainError('That file has no rows under its headings.');
  }
  if (sheet.records.length > MAX_IMPORT_ROWS) {
    throw new DomainError(
      `That file has ${sheet.records.length} rows. Import up to ${MAX_IMPORT_ROWS} at a time.`,
    );
  }
  const required = definition.columns.filter((column) => column.required);
  const missing = required.filter(
    (column) => !sheet.records.some((record) => field(record, column.header) !== ''),
  );
  if (missing.length === sheet.records.length && missing.length > 0) {
    throw new DomainError(
      `This file has no ${missing.map((column) => column.header).join(', ')} column. Start from the template.`,
    );
  }

  const outcome: ImportOutcome = {
    created: 0,
    skipped: [],
    errors: [],
    total: sheet.records.length,
  };

  try {
    await prisma.$transaction(async (tx) => {
      await claimRequestKey(tx, user, { requestKey }, `${entity}.import`);
      await definition.run(tx, user, sheet.records, outcome);
      // Nothing is written unless every row could be read.
      if (outcome.errors.length > 0) throw new ImportRolledBack(outcome);
    });
  } catch (error) {
    if (error instanceof ImportRolledBack) {
      return { ...error.outcome, created: 0 };
    }
    throw error;
  }
  return outcome;
}

/** Internal: unwinds the transaction while carrying the report back out. */
class ImportRolledBack extends Error {
  constructor(readonly outcome: ImportOutcome) {
    super('import rolled back');
  }
}
