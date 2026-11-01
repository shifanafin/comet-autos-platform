import type { Prisma } from '@/generated/prisma/client';
import type {
  DocumentType,
  EstimateStatus,
  JobCardStatus,
  PaymentMethod,
} from '@/generated/prisma/enums';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { writeAuditLog } from '@/lib/audit';
import { DomainError } from '@/lib/errors';
import { allocateDocumentNumbers, reserveImportedNumbers } from '@/lib/numbering';
import { compactPlate, emptyToNull, phoneCore } from '@/lib/normalize';
import { createCustomer } from '@/lib/customers/service';
import { createVehicle, MAX_MILEAGE } from '@/lib/vehicles/service';
import {
  lineData,
  priceDocument,
  totalsData,
  type PricedLine,
  type TypedLine,
} from '@/lib/billing/document-lines';
import type { DocumentTotals } from '@/lib/money';
import { filsToString, toFils } from '@/lib/money';
import { resolveDefaultVatRate } from '@/lib/tax';
import { syncPosting } from '@/lib/accounting/journal';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { OPEN_JOB_STATUSES } from '@/lib/workshop/check-in';
import { DEFAULT_QUOTE_VALIDITY_DAYS } from '@/lib/workshop/estimates';
import { CLOSED_JOB_STATUSES, JOB_STATUS_LABEL, normalizeStatus } from '@/lib/workshop/stages';
import { ESTIMATE_STATUS_LABEL } from '@/lib/workshop/labels';
import { field } from '@/lib/data-transfer/csv';
import {
  fail,
  rowNumber,
  type ImportDefinition,
  type ImportOutcome,
} from '@/lib/data-transfer/import-rows';

/*
 * Bringing job cards, quotations and invoices in from another system.
 *
 * A workshop moving to this app has years of paperwork behind it. These
 * importers bring that history across as it was issued: each document keeps
 * the number and date it was given, and its lines are priced by the same
 * rules as a document typed on screen (lib/billing/document-lines), so
 * totals and VAT are never taken on trust from the file.
 *
 * Quotations and invoices are one row per line: rows that share a number
 * are one document, and the customer and vehicle columns only need filling
 * on its first row. Job cards are one row each.
 *
 * The customer is found by mobile number and the vehicle by registration.
 * One not on file yet is created — through the same services as the
 * Customers screen — when the row has what that needs (a name; a make and
 * model), so a file exported from the old system can come in on its own.
 *
 * An imported number that looks like one of ours ("INV-000120") moves the
 * sequence past it, so a document numbered here later never collides.
 * A number already on file is skipped, never duplicated. As with every
 * import, one bad row and nothing is written.
 */

// ---------------------------------------------------------------------------
// Reading cells

/** Amounts as a spreadsheet may hold them: "1,250.00", "AED 1250". */
export function readAmount(value: string): string {
  return value
    .replace(/^AED\s*/i, '')
    .replace(/\s*AED$/i, '')
    .replace(/,/g, '')
    .trim();
}

/**
 * A date as a spreadsheet may hold it: 2026-01-31, or day first as written
 * in the UAE — 31/01/2026, 31-01-2026, 31.01.2026. Never in the future:
 * these are documents that were already issued.
 */
export function readImportDate(value: string, label: string): Date | null {
  const text = value.trim();
  if (!text) return null;
  let iso: string | null = null;
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(text);
  if (match) {
    iso = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  } else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text))) {
    iso = `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  }
  const date = iso ? parseCalendarDate(iso) : null;
  // Rejects 31/02 too: the Date rolls it into March, and no longer matches.
  if (!date || date.toISOString().slice(0, 10) !== iso) {
    throw new DomainError(`${label} "${text}" is not a date. Use YYYY-MM-DD or DD/MM/YYYY.`);
  }
  return date;
}

function notInFuture(date: Date, label: string): Date {
  if (date.toISOString().slice(0, 10) > localDateString()) {
    throw new DomainError(`${label} can't be in the future.`);
  }
  return date;
}

const today = () => parseCalendarDate(localDateString())!;

/** "10%" is a percentage off the line; a plain number is an amount off it. */
function readLineDiscount(value: string): Pick<TypedLine, 'discountType' | 'discount'> {
  const text = readAmount(value);
  if (!text) return {};
  if (text.endsWith('%')) return { discountType: 'PERCENT', discount: text.slice(0, -1).trim() };
  return { discountType: 'AMOUNT', discount: text };
}

