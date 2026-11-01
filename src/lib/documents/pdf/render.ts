import { aedInWords } from '@/lib/documents/amount-words';
import {
  A4,
  PdfDocument,
  type PathSegment,
  type PdfPage,
  type Rgb,
  textWidth,
  wrapText,
} from '@/lib/documents/pdf/writer';
import {
  formatAed,
  formatAmount,
  formatQuantity,
  formatRate,
  hasLineDiscounts,
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
 * totals already say "VAT 5%" — and a Discount column only when a line has
 * a discount. Numeric columns give their right edge. The currency is in the
 * headings, not on every line, which leaves the description the room.
 */
interface Columns {
  no: number;
  type: number;
  desc: number;
  qty: number;
  price: number;
  vat: number | null;
  discount: number | null;
  amount: number;
  descWidth: number;
}

function columns(withVat: boolean, withDiscount: boolean): Columns {
  const base = { no: MARGIN + 30, type: MARGIN + 40, desc: MARGIN + 92, amount: RIGHT - 12 };
  const numeric =
    withVat && withDiscount
      ? { qty: MARGIN + 280, price: MARGIN + 335, vat: MARGIN + 368, discount: MARGIN + 425 }
      : withDiscount
        ? { qty: MARGIN + 290, price: MARGIN + 345, vat: null, discount: MARGIN + 420 }
        : withVat
          ? { qty: MARGIN + 335, price: MARGIN + 390, vat: MARGIN + 425, discount: null }
          : { qty: MARGIN + 365, price: MARGIN + 420, vat: null, discount: null };
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

  /*
   * The title keeps the right-hand side (shrunk a little if it is long); the
   * workshop's name has what is left of the line and wraps to a second line
   * rather than running under the title.
   */
  const title = doc.title.toUpperCase();
  let titleSize = 19;
  while (titleSize > 13 && textWidth(title, 'bold', titleSize) > CONTENT * 0.45) titleSize -= 0.5;
  const nameLeft = MARGIN + 46;
  const nameWidth = RIGHT - textWidth(title, 'bold', titleSize) - 18 - nameLeft;
  let nameSize = 15;
  let nameLines = wrapText(doc.seller.name, 'bold', nameSize, nameWidth);
  if (nameLines.length > 2) {
    nameSize = 12.5;
    nameLines = wrapText(doc.seller.name, 'bold', nameSize, nameWidth);
  }
  const nameStep = nameSize + 3;
  nameLines.forEach((line, index) =>
    page.text(line, nameLeft, 48 + index * nameStep, { font: 'bold', size: nameSize, color: INK }),
  );
  const taglineY = 48 + (nameLines.length - 1) * nameStep + 14;
  page.text('Automotive workshop', nameLeft, taglineY, { size: 8.5, color: MUTED });

  let y = Math.max(88, taglineY + 26);
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

  page.text(title, RIGHT, 48, {
    font: 'bold',
    size: titleSize,
    color: BRAND,
    align: 'right',
  });
  page.text(doc.number, RIGHT, 66, { font: 'bold', size: 11, color: INK, align: 'right' });
  if (doc.status) pill(page, doc.status.label, doc.status.tone, RIGHT, 76);

  let metaY = 112;
  for (const field of doc.meta) {
    const labelRight = RIGHT - Math.max(120, textWidth(field.value, 'bold', 8.5) + 12);
    page.text(field.label, labelRight, metaY, { size: 8.5, color: MUTED, align: 'right' });
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
      title:
        doc.kind === 'QUOTATION'
          ? 'Prepared for'
          : doc.kind === 'JOB_CARD'
            ? 'Customer'
            : doc.kind === 'PAYMENT_VOUCHER'
              ? 'Paid to'
              : 'Billed to',
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
  page.text('PRICE (AED)', col.price, y, { ...style, align: 'right' });
  if (col.vat !== null) page.text('VAT', col.vat, y, { ...style, align: 'right' });
  if (col.discount !== null) {
    // Beside a VAT column there is room only for the short form.
    const heading = col.vat !== null ? 'DISC. (AED)' : 'DISCOUNT (AED)';
    page.text(heading, col.discount, y, { ...style, align: 'right' });
  }
  page.text('AMOUNT (AED)', col.amount, y, { ...style, align: 'right' });
  layout.y += 30;
}

function sections(layout: Layout, doc: CustomerDocumentModel) {
  if (doc.sections.length === 0) return;
  const col = columns(hasMixedVatRates(doc.sections), hasLineDiscounts(doc.sections));
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
      if (line.type)
        page.text(line.type, col.type, base, { font: 'bold', size: 7.5, color: MUTED });
      description.forEach((text, index) =>
        page.text(text, col.desc, base + index * 12.5, { size: 9.5, color: INK }),
      );
      page.text(formatQuantity(line.quantity), col.qty, base, {
        size: 9.5,
        color: INK,
        align: 'right',
      });
      page.text(formatAmount(line.unitPrice), col.price, base, {
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
      if (col.discount !== null && line.discount !== null) {
        page.text(`-${formatAmount(line.discount)}`, col.discount, base, {
          size: 9.5,
          color: MUTED,
          align: 'right',
        });
      }
      page.text(formatAmount(line.lineTotal), col.amount, base, {
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

/*
 * The job card sheet: no prices and no quotation — the customer's complaint,
 * the vehicle diagram to mark damage on at check-in, a box for the workshop
 * supervisor's comments, and signatures. Boxes print what was typed, then
 * ruled lines to write on by hand.
 */
const BOX_LINE = 16;

function writingBox(layout: Layout, title: string, text: string, minLines: number) {
  const lines = text.trim() ? wrapText(text.trim(), 'regular', 9.5, CONTENT - 28) : [];
  const ruled = Math.max(0, minLines - lines.length);
  const height = 24 + (lines.length + ruled) * BOX_LINE + 8;
  layout.ensure(height + 12);
  const { page } = layout;
  const top = layout.y;
  page.rect(MARGIN, top, CONTENT, height, { stroke: RULE, radius: 8 });
  page.text(title.toUpperCase(), MARGIN + 14, top + 17, { font: 'bold', size: 7.5, color: MUTED });
  lines.forEach((line, index) =>
    page.text(line, MARGIN + 14, top + 24 + index * BOX_LINE + 11, { size: 9.5, color: INK }),
  );
  for (let index = lines.length; index < lines.length + ruled; index += 1) {
    const y = top + 24 + (index + 1) * BOX_LINE - 1;
    page.line(MARGIN + 14, y, RIGHT - 14, y, { color: RULE, width: 0.6 });
  }
  layout.y += height + 12;
}

/*
 * Vehicle outlines, drawn in their own design units (y down) and scaled into
 * place. Each view is drawn as you'd see it standing beside the car: the
 * side profile faces right as drawn — the car's right side — and mirrored it
 * is the left side; the top view has the nose to the right; front and rear
 * are seen face on.
 */
const GLASS: Rgb = [0.925, 0.941, 0.965];
const TYRE: Rgb = [0.78, 0.8, 0.835];

/** The same outline flipped left to right within `width`. */
function mirrorX(segments: PathSegment[], width: number): PathSegment[] {
  return segments.map((seg): PathSegment => {
    if (seg[0] === 'Z') return seg;
    if (seg[0] === 'C')
      return ['C', width - seg[1], seg[2], width - seg[3], seg[4], width - seg[5], seg[6]];
    return [seg[0], width - seg[1], seg[2]];
  });
}

const SIDE_W = 200;
const SIDE_H = 64;
/** Saloon profile, nose right, with the wheel arches cut out of the sill. */
const SIDE_BODY: PathSegment[] = [
  ['M', 8, 51],
  ['C', 4.5, 51, 3, 48.5, 3, 45],
  ['L', 3, 33],
  ['C', 3, 29.5, 5, 27.2, 9, 26.8],
  ['L', 44, 24.5],
  ['C', 52, 17, 61, 10.5, 72, 8.6],
  ['C', 88, 6, 108, 6, 120, 7.6],
  ['C', 130, 9, 140, 17, 150, 24],
  ['C', 168, 26, 184, 28.5, 192, 31],
  ['C', 196, 32.2, 198, 35, 198, 39],
  ['L', 198, 46],
  ['C', 198, 49, 196, 51, 192, 51],
  ['L', 172, 51],
  ['C', 172, 43.27, 165.73, 37, 158, 37],
  ['C', 150.27, 37, 144, 43.27, 144, 51],
  ['L', 60, 51],
  ['C', 60, 43.27, 53.73, 37, 46, 37],
  ['C', 38.27, 37, 32, 43.27, 32, 51],
  ['Z'],
];
const SIDE_GLASS: PathSegment[] = [
  ['M', 57, 23.6],
  ['C', 63, 16.5, 70, 12.2, 78, 11.2],
  ['C', 92, 9.8, 108, 9.8, 117, 11],
  ['C', 124, 12, 132, 17.6, 140, 23.6],
  ['Z'],
];
const SIDE_HEADLIGHT: PathSegment[] = [
  ['M', 185, 30.4],
  ['L', 195.4, 32.8],
  ['C', 196.8, 34, 197, 35.4, 196.2, 36.4],
  ['L', 187, 35.2],
  ['Z'],
];
const SIDE_MIRROR: PathSegment[] = [
  ['M', 139.5, 23.5],
  ['L', 141, 19.2],
  ['C', 143.5, 18.6, 146.5, 19, 147.6, 20.4],
  ['L', 146.4, 24.6],
  ['Z'],
];

const TOP_W = 200;
const TOP_H = 86;
const TOP_BODY: PathSegment[] = [
  ['M', 30, 9],
  ['L', 160, 9],
  ['C', 180, 9, 192, 14, 195, 26],
  ['C', 197, 35, 197, 51, 195, 60],
  ['C', 192, 72, 180, 77, 160, 77],
  ['L', 30, 77],
  ['C', 14, 77, 6, 72, 5, 60],
  ['C', 3.5, 50, 3.5, 36, 5, 26],
  ['C', 6, 14, 14, 9, 30, 9],
  ['Z'],
];
const TOP_WINDSCREEN: PathSegment[] = [
  ['M', 121, 15.5],
  ['L', 140, 13.5],
  ['C', 145.5, 30, 145.5, 56, 140, 72.5],
  ['L', 121, 70.5],
  ['C', 124, 56, 124, 30, 121, 15.5],
  ['Z'],
];
const TOP_REAR_GLASS: PathSegment[] = [
  ['M', 73, 15.5],
  ['L', 58, 17.5],
  ['C', 54, 32, 54, 54, 58, 68.5],
  ['L', 73, 70.5],
  ['C', 71, 56, 71, 30, 73, 15.5],
  ['Z'],
];
const TOP_BONNET: PathSegment[] = [
  ['M', 146, 14],
  ['L', 181, 16.5],
  ['C', 187.5, 30, 187.5, 56, 181, 69.5],
  ['L', 146, 72],
];
const TOP_BOOT: PathSegment[] = [
  ['M', 53, 18.5],
  ['L', 20, 20],
  ['C', 16, 31, 16, 55, 20, 66],
  ['L', 53, 67.5],
];
const TOP_MIRROR: PathSegment[] = [
  ['M', 132, 9.5],
  ['L', 134, 3],
  ['C', 137, 2.4, 140, 2.6, 141.5, 3.6],
  ['L', 140.5, 9.5],
  ['Z'],
];

const END_W = 100;
const END_H = 66;
/** Front or rear silhouette: body, cabin and shoulders. */
const END_BODY: PathSegment[] = [
  ['M', 12, 60],
  ['C', 9.5, 60, 8, 58.5, 8, 56],
  ['L', 8, 38],
  ['C', 8, 33, 10, 30, 15, 28.5],
  ['L', 24, 12],
  ['C', 26, 8, 29, 6.5, 34, 6.5],
  ['L', 66, 6.5],
  ['C', 71, 6.5, 74, 8, 76, 12],
  ['L', 85, 28.5],
  ['C', 90, 30, 92, 33, 92, 38],
  ['L', 92, 56],
  ['C', 92, 58.5, 90.5, 60, 88, 60],
  ['Z'],
];
const END_MIRROR: PathSegment[] = [
  ['M', 15, 24],
  ['L', 5.5, 22.2],
  ['C', 3.6, 22, 2.6, 23, 2.6, 24.8],
  ['L', 3, 27.6],
  ['C', 3.4, 29, 4.6, 29.6, 6.2, 29.6],
  ['L', 15, 29.2],
  ['Z'],
];
const FRONT_GLASS: PathSegment[] = [
  ['M', 28.5, 12.5],
  ['L', 71.5, 12.5],
  ['L', 80, 27],
  ['L', 20, 27],
  ['Z'],
];
const HEADLIGHT: PathSegment[] = [
  ['M', 11, 34],
  ['L', 28, 36.2],
  ['L', 27, 41],
  ['L', 12.5, 40.2],
  ['C', 11.2, 40, 10.8, 39.4, 10.8, 38.4],
  ['Z'],
];
const REAR_GLASS: PathSegment[] = [
  ['M', 29.5, 13],
  ['L', 70.5, 13],
  ['L', 77.5, 26],
  ['L', 22.5, 26],
  ['Z'],
];
const TAIL_LIGHT: PathSegment[] = [
  ['M', 9.5, 33],
  ['L', 28, 34],
  ['L', 28, 40.5],
  ['L', 10, 39.6],
  ['C', 9.6, 39.5, 9.5, 39.2, 9.5, 38.8],
  ['Z'],
];

/** Scales design units to the page: `x`, `y` is the view's top-left, `s` its scale. */
function placer(page: PdfPage, x: number, y: number, s: number, mirrorWidth?: number) {
  const px = (dx: number) => x + (mirrorWidth ? mirrorWidth - dx : dx) * s;
  const py = (dy: number) => y + dy * s;
  return {
    /** The body outline: inked, filled white so it covers what's drawn behind it. */
    body: { stroke: INK, fill: WHITE, lineWidth: 1 },
    /** Glass, lamps and other details inside the body. */
    detail: { stroke: MUTED, lineWidth: 0.6 },
    shape(segments: PathSegment[], options: { fill?: Rgb; stroke?: Rgb; lineWidth?: number }) {
      page.path(
        segments.map((seg): PathSegment => {
          if (seg[0] === 'Z') return seg;
          if (seg[0] === 'C')
            return ['C', px(seg[1]), py(seg[2]), px(seg[3]), py(seg[4]), px(seg[5]), py(seg[6])];
          return [seg[0], px(seg[1]), py(seg[2])];
        }),
        options,
      );
    },
    box(dx: number, dy: number, w: number, h: number, options: Parameters<PdfPage['rect']>[4]) {
      const left = mirrorWidth ? px(dx + w) : px(dx);
      page.rect(left, py(dy), w * s, h * s, { ...options, radius: (options.radius ?? 0) * s });
    },
    circle(
      cx: number,
      cy: number,
      r: number,
      options: { fill?: Rgb; stroke?: Rgb; lineWidth?: number },
    ) {
      page.rect(px(cx) - r * s, py(cy) - r * s, 2 * r * s, 2 * r * s, {
        lineWidth: 0.6,
        ...options,
        radius: r * s,
      });
    },
    line(x1: number, y1: number, x2: number, y2: number, color: Rgb = MUTED) {
      page.line(px(x1), py(y1), px(x2), py(y2), { color, width: 0.6 });
    },
  };
}

/** A side profile; `mirrored` turns the nose to the left — the car's left side. */
function sideView(page: PdfPage, x: number, y: number, s: number, mirrored: boolean) {
  const v = placer(page, x, y, s, mirrored ? SIDE_W : undefined);
  v.line(-2, 62.5, 202, 62.5, RULE);
  v.shape(SIDE_BODY, v.body);
  v.shape(SIDE_GLASS, { ...v.detail, fill: GLASS });
  v.box(99, 10.2, 3, 13.6, { fill: WHITE, stroke: MUTED, lineWidth: 0.6 });
  // Shoulder crease, sill, and the door shut lines.
  v.line(10, 30.5, 182, 33.2);
  v.line(61, 47.5, 143, 47.5);
  v.line(140.5, 24, 141.5, 50.5);
  v.line(100.5, 24, 100.5, 50.5);
  v.line(59, 24.5, 61.5, 50.5);
  v.box(86, 28.6, 8, 2.4, { stroke: MUTED, lineWidth: 0.6, radius: 1.2 });
  v.box(126, 28.6, 8, 2.4, { stroke: MUTED, lineWidth: 0.6, radius: 1.2 });
  // Bumpers, lamps and mirror.
  v.line(3, 40.5, 30, 40.5);
  v.line(174, 41, 198, 41);
  v.shape(SIDE_HEADLIGHT, { ...v.detail, fill: GLASS });
  v.box(3.2, 28.2, 6, 5.2, { stroke: MUTED, lineWidth: 0.6, radius: 1 });
  v.shape(SIDE_MIRROR, { ...v.body, lineWidth: 0.8 });
  for (const cx of [46, 158]) {
    v.circle(cx, 51, 11, { stroke: INK, fill: TYRE, lineWidth: 0.9 });
    v.circle(cx, 51, 7, { stroke: MUTED, fill: WHITE });
    v.circle(cx, 51, 2.2, { stroke: MUTED });
  }
}

/** Seen from above, nose to the right. */
function topView(page: PdfPage, x: number, y: number, s: number) {
  const v = placer(page, x, y, s);
  for (const wx of [34, 146]) {
    v.box(wx, 4.5, 24, 6, { fill: TYRE, stroke: INK, lineWidth: 0.7, radius: 2 });
    v.box(wx, 75.5, 24, 6, { fill: TYRE, stroke: INK, lineWidth: 0.7, radius: 2 });
  }
  v.shape(TOP_MIRROR, { ...v.body, lineWidth: 0.8 });
  v.shape(
    TOP_MIRROR.map((seg): PathSegment =>
      seg[0] === 'Z'
        ? seg
        : seg[0] === 'C'
          ? ['C', seg[1], TOP_H - seg[2], seg[3], TOP_H - seg[4], seg[5], TOP_H - seg[6]]
          : [seg[0], seg[1], TOP_H - seg[2]],
    ),
    { ...v.body, lineWidth: 0.8 },
  );
  v.shape(TOP_BODY, v.body);
  v.shape(TOP_WINDSCREEN, { ...v.detail, fill: GLASS });
  v.shape(TOP_REAR_GLASS, { ...v.detail, fill: GLASS });
  v.box(76, 18, 42, 50, { stroke: MUTED, lineWidth: 0.6, radius: 5 });
  v.shape(TOP_BONNET, v.detail);
  v.shape(TOP_BOOT, v.detail);
  v.line(150, 30, 178, 31.5);
  v.line(150, 56, 178, 54.5);
  v.box(184, 15, 8, 6, { stroke: MUTED, lineWidth: 0.6, radius: 2 });
  v.box(184, 65, 8, 6, { stroke: MUTED, lineWidth: 0.6, radius: 2 });
  v.box(6.5, 22, 3.5, 8, { stroke: MUTED, lineWidth: 0.6, radius: 1 });
  v.box(6.5, 56, 3.5, 8, { stroke: MUTED, lineWidth: 0.6, radius: 1 });
}

/** Seen face on from the front, or from behind. */
function endView(page: PdfPage, x: number, y: number, s: number, front: boolean) {
  const v = placer(page, x, y, s);
  v.line(2, 66.5, 98, 66.5, RULE);
  v.box(12, 52, 15, 14, { fill: TYRE, stroke: INK, lineWidth: 0.8, radius: 3 });
  v.box(73, 52, 15, 14, { fill: TYRE, stroke: INK, lineWidth: 0.8, radius: 3 });
  v.shape(END_MIRROR, { ...v.body, lineWidth: 0.8 });
  v.shape(mirrorX(END_MIRROR, END_W), { ...v.body, lineWidth: 0.8 });
  v.shape(END_BODY, v.body);
  v.line(16, 31, 84, 31);
  v.line(10, 46.5, 90, 46.5);
  if (front) {
    v.shape(FRONT_GLASS, { ...v.detail, fill: GLASS });
    v.line(31, 25.5, 47, 23);
    v.line(53, 25.5, 69, 23);
    v.shape(HEADLIGHT, { ...v.detail, fill: GLASS });
    v.shape(mirrorX(HEADLIGHT, END_W), { ...v.detail, fill: GLASS });
    v.box(32, 35, 36, 9.5, { stroke: MUTED, lineWidth: 0.6, radius: 2 });
    v.line(34, 38.2, 66, 38.2);
    v.line(34, 41.4, 66, 41.4);
    v.box(38, 49, 24, 7, { stroke: MUTED, lineWidth: 0.6, radius: 1 });
    v.circle(18, 52.5, 2, { stroke: MUTED });
    v.circle(82, 52.5, 2, { stroke: MUTED });
  } else {
    v.shape(REAR_GLASS, { ...v.detail, fill: GLASS });
    v.shape(TAIL_LIGHT, v.detail);
    v.shape(mirrorX(TAIL_LIGHT, END_W), v.detail);
    v.box(38, 35.5, 24, 8, { stroke: MUTED, lineWidth: 0.6, radius: 1 });
    v.box(12, 50, 9, 2.6, { stroke: MUTED, lineWidth: 0.6, radius: 1 });
    v.box(79, 50, 9, 2.6, { stroke: MUTED, lineWidth: 0.6, radius: 1 });
    v.box(66, 54.6, 9, 3.6, { stroke: MUTED, lineWidth: 0.6, radius: 1.8 });
  }
}

/** A damage code as drawn on the car: the letter in a ring. Returns its width. */
function damageCode(page: PdfPage, letter: string, x: number, baseline: number) {
  page.rect(x, baseline - 7.6, 10, 10, { stroke: MUTED, lineWidth: 0.7, radius: 5 });
  page.text(letter, x + 5, baseline - 0.2, {
    font: 'bold',
    size: 6.5,
    color: INK,
    align: 'center',
  });
  return 10;
}

/** A box to tick, with its label. Returns the width taken. */
function tickBox(page: PdfPage, label: string, x: number, baseline: number) {
  page.rect(x, baseline - 7, 7.5, 7.5, { stroke: MUTED, lineWidth: 0.7, radius: 1.5 });
  page.text(label, x + 11, baseline, { size: 7.5, color: INK });
  return 11 + textWidth(label, 'regular', 7.5);
}

const DAMAGE_CODES = [
  ['S', 'Scratch'],
  ['D', 'Dent'],
  ['C', 'Crack'],
  ['B', 'Broken'],
] as const;
const FUEL_LEVELS = ['E', '¼', '½', '¾', 'F'];
const LOOSE_ITEMS = ['Spare tyre', 'Jack & tools', 'Floor mats', 'Audio'];

/**
 * The vehicle condition panel: right and left sides, top, front and rear to
 * mark damage on, the damage codes, and a row to tick the fuel level and
 * what's in the car at check-in.
 */
function vehicleDiagram(layout: Layout) {
  const height = 214;
  layout.ensure(height + 12);
  const { page } = layout;
  const top = layout.y;
  const left = MARGIN + 14;
  const inner = CONTENT - 28;
  page.rect(MARGIN, top, CONTENT, height, { stroke: RULE, radius: 8 });
  page.text('VEHICLE CONDITION', left, top + 17, { font: 'bold', size: 7.5, color: MUTED });

  // The damage codes, set right to left from the panel's edge.
  let keyX = RIGHT - 14;
  for (const [letter, word] of [...DAMAGE_CODES].reverse()) {
    keyX -= textWidth(word, 'regular', 7.5);
    page.text(word, keyX, top + 17, { size: 7.5, color: MUTED });
    keyX -= 13;
    damageCode(page, letter, keyX, top + 17);
    keyX -= 10;
  }
  page.text('Mark damage', keyX, top + 17, { size: 7.5, color: MUTED, align: 'right' });

  const side = 0.88;
  const plan = 0.86;
  const end = 0.8;
  const gap = (inner - SIDE_W * side - TOP_W * plan - END_W * end) / 2;
  const colA = left;
  const colB = colA + SIDE_W * side + gap;
  const colC = colB + TOP_W * plan + gap;
  const rowOne = top + 30;
  const rowTwo = top + 106;
  const labelOffset = SIDE_H * side + 10;
  const label = (text: string, x: number, width: number, y: number) =>
    page.text(text, x + width / 2, y, { font: 'bold', size: 7, color: MUTED, align: 'center' });

  sideView(page, colA, rowOne, side, true);
  label('LEFT SIDE', colA, SIDE_W * side, rowOne + labelOffset);
  sideView(page, colA, rowTwo, side, false);
  label('RIGHT SIDE', colA, SIDE_W * side, rowTwo + labelOffset);

  const planHeight = TOP_H * plan + 14;
  const planY = rowOne + (rowTwo + labelOffset - rowOne - planHeight) / 2;
  topView(page, colB, planY, plan);
  label('TOP', colB, TOP_W * plan, planY + planHeight);

  // Front and rear: seen face on, so the car's sides swap over between them.
  const endY = (row: number) => row + SIDE_H * side - END_H * end;
  const sides = (row: number, near: string, far: string) => {
    page.text(near, colC + 2, row + labelOffset, { size: 6.5, color: MUTED });
    page.text(far, colC + END_W * end - 2, row + labelOffset, {
      size: 6.5,
      color: MUTED,
      align: 'right',
    });
  };
  endView(page, colC, endY(rowOne), end, true);
  label('FRONT', colC, END_W * end, rowOne + labelOffset);
  sides(rowOne, 'R', 'L');
  endView(page, colC, endY(rowTwo), end, false);
  label('REAR', colC, END_W * end, rowTwo + labelOffset);
  sides(rowTwo, 'L', 'R');

  // Check-in row: fuel level on the left, what's in the car on the right.
  const rule = top + height - 32;
  page.line(left, rule, RIGHT - 14, rule, { color: RULE, width: 0.6 });
  const baseline = rule + 19;
  page.text('FUEL', left, baseline, { font: 'bold', size: 7, color: MUTED });
  let x = left + 26;
  for (const level of FUEL_LEVELS) x += tickBox(page, level, x, baseline) + 9;

  const itemsWidth =
    LOOSE_ITEMS.reduce((sum, item) => sum + 11 + textWidth(item, 'regular', 7.5), 0) +
    (LOOSE_ITEMS.length - 1) * 11;
  x = RIGHT - 14 - itemsWidth;
  page.text('IN THE CAR', x - 8, baseline, { font: 'bold', size: 7, color: MUTED, align: 'right' });
  for (const item of LOOSE_ITEMS) x += tickBox(page, item, x, baseline) + 11;

  layout.y += height + 12;
}

function jobCardBody(layout: Layout, doc: CustomerDocumentModel) {
  doc.narrative.forEach((block, index) =>
    writingBox(layout, block.label, block.value, index === 0 ? 3 : 0),
  );
  vehicleDiagram(layout);
  writingBox(layout, 'Workshop supervisor comments', '', 4);
}

/** A job card: the customer hands the vehicle over, the workshop takes it in. */
const JOB_CARD_SIGNATURES = [
  { title: 'Customer', caption: 'I hand over the vehicle in the condition marked above.' },
  { title: 'For the workshop', caption: 'Vehicle received by' },
];

/** A payment voucher: the payee received the money, the workshop paid it. */
const VOUCHER_SIGNATURES = [
  { title: 'Received by', caption: 'I received the amount above in full.' },
  { title: 'For the workshop', caption: 'Paid and approved by' },
];

/** Two signature boxes side by side. */
function signatures(layout: Layout, boxes = JOB_CARD_SIGNATURES) {
  const height = 64;
  layout.ensure(height);
  const half = (CONTENT - 12) / 2;
  boxes.forEach((box, index) => {
    const x = MARGIN + index * (half + 12);
    const { page } = layout;
    page.rect(x, layout.y, half, height, { stroke: RULE, radius: 8 });
    page.text(box.title.toUpperCase(), x + 14, layout.y + 16, {
      font: 'bold',
      size: 7.5,
      color: MUTED,
    });
    page.text(box.caption, x + 14, layout.y + 28, { size: 8, color: MUTED });
    page.line(x + 14, layout.y + 49, x + half - 90, layout.y + 49, { color: MUTED, width: 0.6 });
    page.text('Signature', x + 14, layout.y + 58, { size: 7, color: MUTED });
    page.line(x + half - 80, layout.y + 49, x + half - 14, layout.y + 49, {
      color: MUTED,
      width: 0.6,
    });
    page.text('Date', x + half - 80, layout.y + 58, { size: 7, color: MUTED });
  });
  layout.y += height + 20;
}

function totals(layout: Layout, doc: CustomerDocumentModel) {
  if (doc.totals.length === 0) return;
  const rowHeight = 18;
  const left = RIGHT - 230;
  // Beside the totals: the amount payable in words, and the document's currency.
  const payable = doc.totals.find((total) => total.emphasis === 'total')?.amount;
  const words =
    payable && !payable.startsWith('-')
      ? wrapText(aedInWords(payable), 'regular', 9, left - MARGIN - 16)
      : [];
  const wordsHeight = (words.length ? 24 + words.length * 12 : 0) + 14;
  const boxHeight = doc.totals.length * rowHeight + 20;
  const height = Math.max(boxHeight, wordsHeight);
  layout.ensure(height + 10);
  const { page } = layout;
  let wordsY = layout.y + 12;
  if (words.length) {
    page.text('AMOUNT IN WORDS', MARGIN, wordsY, { font: 'bold', size: 7.5, color: MUTED });
    wordsY += 14;
    for (const line of words) {
      page.text(line, MARGIN, wordsY, { size: 9, color: INK });
      wordsY += 12;
    }
    wordsY += 4;
  }
  page.text('All amounts are in UAE Dirhams (AED).', MARGIN, wordsY, { size: 8, color: MUTED });
  page.rect(left, layout.y, 230, boxHeight, { fill: SOFT, radius: 8 });
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
    // The amount payable says its currency; the rows adding up to it needn't.
    page.text(strong ? formatAed(total.amount) : formatAmount(total.amount), RIGHT - 14, y, {
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
  if (doc.kind === 'JOB_CARD') {
    jobCardBody(layout, doc);
    notes(layout, doc);
    signatures(layout);
  } else {
    // A receipt or voucher is about one payment: its details come first.
    const paymentFirst = doc.kind === 'RECEIPT' || doc.kind === 'PAYMENT_VOUCHER';
    highlight(layout, doc);
    narrative(layout, doc);
    if (paymentFirst) fields(layout, doc.detailsTitle, doc.details);
    sections(layout, doc);
    totals(layout, doc);
    if (!paymentFirst) fields(layout, doc.detailsTitle, doc.details);
    notes(layout, doc);
    if (doc.kind === 'PAYMENT_VOUCHER') signatures(layout, VOUCHER_SIGNATURES);
  }
  footers(pdf, doc);
  return pdf.toBuffer();
}
