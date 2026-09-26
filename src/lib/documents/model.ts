import { filsToString, formatMilli, signedToMilli, toFils } from '@/lib/money';

/*
 * The customer document model: what a quotation, invoice or receipt says,
 * already calculated by the domain layer (lib/documents/build.ts). The PDF
 * renderer and the customer pages only lay it out — no amount is computed
 * after this point. Amounts are exact decimal strings ("1250.00").
 *
 * Nothing in the model is an internal database id: documents only carry
 * business numbers (QT-, INV-, RCT-, JC-) the customer can read.
 */

export type DocumentKind = 'QUOTATION' | 'INVOICE' | 'RECEIPT';
export type DocumentTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** The TYPE column, as the workshop's own sheet prints it. */
export type DocumentLineType = 'PARTS' | 'LABOUR';

export interface DocumentLine {
  /** Parts or labour; null for a line that was never given a type. */
  type: DocumentLineType | null;
  description: string;
  /** Quantity as a decimal string; hours for labour. */
  quantity: string;
  unitPrice: string;
  taxRate: string | null;
  lineTotal: string;
}

/**
 * A run of lines in the one numbered table. The main lines have no title;
 * a titled section (e.g. additional work approved during the repair) prints
 * its title as a divider, and the numbering carries on across it.
 */
export interface DocumentSection {
  title: string;
  lines: DocumentLine[];
}

/** Lines only need their own VAT column when they are not all at the same rate. */
export function hasMixedVatRates(sections: DocumentSection[]): boolean {
  const rates = new Set(
    sections.flatMap((s) =>
      s.lines.map((l) => (l.taxRate === null ? '' : String(signedToMilli(l.taxRate)))),
    ),
  );
  return rates.size > 1;
}

export interface DocumentField {
  label: string;
  value: string;
}

export interface DocumentTotal {
  label: string;
  amount: string;
  emphasis?: 'total' | 'balance';
}

export interface DocumentSeller {
  name: string;
  legalName: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  taxNumber: string | null;
}

export interface CustomerDocumentModel {
  kind: DocumentKind;
  /** "Quotation", "Tax invoice", "Payment receipt". */
  title: string;
  number: string;
  /** The pill beside the number. Null prints none — an invoice shows no paid/unpaid badge. */
  status: { label: string; tone: DocumentTone } | null;
  seller: DocumentSeller;
  /** Dates and references shown beside the title. */
  meta: DocumentField[];
  customer: {
    name: string;
    phone: string | null;
    taxNumber: string | null;
    address: string | null;
  };
  vehicle: {
    description: string;
    plateNumber: string;
    vin: string | null;
    mileage: string | null;
  } | null;
  /** Free-text blocks such as the work requested. */
  narrative: DocumentField[];
  sections: DocumentSection[];
  totals: DocumentTotal[];
  /** Receipts: the amount received, shown prominently. */
  highlight: { label: string; amount: string; caption: string | null } | null;
  /** Key–value details under their own heading: payment details, payments received. */
  detailsTitle: string | null;
  details: DocumentField[];
  notes: string[];
  /** File name for downloads, without extension. */
  fileName: string;
}

/** "AED 1,250.00" from an exact decimal string, without floating-point conversion. */
export function formatAed(amount: string): string {
  const fils = amount.trim().startsWith('-')
    ? -toFils(amount.trim().slice(1))
    : toFils(amount.trim());
  const [whole, fraction] = filsToString(Math.abs(fils)).split('.');
  return `${fils < 0 ? '-' : ''}AED ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** "2.5", "1" — quantities without trailing zeros. */
export function formatQuantity(quantity: string): string {
  return formatMilli(signedToMilli(quantity));
}

/** "5%" from "5.00". */
export function formatRate(rate: string | null): string {
  if (rate === null) return '—';
  return `${formatMilli(signedToMilli(rate))}%`;
}