function readItemType(value: string): 'PART' | 'LABOUR' | 'OTHER' {
  const text = value.trim().toLowerCase();
  if (!text || text.startsWith('part')) return 'PART';
  if (text.startsWith('lab') || text.startsWith('service')) return 'LABOUR';
  if (text.startsWith('other')) return 'OTHER';
  throw new DomainError(`Type "${value}" should be Parts, Labour or Other.`);
}

/** Every name a status is known by on screen, and its enum name. */
function statusNames<Status extends string>(labels: Record<Status, string>, keep: Status[]) {
  const names = new Map<string, Status>();
  for (const status of keep) {
    names.set(labels[status].toLowerCase(), status);
    names.set(status.toLowerCase().replace(/_/g, ' '), status);
  }
  return names;
}

const JOB_STATUS_NAMES = (() => {
  const current = (Object.keys(JOB_STATUS_LABEL) as JobCardStatus[]).filter(
    (status) => normalizeStatus(status) === status,
  );
  const names = statusNames(JOB_STATUS_LABEL, current);
  names.set('open', 'ARRIVED');
  names.set('closed', 'DELIVERED');
  names.set('completed', 'DELIVERED');
  return names;
})();

function readJobStatus(value: string): JobCardStatus {
  const text = value.trim().toLowerCase();
  if (!text) return 'DELIVERED';
  const status = JOB_STATUS_NAMES.get(text);
  if (!status) {
    throw new DomainError(
      `Status "${value}" isn't a job card status. Use Delivered, Cancelled or Arrived.`,
    );
  }
  return status;
}

const QUOTATION_STATUS_NAMES = (() => {
  const names = statusNames(ESTIMATE_STATUS_LABEL, ['DRAFT', 'SENT', 'APPROVED', 'REJECTED']);
  names.set('waiting', 'SENT');
  names.set('pending', 'SENT');
  names.set('accepted', 'APPROVED');
  return names;
})();

function readQuotationStatus(value: string): EstimateStatus {
  const text = value.trim().toLowerCase();
  if (!text) return 'SENT';
  const status = QUOTATION_STATUS_NAMES.get(text);
  if (!status) {
    throw new DomainError(
      `Status "${value}" isn't a quotation status. Use Draft, Sent, Approved or Rejected.`,
    );
  }
  return status;
}

const PAYMENT_METHODS: [RegExp, PaymentMethod][] = [
  [/^cash/, 'CASH'],
  [/^(card|credit|debit|visa|master)/, 'CARD'],
  [/^(bank|transfer|wire)/, 'BANK_TRANSFER'],
  [/^(cheque|check)/, 'CHEQUE'],
  [/^online/, 'ONLINE'],
];

export function readPaymentMethod(value: string): PaymentMethod {
  const text = value.trim().toLowerCase();
  if (!text) return 'CASH';
  const found = PAYMENT_METHODS.find(([pattern]) => pattern.test(text));
  if (!found) {
    throw new DomainError(
      `Payment method "${value}" should be Cash, Card, Bank transfer, Cheque or Online.`,
    );
  }
  return found[1];
}

// ---------------------------------------------------------------------------
// Customers and vehicles, found or created

interface KnownCustomer {
  id: string;
  name: string;
  address: string | null;
  taxNumber: string | null;
  isActive: boolean;
}

interface KnownVehicle {
  id: string;
  customerId: string;
  plateNumber: string;
  lastMileage: number | null;
  isActive: boolean;
}

/**
 * Every customer and vehicle on file, read once for the whole file, and
 * kept up to date as rows create new ones — so ten invoices for one new
 * customer create that customer once.
 */
class Directory {
  private constructor(
    private readonly customers: Map<string, KnownCustomer>,
    private readonly vehicles: Map<string, KnownVehicle>,
  ) {}

  static async load(tx: Prisma.TransactionClient, organizationId: string) {
    const [customers, vehicles] = await Promise.all([
      tx.customer.findMany({
        where: { organizationId },
        select: {
          id: true,
          phone: true,
          name: true,
          address: true,
          taxNumber: true,
          isActive: true,
        },
      }),
      tx.vehicle.findMany({
        where: { organizationId },
        select: {
          id: true,
          customerId: true,
          plateNumber: true,
          lastMileage: true,
          isActive: true,
        },
      }),
    ]);
    return new Directory(
      new Map(customers.map((customer) => [phoneCore(customer.phone), customer])),
      new Map(vehicles.map((vehicle) => [compactPlate(vehicle.plateNumber), vehicle])),
    );
  }

