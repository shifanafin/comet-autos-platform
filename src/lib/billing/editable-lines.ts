import { formatMilli, signedToMilli, type DiscountType } from '@/lib/money';
import { treatmentFromRate, type VatTreatment } from '@/lib/vat-treatment';

/*
 * A quotation or invoice line as the line editor holds it while it is being
 * typed (components/workshop/document-lines-editor.tsx), and how a saved
 * line or bill discount is turned back into one to be edited again.
 *
 * Plain data and functions, so server pages can prepare the editor's
 * starting values and the editor can use the same shapes.
 */

export type LineType = 'PART' | 'LABOUR' | 'OTHER';

export interface EditableLine {
  key: string;
  /** Editing a saved document: the line it was, so its links carry over. */
  sourceId?: string;
  itemType: LineType;
  description: string;
  quantity: string;
  unitPrice: string;
  /** Percent; follows from the VAT treatment. */
  taxRate: string;
  /** How the line is treated for VAT. */
  vatTreatment: VatTreatment;
  /** The tax code chosen; blank for a line priced by its treatment alone. */
  taxCodeId: string;
  /** The line's discount: a percentage or an AED amount; blank for none. */
  discountType: DiscountType;
  discount: string;
  /** Invoices: the income account it books to; blank for the default of its type. */
  accountId: string;
  /** Parts lines: the catalogue part it is; blank for none picked yet. */
  partId: string;
  /** What one cost, before VAT; blank for the part's current cost. */
  unitCost: string;
}

/** A discount on the whole bill, as typed. Blank for none. */
export interface BillDiscount {
  type: DiscountType;
  value: string;
}

type Stored = { toString(): string };

/** "2.500" → "2.5", "5.00" → "5": a stored figure as a person would type it. */
function typed(value: Stored): string {
  return formatMilli(signedToMilli(value.toString()));
}

/** A saved line, ready to edit again. */
export function editableLine(
  item: {
    id?: string;
    itemType: string | null;
    description: string;
    quantity: Stored;
    unitPrice: Stored;
    taxRate: Stored | null;
    discountType: DiscountType | null;
    discountValue: Stored | null;
    accountId?: string | null;
    vatTreatment?: VatTreatment | null;
    taxCodeId?: string | null;
    partId?: string | null;
    unitCost?: Stored | null;
  },
  key: string,
  defaultVatRate: string,
): EditableLine {
  return {
    key,
    ...(item.id ? { sourceId: item.id } : {}),
    itemType: item.itemType === 'LABOUR' || item.itemType === 'OTHER' ? item.itemType : 'PART',
    description: item.description,
    quantity: typed(item.quantity),
    unitPrice: item.unitPrice.toString(),
    taxRate: typed(item.taxRate ?? defaultVatRate),
    discountType: item.discountType ?? 'PERCENT',
    discount: item.discountValue ? typed(item.discountValue) : '',
    accountId: item.accountId ?? '',
    vatTreatment: item.vatTreatment ?? treatmentFromRate(item.taxRate ?? defaultVatRate),
    taxCodeId: item.taxCodeId ?? '',
    partId: item.partId ?? '',
    unitCost: item.unitCost?.toString() ?? '',
  };
}

/** A saved bill discount, ready to edit again. */
export function editableBill(document: {
  discountType: DiscountType | null;
  discountValue: Stored | null;
}): BillDiscount {
  return {
    type: document.discountType ?? 'PERCENT',
    value: document.discountValue ? typed(document.discountValue) : '',
  };
}
