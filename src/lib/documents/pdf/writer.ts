/*
 * A deliberately small PDF 1.4 writer for the customer documents: text in
 * the two built-in Helvetica faces (no font files to embed), filled and
 * stroked rectangles, rounded rectangles and lines, on A4 pages. That is all
 * a quotation, invoice or receipt needs, and it keeps PDF generation free of
 * a multi-megabyte dependency.
 *
 * Text is encoded as WinAnsi (Latin-1 plus typographic punctuation), the
 * encoding the built-in fonts support. Characters outside it (for example
 * Arabic script) are replaced with "?" — see sanitizePdfText.
 *
 * Coordinates are in points from the TOP-left of the page; the writer flips
 * them to PDF's bottom-left origin.
 */

export type PdfFont = 'regular' | 'bold';
export type Rgb = readonly [number, number, number];

export const A4 = { width: 595.28, height: 841.89 } as const;

const HELVETICA =
  '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584';
const HELVETICA_BOLD =
  '278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584';

const WIDTHS: Record<PdfFont, number[]> = {
  regular: HELVETICA.split(',').map(Number),
  bold: HELVETICA_BOLD.split(',').map(Number),
};

/** WinAnsi codes for the typographic characters above 127 that documents use. */
const WIN_ANSI_EXTRA: Record<string, { code: number; regular: number; bold: number }> = {
  '€': { code: 128, regular: 556, bold: 556 },
  '…': { code: 133, regular: 1000, bold: 1000 },
  '‘': { code: 145, regular: 222, bold: 278 },
  '’': { code: 146, regular: 222, bold: 278 },
  '“': { code: 147, regular: 333, bold: 500 },
  '”': { code: 148, regular: 333, bold: 500 },
  '•': { code: 149, regular: 350, bold: 350 },
  '–': { code: 150, regular: 556, bold: 556 },
  '—': { code: 151, regular: 1000, bold: 1000 },
  '·': { code: 183, regular: 278, bold: 278 },
  '×': { code: 215, regular: 584, bold: 584 },
  '°': { code: 176, regular: 400, bold: 400 },
};

/** Replaces what the built-in fonts can't draw: non-breaking spaces become spaces, anything outside WinAnsi "?". */
export function sanitizePdfText(text: string): string {
  let out = '';
  for (const char of text.replace(/[  ]/g, ' ')) {
    const code = char.codePointAt(0)!;
    if ((code >= 32 && code <= 126) || (code >= 160 && code <= 255) || WIN_ANSI_EXTRA[char])
      out += char;
    else if (char === '\n' || char === '\t') out += ' ';
    else out += '?';
  }
  return out;
}

function charWidth(char: string, font: PdfFont): number {
  const code = char.codePointAt(0)!;
  if (code >= 32 && code <= 126) return WIDTHS[font][code - 32];
  const extra = WIN_ANSI_EXTRA[char];
  if (extra) return extra[font];
  return 556; // Latin-1 letters: close to the average Helvetica glyph.
}

export function textWidth(text: string, font: PdfFont, size: number): number {
  let units = 0;
  for (const char of sanitizePdfText(text)) units += charWidth(char, font);
  return (units * size) / 1000;
}

/** Word-wraps text to a width; very long words are split so nothing overflows. */
export function wrapText(text: string, font: PdfFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of sanitizePdfText(text.replace(/\r\n/g, '\n')).split('\n')) {
    let current = '';
    for (const word of paragraph.split(/ +/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (textWidth(candidate, font, size) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) lines.push(current);
      current = word;
      while (textWidth(current, font, size) > maxWidth && current.length > 1) {
        let cut = current.length - 1;
        while (cut > 1 && textWidth(current.slice(0, cut), font, size) > maxWidth) cut -= 1;
        lines.push(current.slice(0, cut));
        current = current.slice(cut);
      }
    }
    lines.push(current);
  }
  return lines;
}

function encode(text: string): string {
  let out = '';
  for (const char of sanitizePdfText(text)) {
    const extra = WIN_ANSI_EXTRA[char];
    const code = extra ? extra.code : char.codePointAt(0)!;
    const byte = String.fromCharCode(code);
    out += byte === '\\' || byte === '(' || byte === ')' ? `\\${byte}` : byte;
  }
  return out;
}

