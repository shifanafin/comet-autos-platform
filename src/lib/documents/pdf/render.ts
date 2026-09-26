import {
  A4,
  PdfDocument,
  type PdfPage,
  type Rgb,
  textWidth,
  wrapText,
} from '@/lib/documents/pdf/writer';
import {
  formatAed,
  formatQuantity,
  formatRate,
  hasMixedVatRates,
  type CustomerDocumentModel,
  type DocumentTone,
} from '@/lib/documents/model';

/*
 * Lays a CustomerDocumentModel out on A4 pages. Formatting only: every
 * amount arrives already calculated. Long item tables continue on new pages
 * with the column headings repeated; every page carries the workshop's
 * contact line and "Page n of m".
 */

const INK: Rgb = [0.094, 0.094, 0.106];
const MUTED: Rgb = [0.392, 0.455, 0.545];
const RULE: Rgb = [0.894, 0.894, 0.914];
const SOFT: Rgb = [0.969, 0.969, 0.98];
const BRAND: Rgb = [0.486, 0.227, 0.929];
const NIGHT: Rgb = [0.067, 0.067, 0.094];
const WHITE: Rgb = [1, 1, 1];

const TONE: Record<DocumentTone, { fill: Rgb; text: Rgb }> = {
  success: { fill: [0.906, 0.969, 0.925], text: [0.086, 0.502, 0.239] },
  warning: { fill: [0.996, 0.953, 0.878], text: [0.706, 0.325, 0.035] },
  danger: { fill: [0.996, 0.922, 0.922], text: [0.725, 0.11, 0.11] },
  info: { fill: [0.914, 0.941, 0.996], text: [0.114, 0.306, 0.847] },
  neutral: { fill: [0.945, 0.945, 0.953], text: [0.322, 0.322, 0.357] },
};

const MARGIN = 48;
const RIGHT = A4.width - MARGIN;
const CONTENT = RIGHT - MARGIN;
const BOTTOM = A4.height - 70;

/*
 * Item table columns, laid out like the workshop's own quotation sheet:
 * S.No · Type · Description · Qty · Price · Amount. A per-line VAT column
 * appears only when the lines are not all at one rate — otherwise the
 * totals already say "VAT 5%". Numeric columns give their right edge.
 */
interface Columns {
  no: number;
  type: number;
  desc: number;
  qty: number;
  price: number;
  vat: number | null;
  amount: number;
  descWidth: number;
}

function columns(withVat: boolean): Columns {
  const base = { no: MARGIN + 30, type: MARGIN + 40, desc: MARGIN + 92, amount: RIGHT - 12 };
  const numeric = withVat
    ? { qty: MARGIN + 322, price: MARGIN + 392, vat: MARGIN + 428 }
    : { qty: MARGIN + 350, price: MARGIN + 425, vat: null };
  return { ...base, ...numeric, descWidth: numeric.qty - base.desc - 40 };
}

function pill(page: PdfPage, label: string, tone: DocumentTone, right: number, top: number) {
  const size = 8.5;
  const width = textWidth(label.toUpperCase(), 'bold', size) + 16;
  page.rect(right - width, top, width, 17, { fill: TONE[tone].fill, radius: 8.5 });
  page.text(label.toUpperCase(), right - width / 2, top + 11.6, {
    font: 'bold',
    size,
    color: TONE[tone].text,
    align: 'center',
  });
}

function brandMark(page: PdfPage, x: number, y: number) {
  page.rect(x, y, 34, 34, { fill: BRAND, radius: 8 });
  page.text('C', x + 17, y + 23.5, { font: 'bold', size: 18, color: WHITE, align: 'center' });
}

