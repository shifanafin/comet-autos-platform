import type { Prisma } from '@/generated/prisma/client';
import type { DocumentType } from '@/generated/prisma/enums';

const DEFAULT_PREFIX: Record<DocumentType, string> = {
  JOB_CARD: 'JC-',
  ESTIMATE: 'EST-',
  TAX_INVOICE: 'INV-',
  PROFORMA_INVOICE: 'PRO-',
  PURCHASE_ORDER: 'PO-',
  PAYMENT_RECEIPT: 'RCT-',
  EXPENSE_VOUCHER: 'EXP-',
  SUPPLIER_PAYMENT: 'SP-',
  JOURNAL_ENTRY: 'JV-',
  CREDIT_NOTE: 'CN-',
  FIXED_ASSET: 'FA-',
  OPENING_BALANCE: 'OB-',
  MONEY_TRANSFER: 'TRF-',
  CUSTOMER_ADVANCE: 'ADV-',
  OWNER_MONEY: 'OWN-',
  PAYMENT_VOUCHER: 'PV-',
  OTHER_INCOME: 'INC-',
};

/**
 * The branch's sequence for a document type — or, with no branch, the
 * workshop-wide one (journal entries) — created on first use, and locked
 * (`SELECT ... FOR UPDATE`) until the transaction ends.
 */
async function lockSequence(
  tx: Prisma.TransactionClient,
  organizationId: string,
  branchId: string | null,
  documentType: DocumentType,
) {
  let sequence = await tx.documentNumberSequence.findFirst({
    where: { organizationId, branchId, documentType },
  });

  if (!sequence) {
    try {
      sequence = await tx.documentNumberSequence.create({
        data: { organizationId, branchId, documentType, prefix: DEFAULT_PREFIX[documentType] },
      });
    } catch {
      // Lost a create race against a concurrent transaction — the row now
      // exists, fall through and use it.
      sequence = await tx.documentNumberSequence.findFirstOrThrow({
        where: { organizationId, branchId, documentType },
      });
    }
  }

  await tx.$executeRaw`SELECT id FROM document_number_sequences WHERE id = ${sequence.id}::uuid FOR UPDATE`;
  return tx.documentNumberSequence.findUniqueOrThrow({ where: { id: sequence.id } });
}

/**
 * Allocates the next sequential, zero-padded document number, branch-scoped.
 * Concurrency-safe: locks the DocumentNumberSequence row (`SELECT ... FOR
 * UPDATE`) before reading nextNumber, per the invariant documented on that
 * model in prisma/schema.prisma — must always run inside the same
 * transaction as the document creation it's numbering.
 */
export async function allocateDocumentNumber(
  tx: Prisma.TransactionClient,
  organizationId: string,
  branchId: string | null,
  documentType: DocumentType,
): Promise<string> {
  const [number] = await allocateDocumentNumbers(tx, organizationId, branchId, documentType, 1);
  return number;
}

/**
 * `count` consecutive numbers at once — an import numbering many documents
 * takes the lock once rather than once per document.
 */
export async function allocateDocumentNumbers(
  tx: Prisma.TransactionClient,
  organizationId: string,
  branchId: string | null,
  documentType: DocumentType,
  count: number,
): Promise<string[]> {
  if (count <= 0) return [];
  // The usual case — the sequence exists — in a single statement: the UPDATE
  // takes the row lock, moves the counter and hands back where it stood, so
  // two transactions can never be given the same number. It holds the lock
  // until the transaction ends, exactly as SELECT ... FOR UPDATE did.
  const moved = await tx.$queryRaw<{ prefix: string; padding: number; first: number }[]>`
    UPDATE document_number_sequences
    SET next_number = next_number + ${count}, updated_at = now()
    WHERE organization_id = ${organizationId}::uuid
      AND document_type = ${documentType}::"DocumentType"
      AND branch_id IS NOT DISTINCT FROM ${branchId}::uuid
    RETURNING prefix, padding, next_number - ${count} AS first`;
  if (moved.length === 1) {
    const { prefix, padding } = moved[0];
    const first = Number(moved[0].first);
    return Array.from(
      { length: count },
      (_, index) => `${prefix}${String(first + index).padStart(padding, '0')}`,
    );
  }
  // First use of this sequence: create it, then number from it.
  const locked = await lockSequence(tx, organizationId, branchId, documentType);
  await tx.documentNumberSequence.update({
    where: { id: locked.id },
    data: { nextNumber: locked.nextNumber + count },
  });
  return Array.from(
    { length: count },
    (_, index) =>
      `${locked.prefix}${String(locked.nextNumber + index).padStart(locked.padding, '0')}`,
  );
}

/**
 * Documents brought in from another system keep the numbers they were
 * issued with. When one of those looks like ours ("INV-000120"), the
 * sequence moves past it, so a document numbered here later can never
 * collide with an imported one.
 */
export async function reserveImportedNumbers(
  tx: Prisma.TransactionClient,
  organizationId: string,
  branchId: string | null,
  documentType: DocumentType,
  numbers: string[],
): Promise<void> {
  if (numbers.length === 0) return;
  const locked = await lockSequence(tx, organizationId, branchId, documentType);
  const prefix = locked.prefix.toUpperCase();
  let highest = 0;
  for (const number of numbers) {
    const text = number.trim().toUpperCase();
    if (!text.startsWith(prefix)) continue;
    const digits = text.slice(prefix.length);
    if (/^\d{1,9}$/.test(digits)) highest = Math.max(highest, Number(digits));
  }
  if (highest >= locked.nextNumber) {
    await tx.documentNumberSequence.update({
      where: { id: locked.id },
      data: { nextNumber: highest + 1 },
    });
  }
}
