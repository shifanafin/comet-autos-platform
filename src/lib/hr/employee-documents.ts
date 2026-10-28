import { z } from 'zod';
import type { EmployeeDocumentKind } from '@/generated/prisma/enums';
import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { hasPermission, requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { parseInput } from '@/lib/form-data';
import { claimRequestKey, settleRequestKey } from '@/lib/request-keys';
import { localDateString, parseCalendarDate } from '@/lib/format';
import { listAttachments, type AttachmentRow } from '@/lib/documents/attachments';

/*
 * The papers kept for each employee — what a UAE employer must hold copies
 * of — with each one's number and dates, so an expiry is seen before it
 * lapses. Each record holds any number of copies (front, back, the PDF),
 * kept through lib/documents/attachments.ts: photos or PDFs, private, and
 * opened only by those who manage employee records (employee.edit).
 */

export interface DocumentKindInfo {
  kind: EmployeeDocumentKind;
  label: string;
  /** Every employee needs one: shown as missing until it is added. */
  required: boolean;
  /** It carries an expiry date worth watching. */
  expires: boolean;
}

/** In the order a new joiner's file is put together. */
export const DOCUMENT_KINDS: DocumentKindInfo[] = [
  { kind: 'PASSPORT', label: 'Passport', required: true, expires: true },
  { kind: 'VISA', label: 'Residence visa', required: true, expires: true },
  { kind: 'EMIRATES_ID', label: 'Emirates ID', required: true, expires: true },
  { kind: 'WORK_PERMIT', label: 'Work permit / labour card', required: true, expires: true },
  { kind: 'LABOUR_CONTRACT', label: 'MOHRE labour contract', required: true, expires: false },
  { kind: 'OFFER_LETTER', label: 'Offer letter', required: false, expires: false },
  { kind: 'HEALTH_INSURANCE', label: 'Health insurance card', required: true, expires: true },
  { kind: 'ILOE', label: 'ILOE unemployment insurance', required: false, expires: true },
  { kind: 'DRIVING_LICENCE', label: 'Driving licence', required: false, expires: true },
  { kind: 'BANK_DETAILS', label: 'Bank letter / IBAN', required: false, expires: false },
  { kind: 'CERTIFICATE', label: 'Certificate', required: false, expires: false },
  { kind: 'PHOTO', label: 'Photo', required: false, expires: false },
  { kind: 'OTHER', label: 'Other', required: false, expires: true },
];

const KIND_INFO = new Map(DOCUMENT_KINDS.map((info) => [info.kind, info]));

export function documentKindLabel(kind: EmployeeDocumentKind) {
  return KIND_INFO.get(kind)?.label ?? kind;
}

/** Kinds a person holds several of at once: a newer one never replaces another. */
const MANY_AT_ONCE = new Set<EmployeeDocumentKind>(['CERTIFICATE', 'PHOTO', 'OTHER']);

/** How soon before its expiry a document is flagged. */
export const EXPIRY_WARNING_DAYS = 30;

export type ExpiryStatus = 'expired' | 'soon' | 'valid' | 'none';

/** Where a document stands on `today` ("YYYY-MM-DD"). */
export function expiryStatus(expiryDate: string | null, today: string): ExpiryStatus {
  if (!expiryDate) return 'none';
  if (expiryDate < today) return 'expired';
  const warnFrom = new Date(`${today}T00:00:00Z`);
  warnFrom.setUTCDate(warnFrom.getUTCDate() + EXPIRY_WARNING_DAYS);
  return expiryDate <= warnFrom.toISOString().slice(0, 10) ? 'soon' : 'valid';
}

/** Whole days from `today` to `date` (negative once past). */
export function daysUntil(date: string, today: string) {
  return Math.round(
    (new Date(`${date}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) /
      86_400_000,
  );
}

const isoDay = (date: Date | null) => (date ? date.toISOString().slice(0, 10) : null);

/**
 * The record of each kind that counts: the one expiring last. A renewed
 * passport replaces the old one, whose expiry then no longer matters.
 */
function currentIds(rows: { id: string; kind: EmployeeDocumentKind; expiryDate: Date | null }[]) {
  const best = new Map<EmployeeDocumentKind, { id: string; expiry: string }>();
  const current = new Set<string>();
  for (const row of rows) {
    if (MANY_AT_ONCE.has(row.kind)) {
      current.add(row.id);
      continue;
    }
    const expiry = isoDay(row.expiryDate) ?? '9999-12-31';
    const held = best.get(row.kind);
    if (!held || expiry > held.expiry) best.set(row.kind, { id: row.id, expiry });
  }
  for (const { id } of best.values()) current.add(id);
  return current;
}

export interface EmployeeDocumentRow {
  id: string;
  kind: EmployeeDocumentKind;
  label: string;
  documentNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  notes: string | null;
  status: ExpiryStatus;
  /** A newer one of the same kind is on file. */
  replaced: boolean;
  files: AttachmentRow[];
}

/** Whether this user may see and keep employees' papers. */
export function canManageEmployeeDocuments(user: AuthenticatedUser) {
  return hasPermission(user, 'employee.edit');
}

/** One employee's papers, in checklist order, and the required ones still missing. */
export async function getEmployeeDocuments(user: AuthenticatedUser, employeeId: string) {
  requirePermission(user, 'employee.edit');
  const employee = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId: user.organizationId },
    select: { id: true },
  });
  if (!employee) throw new NotFoundError('employee');
  const rows = await prisma.employeeDocument.findMany({
    where: { organizationId: user.organizationId, employeeId, deletedAt: null },
    orderBy: [{ expiryDate: 'desc' }, { createdAt: 'desc' }],
  });
  const files = await listAttachments(
    user,
    'EmployeeDocument',
    rows.map((row) => row.id),
  );
  const today = localDateString();
  const current = currentIds(rows);
  const order = new Map(DOCUMENT_KINDS.map((info, index) => [info.kind, index]));
  const documents: EmployeeDocumentRow[] = rows
    .map((row) => {
      const expiryDate = isoDay(row.expiryDate);
      const replaced = !current.has(row.id);
      return {
        id: row.id,
        kind: row.kind,
        label: documentKindLabel(row.kind),
        documentNumber: row.documentNumber,
        issueDate: isoDay(row.issueDate),
        expiryDate,
        notes: row.notes,
        status: replaced ? ('none' as const) : expiryStatus(expiryDate, today),
        replaced,
        files: files.get(row.id) ?? [],
      };
    })
    .sort(
      (a, b) =>
        (order.get(a.kind) ?? 99) - (order.get(b.kind) ?? 99) ||
        Number(a.replaced) - Number(b.replaced),
    );
  const held = new Set(rows.map((row) => row.kind));
  return {
    documents,
    missing: DOCUMENT_KINDS.filter((info) => info.required && !held.has(info.kind)),
    today,
  };
}

/**
 * Papers of people still employed that have expired or expire within
 * EXPIRY_WARNING_DAYS — only the current one of each kind. Empty for anyone
 * who may not see employees' papers.
 */
export async function getExpiringEmployeeDocuments(user: AuthenticatedUser) {
  if (!canManageEmployeeDocuments(user)) return [];
  const today = localDateString();
  const rows = await prisma.employeeDocument.findMany({
    where: {
      organizationId: user.organizationId,
      deletedAt: null,
      expiryDate: { not: null },
      employee: { isActive: true, terminationDate: null },
    },
    select: {
      id: true,
      kind: true,
      expiryDate: true,
      employeeId: true,
      employee: { select: { firstName: true, lastName: true } },
    },
  });
  const byEmployee = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byEmployee.get(row.employeeId) ?? [];
    list.push(row);
    byEmployee.set(row.employeeId, list);
  }
  const flagged: {
    id: string;
    employeeId: string;
    employeeName: string;
    label: string;
    expiryDate: string;
    status: 'expired' | 'soon';
    days: number;
  }[] = [];
  for (const list of byEmployee.values()) {
    const current = currentIds(list);
    for (const row of list) {
      const expiryDate = isoDay(row.expiryDate)!;
      const status = expiryStatus(expiryDate, today);
      if (!current.has(row.id) || (status !== 'expired' && status !== 'soon')) continue;
      flagged.push({
        id: row.id,
        employeeId: row.employeeId,
        employeeName: `${row.employee.firstName} ${row.employee.lastName}`.trim(),
        label: documentKindLabel(row.kind),
        expiryDate,
        status,
        days: daysUntil(expiryDate, today),
      });
    }
  }
  return flagged.sort((a, b) => a.expiryDate.localeCompare(b.expiryDate));
}

const optionalDate = z
  .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date.')])
  .optional();

const documentSchema = z.object({
  kind: z.enum(
    DOCUMENT_KINDS.map((info) => info.kind) as [EmployeeDocumentKind, ...EmployeeDocumentKind[]],
    { error: 'Choose what the document is.' },
  ),
  documentNumber: z.string().trim().max(60, 'Keep the number under 60 characters.').optional(),
  issueDate: optionalDate,
  expiryDate: optionalDate,
  notes: z.string().trim().max(300, 'Keep the note under 300 characters.').optional(),
});

function toData(input: z.infer<typeof documentSchema>) {
  const issueDate = input.issueDate ? parseCalendarDate(input.issueDate) : null;
  const expiryDate = input.expiryDate ? parseCalendarDate(input.expiryDate) : null;
  if (issueDate && expiryDate && expiryDate < issueDate) {
    throw new DomainError('The expiry date is before the issue date.', 'expiryDate');
  }
  return {
    kind: input.kind,
    documentNumber: input.documentNumber || null,
    issueDate,
    expiryDate,
    notes: input.notes || null,
  };
}

const snapshot = (data: ReturnType<typeof toData>) => ({
  kind: data.kind,
  documentNumber: data.documentNumber,
  issueDate: isoDay(data.issueDate),
  expiryDate: isoDay(data.expiryDate),
  notes: data.notes,
});

/** Records one of an employee's papers; its copies are attached to it after. */
export async function addEmployeeDocument(
  user: AuthenticatedUser,
  employeeId: string,
  rawInput: unknown,
) {
  requirePermission(user, 'employee.edit');
  const data = toData(parseInput(documentSchema, rawInput));
  return prisma.$transaction(async (tx) => {
    await claimRequestKey(tx, user, rawInput, 'employee_document.add');
    const employee = await tx.employee.findFirst({
      where: { id: employeeId, organizationId: user.organizationId },
      select: { id: true, branchId: true },
    });
    if (!employee) throw new NotFoundError('employee');
    const document = await tx.employeeDocument.create({
      data: { organizationId: user.organizationId, employeeId: employee.id, ...data },
      select: { id: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: employee.branchId,
      actorUserId: user.id,
      action: 'employee_document.added',
      entityType: 'EmployeeDocument',
      entityId: document.id,
      afterData: { employeeId: employee.id, ...snapshot(data) },
    });
    await settleRequestKey(tx, user, rawInput, document.id);
    return document;
  });
}

/** Corrects a document's details (a renewal is added as a new one instead). */
export async function updateEmployeeDocument(
  user: AuthenticatedUser,
  documentId: string,
  rawInput: unknown,
) {
  requirePermission(user, 'employee.edit');
  const data = toData(parseInput(documentSchema, rawInput));
  return prisma.$transaction(async (tx) => {
    const before = await tx.employeeDocument.findFirst({
      where: { id: documentId, organizationId: user.organizationId, deletedAt: null },
      include: { employee: { select: { branchId: true } } },
    });
    if (!before) throw new NotFoundError('employee document');
    await tx.employeeDocument.update({ where: { id: before.id }, data });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: before.employee.branchId,
      actorUserId: user.id,
      action: 'employee_document.updated',
      entityType: 'EmployeeDocument',
      entityId: before.id,
      beforeData: snapshot(before),
      afterData: snapshot(data),
    });
    return { id: before.id, employeeId: before.employeeId };
  });
}

/** Removes a document recorded in error (soft delete: the record and its copies are kept). */
export async function removeEmployeeDocument(user: AuthenticatedUser, documentId: string) {
  requirePermission(user, 'employee.edit');
  return prisma.$transaction(async (tx) => {
    const before = await tx.employeeDocument.findFirst({
      where: { id: documentId, organizationId: user.organizationId, deletedAt: null },
      include: { employee: { select: { branchId: true } } },
    });
    if (!before) throw new NotFoundError('employee document');
    await tx.employeeDocument.update({
      where: { id: before.id },
      data: { deletedAt: new Date() },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: before.employee.branchId,
      actorUserId: user.id,
      action: 'employee_document.removed',
      entityType: 'EmployeeDocument',
      entityId: before.id,
      beforeData: snapshot(before),
    });
    return { id: before.id, employeeId: before.employeeId };
  });
}