/** The header band on page one: brand, seller contact, document title, number and status. */
function header(page: PdfPage, doc: CustomerDocumentModel) {
  page.rect(0, 0, A4.width, 6, { fill: BRAND });
  brandMark(page, MARGIN, 34);
  page.text(doc.seller.name, MARGIN + 46, 48, { font: 'bold', size: 15, color: INK });
  page.text('Automotive workshop', MARGIN + 46, 62, { size: 8.5, color: MUTED });

  let y = 88;
  const contact = [
    doc.seller.legalName && doc.seller.legalName !== doc.seller.name ? doc.seller.legalName : null,
    doc.seller.address,
    [doc.seller.phone ? `Tel ${doc.seller.phone}` : null, doc.seller.email]
      .filter(Boolean)
      .join('  ·  ') || null,
    doc.seller.taxNumber ? `TRN ${doc.seller.taxNumber}` : null,
  ].filter((line): line is string => Boolean(line));
  for (const line of contact) {
    for (const wrapped of wrapText(line, 'regular', 8.5, 250)) {
      page.text(wrapped, MARGIN, y, { size: 8.5, color: MUTED });
      y += 11.5;
    }
  }

  page.text(doc.title.toUpperCase(), RIGHT, 48, {
    font: 'bold',
    size: 19,
    color: BRAND,
    align: 'right',
  });
  page.text(doc.number, RIGHT, 66, { font: 'bold', size: 11, color: INK, align: 'right' });
  if (doc.status) pill(page, doc.status.label, doc.status.tone, RIGHT, 76);

  let metaY = 112;
  for (const field of doc.meta) {
    page.text(field.label, RIGHT - 120, metaY, { size: 8.5, color: MUTED, align: 'right' });
    page.text(field.value, RIGHT, metaY, { font: 'bold', size: 8.5, color: INK, align: 'right' });
    metaY += 13;
  }
  return Math.max(y, metaY) + 14;
}

/** Customer and vehicle, side by side on a soft panel. */
function parties(page: PdfPage, doc: CustomerDocumentModel, top: number) {
  const half = (CONTENT - 12) / 2;
  const blocks: { title: string; lines: { text: string; bold?: boolean }[] }[] = [
    {
      title: doc.kind === 'QUOTATION' ? 'Prepared for' : 'Billed to',
      lines: [
        { text: doc.customer.name, bold: true },
        ...(doc.customer.phone ? [{ text: doc.customer.phone }] : []),
        ...(doc.customer.address ? [{ text: doc.customer.address }] : []),
        ...(doc.customer.taxNumber ? [{ text: `TRN ${doc.customer.taxNumber}` }] : []),
      ],
    },
  ];
  if (doc.vehicle) {
    blocks.push({
      title: 'Vehicle',
      lines: [
        { text: doc.vehicle.description, bold: true },
        { text: `Registration ${doc.vehicle.plateNumber}` },
        ...(doc.vehicle.vin ? [{ text: `VIN ${doc.vehicle.vin}` }] : []),
        ...(doc.vehicle.mileage ? [{ text: `Odometer ${doc.vehicle.mileage}` }] : []),
      ],
    });
  }
  const wrapped = blocks.map((block) =>
    block.lines.flatMap((line) =>
      wrapText(line.text, line.bold ? 'bold' : 'regular', 9.5, half - 28).map((text) => ({
        text,
        bold: line.bold,
      })),
    ),
  );
  const height = 34 + Math.max(...wrapped.map((lines) => lines.length)) * 13;
  blocks.forEach((block, index) => {
    const x = MARGIN + index * (half + 12);
    page.rect(x, top, half, height, { fill: SOFT, radius: 8 });
    page.text(block.title.toUpperCase(), x + 14, top + 18, {
      font: 'bold',
      size: 7.5,
      color: MUTED,
    });
    wrapped[index].forEach((line, lineIndex) => {
      page.text(line.text, x + 14, top + 34 + lineIndex * 13, {
        font: line.bold ? 'bold' : 'regular',
        size: 9.5,
        color: INK,
      });
    });
  });
  return top + height + 20;
}

class Layout {
  page: PdfPage;
  y: number;
  constructor(
    private readonly pdf: PdfDocument,
    first: PdfPage,
    y: number,
  ) {
    this.page = first;
    this.y = y;
  }
  /** Starts a new page when `height` more points don't fit; returns true if it did. */
  ensure(height: number): boolean {
    if (this.y + height <= BOTTOM) return false;
    this.page = this.pdf.addPage();
    this.page.rect(0, 0, A4.width, 6, { fill: BRAND });
    this.y = 44;
    return true;
  }
}