  async customer(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    record: Record<string, string>,
  ): Promise<KnownCustomer> {
    const phone = field(record, 'Customer mobile', 'Mobile', 'Phone');
    const core = phoneCore(phone);
    if (!core) throw new DomainError("The customer's mobile number is missing.");
    const known = this.customers.get(core);
    if (known) {
      if (!known.isActive) {
        throw new DomainError(
          `${known.name} (${phone}) was deleted. Restore them from Customers › Deleted first.`,
        );
      }
      return known;
    }
    const name = field(record, 'Customer name', 'Customer');
    if (!name) {
      throw new DomainError(
        `No customer has the mobile number ${phone}. Fill in the Customer name so they can be added.`,
      );
    }
    const created = await createCustomer(tx, user, {
      name,
      phone,
      taxNumber: field(record, 'Customer TRN', 'TRN'),
      email: field(record, 'Customer email', 'Email'),
    });
    const entry: KnownCustomer = {
      id: created.id,
      name: created.name,
      address: created.address,
      taxNumber: created.taxNumber,
      isActive: true,
    };
    this.customers.set(core, entry);
    return entry;
  }

  async vehicle(
    tx: Prisma.TransactionClient,
    user: AuthenticatedUser,
    record: Record<string, string>,
    customer: KnownCustomer,
  ): Promise<KnownVehicle | null> {
    const plate = field(record, 'Registration', 'Plate', 'Plate number');
    if (!plate) return null;
    const known = this.vehicles.get(compactPlate(plate));
    if (known) {
      if (!known.isActive) {
        throw new DomainError(
          `${known.plateNumber} was deleted. Restore it from Vehicles › Deleted first.`,
        );
      }
      if (known.customerId !== customer.id) {
        throw new DomainError(`${known.plateNumber} belongs to a different customer on file.`);
      }
      return known;
    }
    const make = field(record, 'Make');
    const model = field(record, 'Model');
    if (!make || !model) {
      throw new DomainError(
        `${plate} is not on file. Fill in its Make and Model so it can be added.`,
      );
    }
    const created = await createVehicle(tx, user, customer.id, {
      plateNumber: plate,
      make,
      model,
      year: field(record, 'Year'),
      color: field(record, 'Colour', 'Color'),
    });
    const entry: KnownVehicle = {
      id: created.id,
      customerId: customer.id,
      plateNumber: created.plateNumber,
      lastMileage: created.lastMileage,
      isActive: true,
    };
    this.vehicles.set(compactPlate(plate), entry);
    return entry;
  }

  /** Remembers a reading, so a later row for the same car compares against it. */
  noteMileage(vehicle: KnownVehicle, mileage: number) {
    vehicle.lastMileage = Math.max(vehicle.lastMileage ?? 0, mileage);
  }
}

// ---------------------------------------------------------------------------
// Documents: rows grouped by number

interface Group {
  /** The number as the file gives it; blank means "number it here". */
  number: string;
  rows: { index: number; record: Record<string, string> }[];
}