const num = (value: number) => (Math.round(value * 100) / 100).toString();
const color = (rgb: Rgb) => rgb.map((c) => num(c)).join(' ');

export interface TextOptions {
  font?: PdfFont;
  size?: number;
  color?: Rgb;
  align?: 'left' | 'right' | 'center';
}

export class PdfPage {
  readonly ops: string[] = [];
  constructor(
    readonly width = A4.width,
    readonly height = A4.height,
  ) {}

  /** Draws one line of text with its baseline at `y` (from the top). */
  text(value: string, x: number, y: number, options: TextOptions = {}) {
    const font = options.font ?? 'regular';
    const size = options.size ?? 10;
    const width = textWidth(value, font, size);
    const left =
      options.align === 'right' ? x - width : options.align === 'center' ? x - width / 2 : x;
    this.ops.push(
      `BT /${font === 'bold' ? 'F2' : 'F1'} ${num(size)} Tf ${color(options.color ?? [0, 0, 0])} rg ${num(left)} ${num(this.height - y)} Td (${encode(value)}) Tj ET`,
    );
    return width;
  }

  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    options: { fill?: Rgb; stroke?: Rgb; lineWidth?: number; radius?: number },
  ) {
    const bottom = this.height - y - h;
    const path = options.radius
      ? roundedPath(x, bottom, w, h, Math.min(options.radius, w / 2, h / 2))
      : `${num(x)} ${num(bottom)} ${num(w)} ${num(h)} re`;
    const paint = options.fill && options.stroke ? 'B' : options.fill ? 'f' : 'S';
    this.ops.push(
      `q ${options.fill ? `${color(options.fill)} rg ` : ''}${options.stroke ? `${color(options.stroke)} RG ${num(options.lineWidth ?? 0.75)} w ` : ''}${path} ${paint} Q`,
    );
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    options: { color?: Rgb; width?: number } = {},
  ) {
    this.ops.push(
      `q ${color(options.color ?? [0, 0, 0])} RG ${num(options.width ?? 0.75)} w ${num(x1)} ${num(this.height - y1)} m ${num(x2)} ${num(this.height - y2)} l S Q`,
    );
  }
}

function roundedPath(x: number, y: number, w: number, h: number, r: number) {
  const k = r * 0.5523;
  return [
    `${num(x + r)} ${num(y)} m`,
    `${num(x + w - r)} ${num(y)} l`,
    `${num(x + w - r + k)} ${num(y)} ${num(x + w)} ${num(y + r - k)} ${num(x + w)} ${num(y + r)} c`,
    `${num(x + w)} ${num(y + h - r)} l`,
    `${num(x + w)} ${num(y + h - r + k)} ${num(x + w - r + k)} ${num(y + h)} ${num(x + w - r)} ${num(y + h)} c`,
    `${num(x + r)} ${num(y + h)} l`,
    `${num(x + r - k)} ${num(y + h)} ${num(x)} ${num(y + h - r + k)} ${num(x)} ${num(y + h - r)} c`,
    `${num(x)} ${num(y + r)} l`,
    `${num(x)} ${num(y + r - k)} ${num(x + r - k)} ${num(y)} ${num(x + r)} ${num(y)} c h`,
  ].join(' ');
}

export class PdfDocument {
  readonly pages: PdfPage[] = [];
  constructor(private readonly info: { title: string; author: string }) {}

  addPage(): PdfPage {
    const page = new PdfPage();
    this.pages.push(page);
    return page;
  }

  /** Serializes the document: objects, cross-reference table and trailer. */
  toBuffer(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body); // returns the 1-based object number
    const catalog = add('');
    const pagesObj = add('');
    const regular = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    );
    const bold = add(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    );
    const pageRefs: number[] = [];
    for (const page of this.pages) {
      const content = page.ops.join('\n');
      const stream = add(
        `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
      );
      pageRefs.push(
        add(
          `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${stream} 0 R >>`,
        ),
      );
    }
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
    objects[pagesObj - 1] =
      `<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
    const infoObj = add(
      `<< /Title (${encode(this.info.title)}) /Author (${encode(this.info.author)}) /Producer (${encode(this.info.author)}) >>`,
    );

    let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((object, index) => {
      offsets.push(Buffer.byteLength(body, 'latin1'));
      body += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = Buffer.byteLength(body, 'latin1');
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
    body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(body, 'latin1');
  }
}