function tableHeader(layout: Layout, col: Columns) {
  const { page } = layout;
  page.rect(MARGIN, layout.y, CONTENT, 22, { fill: NIGHT, radius: 5 });
  const y = layout.y + 14.5;
  const style = { font: 'bold' as const, size: 7.5, color: WHITE };
  page.text('S.NO', col.no, y, { ...style, align: 'right' });
  page.text('TYPE', col.type, y, style);
  page.text('DESCRIPTION', col.desc, y, style);
  page.text('QTY', col.qty, y, { ...style, align: 'right' });
  page.text('PRICE', col.price, y, { ...style, align: 'right' });
  if (col.vat !== null) page.text('VAT', col.vat, y, { ...style, align: 'right' });
  page.text('AMOUNT', col.amount, y, { ...style, align: 'right' });
  layout.y += 30;
}

function sections(layout: Layout, doc: CustomerDocumentModel) {
  if (doc.sections.length === 0) return;
  const col = columns(hasMixedVatRates(doc.sections));
  layout.ensure(80);
  tableHeader(layout, col);
  // One running number across the whole table, like the paper sheet.
  let number = 0;
  for (const section of doc.sections) {
    if (section.title) {
      if (layout.ensure(40)) tableHeader(layout, col);
      layout.page.text(section.title.toUpperCase(), col.type, layout.y + 8, {
        font: 'bold',
        size: 7.5,
        color: BRAND,
      });
      layout.y += 16;
    }
    for (const line of section.lines) {
      number += 1;
      const description = wrapText(line.description, 'regular', 9.5, col.descWidth);
      const height = Math.max(description.length * 12.5, 12.5) + 10;
      if (layout.ensure(height)) tableHeader(layout, col);
      const { page } = layout;
      const base = layout.y + 9;
      page.text(String(number), col.no, base, { size: 9.5, color: MUTED, align: 'right' });
      if (line.type) page.text(line.type, col.type, base, { font: 'bold', size: 7.5, color: MUTED });
      description.forEach((text, index) =>
        page.text(text, col.desc, base + index * 12.5, { size: 9.5, color: INK }),
      );
      page.text(formatQuantity(line.quantity), col.qty, base, {
        size: 9.5,
        color: INK,
        align: 'right',
      });
      page.text(formatAed(line.unitPrice), col.price, base, {
        size: 9.5,
        color: INK,
        align: 'right',
      });
      if (col.vat !== null) {
        page.text(formatRate(line.taxRate), col.vat, base, {
          size: 9.5,
          color: MUTED,
          align: 'right',
        });
      }
      page.text(formatAed(line.lineTotal), col.amount, base, {
        font: 'bold',
        size: 9.5,
        color: INK,
        align: 'right',
      });
      layout.y += height;
      page.line(MARGIN, layout.y - 4, RIGHT, layout.y - 4, { color: RULE, width: 0.6 });
    }
    layout.y += 6;
  }
}

function totals(layout: Layout, doc: CustomerDocumentModel) {
  if (doc.totals.length === 0) return;
  const rowHeight = 18;
  const height = doc.totals.length * rowHeight + 20;
  layout.ensure(height + 10);
  const left = RIGHT - 230;
  const { page } = layout;
  page.rect(left, layout.y, 230, height, { fill: SOFT, radius: 8 });
  let y = layout.y + 22;
  for (const total of doc.totals) {
    const strong = total.emphasis === 'total' || total.emphasis === 'balance';
    if (total.emphasis === 'total')
      page.line(left + 14, y - 12, RIGHT - 14, y - 12, { color: RULE, width: 0.8 });
    page.text(total.label, left + 14, y, {
      font: strong ? 'bold' : 'regular',
      size: strong ? 10.5 : 9.5,
      color: strong ? INK : MUTED,
    });
    page.text(formatAed(total.amount), RIGHT - 14, y, {
      font: strong ? 'bold' : 'regular',
      size: strong ? 11.5 : 9.5,
      color: total.emphasis === 'balance' ? BRAND : INK,
      align: 'right',
    });
    y += rowHeight;
  }
  layout.y += height + 22;
}

function highlight(layout: Layout, doc: CustomerDocumentModel) {
  if (!doc.highlight) return;
  const { page } = layout;
  page.rect(MARGIN, layout.y, CONTENT, 74, { fill: NIGHT, radius: 10 });
  page.text(doc.highlight.label.toUpperCase(), MARGIN + 20, layout.y + 24, {
    font: 'bold',
    size: 8,
    color: [0.7, 0.7, 0.78],
  });
  page.text(formatAed(doc.highlight.amount), MARGIN + 20, layout.y + 54, {
    font: 'bold',
    size: 24,
    color: WHITE,
  });
  if (doc.highlight.caption)
    page.text(doc.highlight.caption, RIGHT - 20, layout.y + 54, {
      size: 9.5,
      color: [0.7, 0.7, 0.78],
      align: 'right',
    });
  layout.y += 94;
}