/** Rows sharing a number are one document; a row with no number is one on its own. */
function groupByNumber(records: Record<string, string>[], names: string[]): Group[] {
  const byKey = new Map<string, Group>();
  const groups: Group[] = [];
  records.forEach((record, index) => {
    const number = field(record, ...names).trim();
    const key = number ? number.toUpperCase() : `\u0000${index}`;
    let group = byKey.get(key);
    if (!group) {
      group = { number, rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push({ index, record });
  });
  return groups;
}

/** A document-level value: from whichever of its rows has it — normally the first. */
function header(group: Group, ...names: string[]): string {
  for (const { record } of group.rows) {
    const value = field(record, ...names);
    if (value) return value;
  }
  return '';
}

/** The row that holds the customer's details: the first one that names a mobile. */
function customerRow(group: Group): Record<string, string> {
  return (
    group.rows.find(({ record }) => field(record, 'Customer mobile', 'Mobile', 'Phone'))?.record ??
    group.rows[0].record
  );
}

/**
 * Splits the file into the documents to create and the ones already on
 * file, and gives every document its number: the file's own, or — where
 * the file left it blank — the next from the sequence, after the
 * sequence has moved past every imported number.
 */
async function numberDocuments(
  tx: Prisma.TransactionClient,
  user: AuthenticatedUser,
  branchId: string,
  documentType: DocumentType,
  groups: Group[],
  existing: Set<string>,
  outcome: ImportOutcome,
  noun: string,
): Promise<(Group & { assigned: string })[]> {
  const fresh = groups.filter((group) => {
    if (group.number && existing.has(group.number.toUpperCase())) {
      outcome.skipped.push({
        row: rowNumber(group.rows[0].index),
        reason: `${noun} ${group.number} is already on file`,
      });
      return false;
    }
    return true;
  });
  await reserveImportedNumbers(
    tx,
    user.organizationId,
    branchId,
    documentType,
    fresh.filter((group) => group.number).map((group) => group.number),
  );
  const generated = await allocateDocumentNumbers(
    tx,
    user.organizationId,
    branchId,
    documentType,
    fresh.filter((group) => !group.number).length,
  );
  let next = 0;
  return fresh.map((group) => ({ ...group, assigned: group.number || generated[next++] }));
}

/**
 * The document's lines, priced by the same rules as one typed on screen.
 * A line that doesn't add up is reported against its own spreadsheet row.
 */
function priceLines(
  group: Group,
  defaultVatRate: string,
): { lines: PricedLine[]; totals: DocumentTotals } {
  const typed: TypedLine[] = group.rows.map(({ index, record }) => {
    try {
      const description = field(record, 'Description', 'Item', 'Work');
      if (!description) throw new DomainError('Every line needs a Description.');
      const unitPrice = readAmount(field(record, 'Unit price', 'Price', 'Rate', 'Amount'));
      if (!unitPrice) throw new DomainError(`"${description}" has no Unit price.`);
      return {
        itemType: readItemType(field(record, 'Type', 'Item type')),
        description: description.slice(0, 300),
        quantity: readAmount(field(record, 'Quantity', 'Qty')) || '1',
        unitPrice,
        taxRate:
          readAmount(field(record, 'VAT %', 'VAT', 'Tax rate')).replace(/%$/, '') || undefined,
        ...readLineDiscount(field(record, 'Discount')),
      };
    } catch (error) {
      throw new RowError(index, error);
    }
  });
  try {
    return priceDocument(typed, defaultVatRate, {});
  } catch (error) {
    // priceDocument names the line ("items.2"); point at that line's row.
    const line = error instanceof DomainError ? /^items\.(\d+)$/.exec(error.field ?? '') : null;
    const index = line ? group.rows[Number(line[1])].index : group.rows[0].index;
    const message =
      error instanceof DomainError ? error.message.replace(/^Line \d+: /, '') : undefined;
    throw new RowError(index, message ? new DomainError(message) : error);
  }
}

/** A failure that belongs to a particular row of a multi-row document. */
class RowError extends Error {
  constructor(
    readonly index: number,
    readonly error: unknown,
  ) {
    super('row error');
  }
}

function failGroup(outcome: ImportOutcome, group: Group, error: unknown) {
  if (error instanceof RowError) fail(outcome, error.index, error.error);
  else fail(outcome, group.rows[0].index, error);
}

function requireBranch(user: AuthenticatedUser): string {
  if (!user.primaryBranchId) {
    throw new DomainError('Your account has no branch assigned. Contact an administrator.');
  }
  return user.primaryBranchId;
}

/** A job card named on a quotation or invoice, which must be this customer's. */
async function findJobCard(
  tx: Prisma.TransactionClient,
  organizationId: string,
  jobNumber: string,
  customer: KnownCustomer,
) {
  if (!jobNumber) return null;
  const jobCard = await tx.jobCard.findFirst({
    where: { organizationId, jobNumber: { equals: jobNumber, mode: 'insensitive' } },
    select: { id: true, jobNumber: true, customerId: true, vehicleId: true },
  });
  if (!jobCard) {
    throw new DomainError(`Job card ${jobNumber} is not on file. Import the job cards first.`);
  }
  if (jobCard.customerId !== customer.id) {
    throw new DomainError(`Job card ${jobCard.jobNumber} belongs to a different customer.`);
  }
  return jobCard;
}

// ---------------------------------------------------------------------------
// The importers

const CUSTOMER_COLUMNS = [
  { header: 'Customer name', example: 'Ahmed Al Qasimi', hint: 'Needed only for a new customer' },
  { header: 'Customer mobile', required: true, example: '050 123 4567' },
];

const VEHICLE_COLUMNS = [
  { header: 'Registration', example: 'A 12345' },
  { header: 'Make', example: 'Toyota', hint: 'Needed only for a new vehicle' },
  { header: 'Model', example: 'Land Cruiser', hint: 'Needed only for a new vehicle' },
];

const LINE_COLUMNS = [
  { header: 'Type', example: 'Parts', hint: 'Parts, Labour or Other — blank means Parts' },
  { header: 'Description', required: true, example: 'Front brake pads' },
  { header: 'Quantity', example: '1', hint: 'Blank means 1' },
  { header: 'Unit price', required: true, example: '180.00', hint: 'Before VAT' },
  { header: 'VAT %', example: '5', hint: "Blank means the workshop's rate" },
  { header: 'Discount', example: '', hint: 'An amount off the line, or a percentage like 10%' },
];

const LINES_NOTE =
  'One row per line. Rows with the same number are one document — the customer and vehicle only need filling on its first row. Leave the number blank to number it here.';

export const DOCUMENT_IMPORTS: Record<string, ImportDefinition> = {
  'work-orders': {
    label: 'Job cards',
    noun: 'job card',
    permission: 'job_card.create',
    note: 'One row per job card. A customer or vehicle not on file yet is added from the row. Leave the number blank to number it here.',
    columns: [
      { header: 'Job card no.', example: 'JC-000101', hint: 'Blank to number it here' },
      { header: 'Date', example: '2026-01-15', hint: 'YYYY-MM-DD or DD/MM/YYYY' },
      ...CUSTOMER_COLUMNS,
      { ...VEHICLE_COLUMNS[0], required: true },
      ...VEHICLE_COLUMNS.slice(1),
      { header: 'Mileage (km)', example: '84500' },
      { header: 'Work requested', required: true, example: 'Service and brake check' },
      {
        header: 'Status',
        example: 'Delivered',
        hint: 'Delivered, Cancelled or Arrived — blank means Delivered',
      },
    ],
    async run(tx, user, records, outcome) {
      const branchId = requireBranch(user);
      const directory = await Directory.load(tx, user.organizationId);
      const [existing, openJobs] = await Promise.all([
        tx.jobCard.findMany({
          where: { organizationId: user.organizationId },
          select: { jobNumber: true },
        }),
        tx.jobCard.findMany({
          where: { organizationId: user.organizationId, status: { in: OPEN_JOB_STATUSES } },
          select: { vehicleId: true, jobNumber: true },
        }),
      ]);
      const openByVehicle = new Map(openJobs.map((job) => [job.vehicleId, job.jobNumber]));
      const groups = groupByNumber(records, ['Job card no.', 'Job card', 'Job number']);
      for (const group of groups.filter((group) => group.rows.length > 1)) {
        for (const { index } of group.rows.slice(1)) {
          outcome.errors.push({
            row: rowNumber(index),
            message: `Job card ${group.number} appears more than once in the file.`,
          });
        }
      }
      if (outcome.errors.length > 0) return;

      const numbered = await numberDocuments(
        tx,
        user,
        branchId,
        'JOB_CARD',
        groups,
        new Set(existing.map((job) => job.jobNumber.toUpperCase())),
        outcome,
        'Job card',
      );

      for (const group of numbered) {
        const { index, record } = group.rows[0];
        try {
          const status = readJobStatus(field(record, 'Status'));
          const openedAt = notInFuture(
            readImportDate(field(record, 'Date', 'Date opened', 'Opened'), 'Date') ?? today(),
            'The date',
          );
          const complaint = field(record, 'Work requested', 'Complaint', 'Work');
          if (complaint.length < 3) throw new DomainError('Describe the Work requested.');
          const mileageText = field(record, 'Mileage (km)', 'Mileage', 'Odometer').replace(
            /[,\s]/g,
            '',
          );
          if (mileageText && !/^\d+$/.test(mileageText)) {
            throw new DomainError('Mileage must be a whole number of km, or left blank.');
          }
          const mileage = mileageText ? Number(mileageText) : null;
          if (mileage !== null && mileage > MAX_MILEAGE) {
            throw new DomainError('That mileage is not realistic — check the odometer.');
          }

          const customer = await directory.customer(tx, user, record);
          const vehicle = await directory.vehicle(tx, user, record, customer);
          if (!vehicle) throw new DomainError('Every job card needs the vehicle Registration.');
          const closed = CLOSED_JOB_STATUSES.includes(status);
          if (!closed) {
            const open = openByVehicle.get(vehicle.id);
            if (open) {
              throw new DomainError(
                `${vehicle.plateNumber} is already in the workshop on job ${open}. Only one job card per vehicle can be open.`,
              );
            }
          }

          const jobCard = await tx.jobCard.create({
            data: {
              organizationId: user.organizationId,
              branchId,
              vehicleId: vehicle.id,
              customerId: vehicle.customerId,
              jobNumber: group.assigned,
              status,
              odometerReading: mileage,
              customerComplaint: complaint,
              openedAt,
              closedAt: closed ? openedAt : null,
              deliveredAt: status === 'DELIVERED' ? openedAt : null,
              deliveredByUserId: status === 'DELIVERED' ? user.id : null,
              createdByUserId: user.id,
            },
          });
          if (!closed) openByVehicle.set(vehicle.id, group.assigned);
          if (mileage !== null && mileage > (vehicle.lastMileage ?? -1)) {
            await tx.vehicle.update({ where: { id: vehicle.id }, data: { lastMileage: mileage } });
            directory.noteMileage(vehicle, mileage);
          }
          await tx.jobStatusHistory.create({
            data: {
              organizationId: user.organizationId,
              jobCardId: jobCard.id,
              fromStatus: null,
              toStatus: status,
              changedByUserId: user.id,
              changedAt: openedAt,
            },
          });
          await writeAuditLog(tx, {
            organizationId: user.organizationId,
            branchId,
            actorUserId: user.id,
            action: 'job_card.imported',
            entityType: 'JobCard',
            entityId: jobCard.id,
            afterData: {
              jobNumber: group.assigned,
              status,
              vehicleId: vehicle.id,
              customerId: vehicle.customerId,
              odometerReading: mileage,
              openedAt: openedAt.toISOString().slice(0, 10),
            },
            metadata: { origin: 'import', numberFromFile: Boolean(group.number) },
          });
          outcome.created += 1;
        } catch (error) {
          fail(outcome, index, error);
        }
      }
    },
  },

  quotations: {
    label: 'Quotations',
    noun: 'quotation',
    permission: 'quotation.create',
    note: LINES_NOTE,
    columns: [
      { header: 'Quotation no.', example: 'EST-000045', hint: 'Blank to number it here' },
      {
        header: 'Date',
        example: '2026-01-15',
        hint: 'YYYY-MM-DD or DD/MM/YYYY — blank means today',
      },
      ...CUSTOMER_COLUMNS,
      ...VEHICLE_COLUMNS,
      { header: 'Job card no.', example: '', hint: 'Optional — links it to an imported job card' },
      ...LINE_COLUMNS,
      {
        header: 'Status',
        example: 'Sent',
        hint: 'Draft, Sent, Approved or Rejected — blank means Sent',
      },
      {
        header: 'Valid until',
        example: '',
        hint: `Blank means ${DEFAULT_QUOTE_VALIDITY_DAYS} days after the date`,
      },
    ],
    secondExample: {
      'Quotation no.': 'EST-000045',
      Type: 'Labour',
      Description: 'Brake service labour',
      Quantity: '1',
      'Unit price': '120.00',
      'VAT %': '5',
    },
    async run(tx, user, records, outcome) {
      const branchId = requireBranch(user);
      const [directory, defaultVatRate, existing] = await Promise.all([
        Directory.load(tx, user.organizationId),
        resolveDefaultVatRate(user.organizationId, tx),
        tx.estimate.findMany({
          where: { organizationId: user.organizationId },
          select: { estimateNumber: true },
        }),
      ]);
      const numbered = await numberDocuments(
        tx,
        user,
        branchId,
        'ESTIMATE',
        groupByNumber(records, ['Quotation no.', 'Quotation', 'Estimate no.', 'Estimate']),
        new Set(existing.map((estimate) => estimate.estimateNumber.toUpperCase())),
        outcome,
        'Quotation',
      );

      for (const group of numbered) {
        try {
          const status = readQuotationStatus(header(group, 'Status'));
          const date = notInFuture(
            readImportDate(header(group, 'Date', 'Quotation date'), 'Date') ?? today(),
            'The date',
          );
          const validUntil =
            readImportDate(header(group, 'Valid until', 'Expiry'), 'Valid until') ??
            new Date(date.getTime() + DEFAULT_QUOTE_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
          if (validUntil < date) throw new DomainError('Valid until is before the quotation date.');
          const { lines, totals } = priceLines(group, defaultVatRate);

          const row = customerRow(group);
          const customer = await directory.customer(tx, user, row);
          const vehicle = await directory.vehicle(tx, user, row, customer);
          const jobCard = await findJobCard(
            tx,
            user.organizationId,
            header(group, 'Job card no.', 'Job card'),
            customer,
          );
          if (jobCard) {
            const quoted = await tx.estimate.findFirst({
              where: {
                organizationId: user.organizationId,
                jobCardId: jobCard.id,
                kind: 'ORIGINAL',
              },
              select: { estimateNumber: true },
            });
            if (quoted) {
              throw new DomainError(
                `Job card ${jobCard.jobNumber} already has quotation ${quoted.estimateNumber}.`,
              );
            }
          }

          const sent = status !== 'DRAFT';
          const estimate = await tx.estimate.create({
            data: {
              organizationId: user.organizationId,
              branchId,
              jobCardId: jobCard?.id ?? null,
              customerId: customer.id,
              vehicleId: vehicle?.id ?? jobCard?.vehicleId ?? null,
              estimateNumber: group.assigned,
              status,
              ...totalsData(totals),
              notes: emptyToNull(header(group, 'Notes')),
              preparedByUserId: user.id,
              sentByUserId: sent ? user.id : null,
              sentAt: sent ? date : null,
              validUntil,
              createdAt: date,
            },
          });
          await tx.estimateItem.createMany({
            data: lines.map((line) => ({
              organizationId: user.organizationId,
              estimateId: estimate.id,
              itemType: line.itemType,
              description: line.description,
              vatTreatment: line.vatTreatment,
              ...lineData(line.amounts),
            })),
          });
          await writeAuditLog(tx, {
            organizationId: user.organizationId,
            branchId,
            actorUserId: user.id,
            action: 'quotation.imported',
            entityType: 'Estimate',
            entityId: estimate.id,
            afterData: {
              estimateNumber: group.assigned,
              status,
              customerId: customer.id,
              jobCardId: jobCard?.id ?? null,
              lines: lines.length,
              totalAmount: totals.totalAmount,
            },
            metadata: { origin: 'import', numberFromFile: Boolean(group.number) },
          });
          outcome.created += 1;
        } catch (error) {
          failGroup(outcome, group, error);
        }
      }
    },
  },

  invoices: {
    label: 'Invoices',
    noun: 'invoice',
    permission: 'invoice.create',
    note: `${LINES_NOTE} Amount paid records one payment on the invoice's date.`,
    columns: [
      { header: 'Invoice no.', example: 'INV-000120', hint: 'Blank to number it here' },
      { header: 'Date', required: true, example: '2026-01-15', hint: 'YYYY-MM-DD or DD/MM/YYYY' },
      { header: 'Due date', example: '', hint: 'Blank means due on the invoice date' },
      ...CUSTOMER_COLUMNS,
      { header: 'Customer TRN', example: '', hint: 'For a VAT-registered customer' },
      ...VEHICLE_COLUMNS,
      { header: 'Job card no.', example: '', hint: 'Optional — links it to an imported job card' },
      { header: "Customer's order no.", example: '' },
      ...LINE_COLUMNS,
      { header: 'Amount paid', example: '315.00', hint: 'Blank or 0 means unpaid' },
      {
        header: 'Payment method',
        example: 'Cash',
        hint: 'Cash, Card, Bank transfer, Cheque or Online',
      },
    ],
    secondExample: {
      'Invoice no.': 'INV-000120',
      Type: 'Labour',
      Description: 'Brake service labour',
      Quantity: '1',
      'Unit price': '120.00',
      'VAT %': '5',
    },
    async run(tx, user, records, outcome) {
      const branchId = requireBranch(user);
      const [directory, defaultVatRate, existing, organization] = await Promise.all([
        Directory.load(tx, user.organizationId),
        resolveDefaultVatRate(user.organizationId, tx),
        tx.invoice.findMany({
          where: { organizationId: user.organizationId },
          select: { invoiceNumber: true },
        }),
        tx.organization.findUniqueOrThrow({
          where: { id: user.organizationId },
          select: { name: true, legalName: true, taxNumber: true, address: true },
        }),
      ]);
      const numbered = await numberDocuments(
        tx,
        user,
        branchId,
        'TAX_INVOICE',
        groupByNumber(records, ['Invoice no.', 'Invoice', 'Invoice number']),
        new Set(existing.map((invoice) => invoice.invoiceNumber.toUpperCase())),
        outcome,
        'Invoice',
      );
      // Receipt numbers for every invoice that says it was paid, in one go.
      const paidGroups = numbered.filter((group) => {
        const paid = readAmount(header(group, 'Amount paid', 'Paid'));
        return paid !== '' && !/^0*\.?0*$/.test(paid);
      });
      const receipts = await allocateDocumentNumbers(
        tx,
        user.organizationId,
        branchId,
        'PAYMENT_RECEIPT',
        paidGroups.length,
      );
      const receiptFor = new Map(paidGroups.map((group, index) => [group, receipts[index]]));

      for (const group of numbered) {
        try {
          const dateText = header(group, 'Date', 'Invoice date', 'Issue date');
          if (!dateText) throw new DomainError('Every invoice needs its Date.');
          const issueDate = notInFuture(readImportDate(dateText, 'Date')!, 'The invoice date');
          const dueDate = readImportDate(header(group, 'Due date'), 'Due date') ?? issueDate;
          if (dueDate < issueDate) {
            throw new DomainError('The due date cannot be before the invoice date.');
          }
          const { lines, totals } = priceLines(group, defaultVatRate);

          const receipt = receiptFor.get(group);
          const paidText = readAmount(header(group, 'Amount paid', 'Paid'));
          let paid = 0;
          if (receipt) {
            try {
              paid = toFils(paidText, 'Amount paid');
            } catch (error) {
              throw new DomainError(error instanceof Error ? error.message : 'Check Amount paid.');
            }
          }
          const total = toFils(totals.totalAmount);
          if (paid > total) {
            throw new DomainError(
              `Amount paid (${filsToString(paid)}) is more than the invoice total (${totals.totalAmount}).`,
            );
          }
          const method = readPaymentMethod(header(group, 'Payment method', 'Method'));

          const row = customerRow(group);
          const customer = await directory.customer(tx, user, row);
          const vehicle = await directory.vehicle(tx, user, row, customer);
          const jobCard = await findJobCard(
            tx,
            user.organizationId,
            header(group, 'Job card no.', 'Job card'),
            customer,
          );
          if (jobCard) {
            const live = await tx.invoice.findFirst({
              where: {
                organizationId: user.organizationId,
                jobCardId: jobCard.id,
                status: { notIn: ['VOID', 'CANCELLED'] },
              },
              select: { invoiceNumber: true },
            });
            if (live) {
              throw new DomainError(
                `Job card ${jobCard.jobNumber} is already invoiced (${live.invoiceNumber}).`,
              );
            }
          }

          const invoice = await tx.invoice.create({
            data: {
              organizationId: user.organizationId,
              branchId,
              jobCardId: jobCard?.id ?? null,
              customerId: customer.id,
              vehicleId: vehicle?.id ?? jobCard?.vehicleId ?? null,
              invoiceType: 'TAX_INVOICE',
              invoiceNumber: group.assigned,
              status: paid === 0 ? 'ISSUED' : paid === total ? 'PAID' : 'PARTIALLY_PAID',
              issueDate,
              supplyDate: issueDate,
              dueDate,
              ...totalsData(totals),
              customerReference: emptyToNull(
                header(group, "Customer's order no.", 'LPO', 'Order no.'),
              ),
              notes: emptyToNull(header(group, 'Notes')),
              sellerLegalName: organization.legalName ?? organization.name,
              sellerTaxNumber: organization.taxNumber,
              sellerAddress: organization.address,
              customerName: customer.name,
              customerTaxNumber:
                emptyToNull(field(row, 'Customer TRN', 'TRN')) ?? customer.taxNumber,
              customerAddress: customer.address,
              createdByUserId: user.id,
              issuedByUserId: user.id,
              issuedAt: issueDate,
            },
          });
          await tx.invoiceItem.createMany({
            data: lines.map((line) => ({
              organizationId: user.organizationId,
              invoiceId: invoice.id,
              itemType: line.itemType,
              description: line.description,
              vatTreatment: line.vatTreatment,
              ...lineData(line.amounts),
            })),
          });
          await syncPosting(tx, user.organizationId, 'INVOICE', invoice.id, user.id);
          if (receipt && paid > 0) {
            const payment = await tx.payment.create({
              data: {
                organizationId: user.organizationId,
                invoiceId: invoice.id,
                paymentNumber: receipt,
                amount: filsToString(paid),
                method,
                status: 'COMPLETED',
                notes: 'Imported with the invoice',
                receivedAt: issueDate,
                receivedByUserId: user.id,
              },
            });
            await syncPosting(tx, user.organizationId, 'PAYMENT', payment.id, user.id);
          }
          await writeAuditLog(tx, {
            organizationId: user.organizationId,
            branchId,
            actorUserId: user.id,
            action: 'invoice.imported',
            entityType: 'Invoice',
            entityId: invoice.id,
            afterData: {
              invoiceNumber: group.assigned,
              issueDate: issueDate.toISOString().slice(0, 10),
              customerId: customer.id,
              jobCardId: jobCard?.id ?? null,
              lines: lines.length,
              subtotal: totals.subtotal,
              taxAmount: totals.taxAmount,
              totalAmount: totals.totalAmount,
              paid: filsToString(paid),
              paymentNumber: paid > 0 ? receipt : null,
            },
            metadata: { origin: 'import', numberFromFile: Boolean(group.number) },
          });
          outcome.created += 1;
        } catch (error) {
          failGroup(outcome, group, error);
        }
      }
    },
  },
};
