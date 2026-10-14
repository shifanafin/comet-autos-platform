import { prisma } from '@/lib/prisma';
import { LIKELY_SAME, similarParts } from '@/lib/inventory/part-match';
import type { AuthenticatedUser } from '@/lib/auth/session';
import { requirePermission } from '@/lib/auth/authorize';
import { DomainError } from '@/lib/errors';
import { MAX_ATTACHMENT_BYTES } from '@/lib/documents/attachments';
import { parseBill, type BillWarning } from '@/lib/bill-reader/parse';
import { sameVendor } from '@/lib/finance/vendor-names';

/*
 * "Scan bill": from the text of a supplier's bill to a draft the form opens
 * on. It reads — the organization's own TRN (so it is never taken for the
 * supplier's), the suppliers and parts on file, and whether this bill is
 * already in the books — and writes nothing at all. Nothing is saved until
 * the user has looked at the form and pressed Save.
 *
 * The text comes from the browser (OCR of a photo runs there) or from a
 * PDF's own text layer, extracted here. Either way the user must be allowed
 * to record what they are scanning for.
 */

export type BillTarget = 'expense' | 'purchase';

const PERMISSION: Record<BillTarget, string> = {
  expense: 'expense.create',
  purchase: 'purchase.create',
};

/** Shorter than this, a PDF's text layer is a scan with a stray label on it. */
const MIN_TEXT = 40;
const MAX_TEXT = 60_000;
const PDF_PAGES = 3;

export interface BillDraftLine {
  description: string;
  quantity: string;
  unitPrice: string;
  amount: string;
  /** The part on file this row reads as; blank for the user to choose. */
  partId: string;
}

export interface BillDraft {
  supplier: { id: string; name: string } | null;
  /** The name as printed, when no supplier on file matched. */
  supplierName: string | null;
  supplierTrn: string | null;
  billNumber: string | null;
  billDate: string | null;
  subtotal: string | null;
  vat: string | null;
  total: string | null;
  isTaxInvoice: boolean;
  isCardSlip: boolean;
  lines: BillDraftLine[];
  /** Amounts that didn't add up, by field. */
  warnings: BillWarning[];
  /** The same supplier and bill number, already recorded. */
  duplicate: { label: string; href: string } | null;
  /** Which fields the reader filled, for the audit entry written on Save. */
  filled: string[];
}

/** "Taimoor Auto Spare Parts Tr. L.L.C" and "TAIMOOR AUTO SPARE PARTS TR LLC" are one name. */
function nameKey(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(llc|fzco|fze|fzc|est|co|tr|trading|company|establishment)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function matchSupplier(organizationId: string, trn: string | null, headerLines: string[]) {
  if (trn) {
    const byTrn = await prisma.supplier.findFirst({
      where: { organizationId, taxNumber: trn },
      orderBy: { isActive: 'desc' },
      select: { id: true, name: true },
    });
    if (byTrn) return byTrn;
  }
  // The "Bill To" row names us, the customer — never the supplier.
  const header = headerLines
    .filter((line) => !/bill\s*to|sold\s*to|customer|client/i.test(line))
    .map(nameKey)
    .filter((line) => line.length > 0);
  if (header.length === 0) return null;
  const suppliers = await prisma.supplier.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, name: true },
  });
  // The longest name that a header line carries: "Al Amani" must not win
  // over "Al Amani Auto Parts" when the bill says the longer one.
  return (
    suppliers
      .map((supplier) => ({ supplier, key: nameKey(supplier.name) }))
      .filter(({ key }) => key.length >= 4 && header.some((line) => line.includes(key)))
      .sort((a, b) => b.key.length - a.key.length)[0]?.supplier ?? null
  );
}

async function findDuplicate(
  organizationId: string,
  target: BillTarget,
  billNumber: string | null,
  supplier: { id: string; name: string } | null,
  supplierName: string | null,
) {
  if (!billNumber) return null;
  if (target === 'purchase') {
    if (!supplier) return null;
    const purchase = await prisma.purchase.findFirst({
      where: {
        organizationId,
        supplierId: supplier.id,
        supplierInvoiceNumber: { equals: billNumber, mode: 'insensitive' },
        status: { not: 'CANCELLED' },
      },
      select: { id: true, purchaseNumber: true },
    });
    return purchase
      ? {
          label: `Purchase ${purchase.purchaseNumber}`,
          href: `/inventory/purchases/${purchase.id}`,
        }
      : null;
  }
  const vendor = supplier?.name ?? supplierName;
  if (!vendor) return null;
  // The vendor may have been spelt another way the first time.
  const expense = (
    await prisma.expense.findMany({
      where: {
        organizationId,
        status: 'RECORDED',
        billNumber: { equals: billNumber, mode: 'insensitive' },
      },
      select: { expenseNumber: true, description: true, vendorName: true },
      take: 20,
    })
  ).find((other) => other.vendorName && sameVendor(vendor, other.vendorName));
  return expense
    ? {
        label: `Expense ${expense.expenseNumber ?? expense.description}`,
        href: `/finance/expenses?q=${encodeURIComponent(expense.expenseNumber ?? billNumber)}`,
      }
    : null;
}