function fields(
  layout: Layout,
  title: string | null,
  items: { label: string; value: string }[],
  width = CONTENT,
) {
  if (items.length === 0) return;
  if (title) {
    layout.ensure(40);
    layout.page.text(title.toUpperCase(), MARGIN, layout.y + 8, {
      font: 'bold',
      size: 7.5,
      color: MUTED,
    });
    layout.y += 18;
  }
  for (const item of items) {
    const lines = wrapText(item.value, 'regular', 9.5, width - 150);
    const height = lines.length * 12.5 + 10;
    layout.ensure(height);
    layout.page.text(item.label, MARGIN, layout.y + 9, { size: 9.5, color: MUTED });
    lines.forEach((line, index) =>
      layout.page.text(line, MARGIN + 150, layout.y + 9 + index * 12.5, { size: 9.5, color: INK }),
    );
    layout.y += height;
    layout.page.line(MARGIN, layout.y - 3, MARGIN + width, layout.y - 3, {
      color: RULE,
      width: 0.5,
    });
  }
  layout.y += 14;
}

function narrative(layout: Layout, doc: CustomerDocumentModel) {
  for (const block of doc.narrative) {
    const lines = wrapText(block.value, 'regular', 9.5, CONTENT);
    layout.ensure(26 + Math.min(lines.length, 3) * 12.5);
    layout.page.text(block.label.toUpperCase(), MARGIN, layout.y + 8, {
      font: 'bold',
      size: 7.5,
      color: MUTED,
    });
    layout.y += 22;
    for (const line of lines) {
      layout.ensure(12.5);
      layout.page.text(line, MARGIN, layout.y, { size: 9.5, color: INK });
      layout.y += 12.5;
    }
    layout.y += 12;
  }
}

function notes(layout: Layout, doc: CustomerDocumentModel) {
  if (doc.notes.length === 0) return;
  layout.ensure(40);
  layout.page.text('NOTES & TERMS', MARGIN, layout.y + 8, {
    font: 'bold',
    size: 7.5,
    color: MUTED,
  });
  layout.y += 22;
  for (const note of doc.notes) {
    const lines = wrapText(note, 'regular', 8.5, CONTENT - 12);
    layout.ensure(lines.length * 11.5 + 4);
    layout.page.text('•', MARGIN, layout.y, { size: 8.5, color: MUTED });
    lines.forEach((line, index) =>
      layout.page.text(line, MARGIN + 12, layout.y + index * 11.5, { size: 8.5, color: MUTED }),
    );
    layout.y += lines.length * 11.5 + 4;
  }
}

function footers(pdf: PdfDocument, doc: CustomerDocumentModel) {
  const contact = [doc.seller.name, doc.seller.phone, doc.seller.email]
    .filter(Boolean)
    .join('  ·  ');
  pdf.pages.forEach((page, index) => {
    page.line(MARGIN, A4.height - 44, RIGHT, A4.height - 44, { color: RULE, width: 0.6 });
    page.text(contact, MARGIN, A4.height - 30, { size: 8, color: MUTED });
    page.text(`${doc.number}  ·  Page ${index + 1} of ${pdf.pages.length}`, RIGHT, A4.height - 30, {
      size: 8,
      color: MUTED,
      align: 'right',
    });
  });
}

/** Renders the document as PDF bytes. */
export function renderDocumentPdf(doc: CustomerDocumentModel): Buffer {
  const pdf = new PdfDocument({ title: `${doc.title} ${doc.number}`, author: doc.seller.name });
  const first = pdf.addPage();
  let y = header(first, doc);
  y = parties(first, doc, y);
  const layout = new Layout(pdf, first, y);
  highlight(layout, doc);
  narrative(layout, doc);
  if (doc.kind === 'RECEIPT') fields(layout, doc.detailsTitle, doc.details);
  sections(layout, doc);
  totals(layout, doc);
  if (doc.kind !== 'RECEIPT') fields(layout, doc.detailsTitle, doc.details);
  notes(layout, doc);
  footers(pdf, doc);
  return pdf.toBuffer();
}
