import { prisma } from '@/lib/prisma';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { writeAuditLog } from '@/lib/audit';
import { DomainError, NotFoundError } from '@/lib/errors';
import { getStorage, sniffImage } from '@/lib/storage';
import { storageKey, type StorageFolder } from '@/lib/storage/keys';

/*
 * Files kept with a record — the supplier's bill behind an expense or a
 * purchase, the copies of an employee's passport or visa. One set of rules
 * for every record that can hold a file:
 *
 * - a photo (JPEG, PNG, WebP) or a PDF, told by its bytes, never its name;
 * - 10 MB at most;
 * - the bytes go to the storage driver under a key the app generates, and
 *   come back only through a permission-checked route;
 * - seeing a file follows the record's View permission; adding one its
 *   Create; removing one its Edit;
 * - removing is a soft delete: the row and the file stay, marked removed,
 *   by whom and when;
 * - every attach and remove is in the audit log.
 */

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export type AttachmentEntity = 'Expense' | 'Purchase' | 'OwnerReimbursement' | 'EmployeeDocument';

interface EntityRules {
  /** What the record is called in messages. */
  noun: string;
  folder: StorageFolder;
  category: 'SUPPLIER_BILL' | 'EMPLOYEE_DOCUMENT' | 'OTHER';
  view: string;
  attach: string;
  remove: string;
  /** The audit action prefix: `expense.bill_attached`. */
  audit: string;
  /** What a file is called in the audit action: `bill` (the default) or `file`. */
  auditNoun?: 'bill' | 'file';
  load(organizationId: string, id: string): Promise<{ id: string; branchId: string | null } | null>;
}

const RULES: Record<AttachmentEntity, EntityRules> = {
  Expense: {
    noun: 'expense',
    folder: 'bills',
    category: 'SUPPLIER_BILL',
    view: 'expense.view',
    attach: 'expense.create',
    remove: 'expense.edit',
    audit: 'expense',
    load: (organizationId, id) =>
      prisma.expense.findFirst({
        where: { id, organizationId },
        select: { id: true, branchId: true },
      }),
  },
  Purchase: {
    noun: 'purchase',
    folder: 'bills',
    category: 'SUPPLIER_BILL',
    view: 'purchase.view',
    attach: 'purchase.create',
    remove: 'purchase.edit',
    audit: 'purchase',
    load: (organizationId, id) =>
      prisma.purchase.findFirst({
        where: { id, organizationId },
        select: { id: true, branchId: true },
      }),
  },
  OwnerReimbursement: {
    noun: 'repayment',
    folder: 'receipts',
    category: 'OTHER',
    // "Owed to owner" is an accounting screen; repaying is an accounting entry.
    view: 'accounting.view',
    attach: 'accounting.create',
    remove: 'accounting.edit',
    audit: 'owner_reimbursement',
    load: async (organizationId, id) => {
      const row = await prisma.ownerReimbursement.findFirst({
        where: { id, organizationId },
        select: { id: true },
      });
      return row ? { id: row.id, branchId: null } : null;
    },
  },
  // Passports, visas, IDs: kept to those who manage employee records, not
  // everyone who can see the team list.
  EmployeeDocument: {
    noun: 'employee document',
    folder: 'staff-documents',
    category: 'EMPLOYEE_DOCUMENT',
    view: 'employee.edit',
    attach: 'employee.edit',
    remove: 'employee.edit',
    audit: 'employee_document',
    auditNoun: 'file',
    load: async (organizationId, id) => {
      const row = await prisma.employeeDocument.findFirst({
        where: { id, organizationId, deletedAt: null },
        select: { id: true, employee: { select: { branchId: true } } },
      });
      return row ? { id: row.id, branchId: row.employee.branchId } : null;
    },
  },
};

/** An image by its magic numbers, or a PDF by its header. */
export function sniffAttachment(bytes: Buffer) {
  const image = sniffImage(bytes);
  if (image) return image;
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    return { mimeType: 'application/pdf' as const, extension: 'pdf' as const };
  }
  return null;
}

export interface AttachmentRow {
  id: string;
  fileName: string;
  mimeType: string;
  note: string | null;
  uploadedBy: string;
  uploadedAt: Date;
}