/** Each item row against the parts on file: by SKU in the text, else by name. */
async function matchParts(organizationId: string, descriptions: string[]) {
  if (descriptions.length === 0) return [];
  const parts = await prisma.part.findMany({
    where: { organizationId, isActive: true },
    select: { id: true, sku: true, name: true },
  });
  const keyed = parts.map((part) => ({
    id: part.id,
    sku: part.sku.toLowerCase(),
    name: nameKey(part.name),
  }));
  const taken = new Set<string>();
  return descriptions.map((description) => {
    const text = description.toLowerCase();
    const key = nameKey(description);
    const exact =
      keyed.find(
        (part) => !taken.has(part.id) && part.sku.length >= 3 && text.includes(part.sku),
      ) ?? keyed.find((part) => !taken.has(part.id) && part.name.length >= 4 && part.name === key);
    // Else the part on file the shop's wording most surely means ("BRAKE PADS
    // FRONT" for "Brake pad front") — only when one stands out, so a row is
    // never filled with a guess; the form shows it to check either way.
    const close = exact
      ? null
      : similarParts(
          { name: description },
          parts.filter((part) => !taken.has(part.id)),
          { threshold: LIKELY_SAME, limit: 2 },
        );
    const id =
      exact?.id ??
      (close && close.length > 0 && (close.length === 1 || close[0].score > close[1].score)
        ? close[0].part.id
        : '');
    if (id) taken.add(id);
    return id;
  });
}

/** Turns the text of a bill into a draft for the form. Reads only. */
export async function readBill(
  user: AuthenticatedUser,
  target: BillTarget,
  text: string,
): Promise<BillDraft> {
  requirePermission(user, PERMISSION[target]);
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new DomainError('Nothing could be read from that bill. Try a clearer photo.');
  }
  const organization = await prisma.organization.findUnique({
    where: { id: user.organizationId },
    select: { taxNumber: true },
  });
  const bill = parseBill(text.slice(0, MAX_TEXT), { ownTrn: organization?.taxNumber });
  const supplier = await matchSupplier(user.organizationId, bill.supplierTrn, bill.headerLines);
  const lines = target === 'purchase' ? bill.lines : [];
  const partIds = await matchParts(
    user.organizationId,
    lines.map((line) => line.description),
  );
  const duplicate = await findDuplicate(
    user.organizationId,
    target,
    bill.billNumber,
    supplier,
    bill.supplierName,
  );

  const filled = [
    supplier || bill.supplierName ? 'supplier' : null,
    bill.billNumber ? 'billNumber' : null,
    bill.billDate ? 'billDate' : null,
    bill.subtotal ? 'subtotal' : null,
    bill.vat ? 'vat' : null,
    bill.total ? 'total' : null,
    lines.length ? 'lines' : null,
  ].filter((field): field is string => field !== null);

  return {
    supplier,
    supplierName: supplier ? null : bill.supplierName,
    supplierTrn: bill.supplierTrn,
    billNumber: bill.billNumber,
    billDate: bill.billDate,
    subtotal: bill.subtotal,
    vat: bill.vat,
    total: bill.total,
    isTaxInvoice: bill.isTaxInvoice,
    isCardSlip: bill.isCardSlip,
    lines: lines.map((line, index) => ({ ...line, partId: partIds[index] })),
    warnings: bill.warnings,
    duplicate,
    filled,
  };
}

/** The text layer of a PDF's first pages; null when it has none worth reading (a scan). */
export async function extractPdfText(bytes: Buffer): Promise<string | null> {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new DomainError('That file isn’t a PDF.');
  }
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new DomainError('That PDF is larger than 10 MB.');
  const { extractText, getDocumentProxy } = await import('unpdf');
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const result = await extractText(pdf, { mergePages: false });
    pages = result.text.slice(0, PDF_PAGES);
  } catch {
    throw new DomainError('That PDF could not be opened. Try a photo of the bill instead.');
  }
  const text = pages.join('\n').trim();
  return text.replace(/\s/g, '').length >= MIN_TEXT ? text : null;
}

/**
 * Reads a PDF bill. One with a text layer is read from it directly — no
 * OCR. A scanned one comes back as `needsOcr`, for the browser to render
 * and read as an image.
 */
export async function readBillPdf(
  user: AuthenticatedUser,
  target: BillTarget,
  bytes: Buffer,
): Promise<{ needsOcr: true } | { needsOcr: false; draft: BillDraft }> {
  requirePermission(user, PERMISSION[target]);
  const text = await extractPdfText(bytes);
  if (text === null) return { needsOcr: true };
  return { needsOcr: false, draft: await readBill(user, target, text) };
}