/** Keeps a file with a record. */
export async function attachFile(
  user: AuthenticatedUser,
  entity: AttachmentEntity,
  entityId: string,
  file: { name: string; bytes: Buffer },
  options: { note?: string | null; field?: string } = {},
) {
  const rules = RULES[entity];
  const record = await rules.load(user.organizationId, entityId);
  if (!record) throw new NotFoundError(rules.noun);
  requirePermission(user, rules.attach);
  const field = options.field ?? 'file';
  if (file.bytes.length === 0) throw new DomainError(`“${file.name}” is empty.`, field);
  if (file.bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new DomainError(`“${file.name}” is larger than 10 MB.`, field);
  }
  const type = sniffAttachment(file.bytes);
  if (!type) {
    throw new DomainError(`“${file.name}” isn’t a photo (JPEG, PNG, WebP) or a PDF.`, field);
  }
  const key = storageKey(rules.folder, type.extension);
  await getStorage().put(key, file.bytes, type.mimeType);
  const note = options.note?.trim().slice(0, 200) || null;

  return prisma.$transaction(async (tx) => {
    const document = await tx.document.create({
      data: {
        organizationId: user.organizationId,
        branchId: record.branchId,
        entityType: entity,
        entityId: record.id,
        documentType: rules.category,
        fileName: file.name.replace(/[^\w .()-]/g, '_').slice(0, 120) || `file.${type.extension}`,
        storageKey: key,
        mimeType: type.mimeType,
        fileSize: file.bytes.length,
        description: note,
        uploadedByUserId: user.id,
      },
      select: { id: true },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: record.branchId,
      actorUserId: user.id,
      action: `${rules.audit}.${rules.auditNoun ?? 'bill'}_attached`,
      entityType: entity,
      entityId: record.id,
      afterData: { documentId: document.id, fileName: file.name, size: file.bytes.length, note },
    });
    return document;
  });
}

/** The files kept against each of these records, oldest first. */
export async function listAttachments(
  user: AuthenticatedUser,
  entity: AttachmentEntity,
  entityIds: string[],
): Promise<Map<string, AttachmentRow[]>> {
  const rules = RULES[entity];
  requirePermission(user, rules.view);
  const byRecord = new Map<string, AttachmentRow[]>();
  if (entityIds.length === 0) return byRecord;
  const documents = await prisma.document.findMany({
    where: {
      organizationId: user.organizationId,
      entityType: entity,
      entityId: { in: entityIds },
      documentType: rules.category,
      deletedAt: null,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      entityId: true,
      fileName: true,
      mimeType: true,
      description: true,
      createdAt: true,
      uploadedBy: { select: { fullName: true } },
    },
  });
  for (const document of documents) {
    const list = byRecord.get(document.entityId) ?? [];
    list.push({
      id: document.id,
      fileName: document.fileName,
      mimeType: document.mimeType,
      note: document.description,
      uploadedBy: document.uploadedBy.fullName,
      uploadedAt: document.createdAt,
    });
    byRecord.set(document.entityId, list);
  }
  return byRecord;
}

/** A file the user may open, with its bytes. */
export async function readAttachment(
  user: AuthenticatedUser,
  entity: AttachmentEntity,
  documentId: string,
) {
  const rules = RULES[entity];
  requirePermission(user, rules.view);
  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      organizationId: user.organizationId,
      entityType: entity,
      documentType: rules.category,
      deletedAt: null,
    },
    select: { id: true, fileName: true, mimeType: true, storageKey: true },
  });
  if (!document) throw new NotFoundError('file');
  const bytes = await getStorage().get(document.storageKey);
  if (!bytes) throw new NotFoundError('file');
  return { ...document, bytes };
}

/** Removes a file attached in error (soft delete: the record and file are kept). */
export async function removeAttachment(
  user: AuthenticatedUser,
  entity: AttachmentEntity,
  documentId: string,
) {
  const rules = RULES[entity];
  requirePermission(user, rules.remove);
  return prisma.$transaction(async (tx) => {
    const document = await tx.document.findFirst({
      where: {
        id: documentId,
        organizationId: user.organizationId,
        entityType: entity,
        documentType: rules.category,
        deletedAt: null,
      },
      select: { id: true, entityId: true, fileName: true, branchId: true },
    });
    if (!document) throw new NotFoundError('file');
    await tx.document.update({
      where: { id: document.id },
      data: { deletedAt: new Date(), deletedByUserId: user.id },
    });
    await writeAuditLog(tx, {
      organizationId: user.organizationId,
      branchId: document.branchId,
      actorUserId: user.id,
      action: `${rules.audit}.${rules.auditNoun ?? 'bill'}_removed`,
      entityType: entity,
      entityId: document.entityId,
      beforeData: { documentId: document.id, fileName: document.fileName },
    });
    return { entityId: document.entityId };
  });
}
