import { z } from 'zod';

/*
 * Reading a bank or card statement file.
 *
 * Every bank lays its download out its own way: a few lines about the account
 * before the headings, dates written 13/10/2026 or 13-Oct-2026, money in and
 * money out in two columns or one amount with a Dr/Cr beside it, newest line
 * first or last. Which heading holds what is chosen once per account (and
 * guessed the first time); the file is then read the same way every month.
 *
 * Headings are kept by name, not position, so a bank adding a column doesn't
 * break the reading. Amounts are read into fils, money in positive.
 *
 * Pure: used by the upload screen to preview the file, and by the server to
 * read it again, the same way, before anything is saved.
 */

export const AMOUNT_LAYOUTS = ['split', 'signed', 'flagged'] as const;
export type AmountLayout = (typeof AMOUNT_LAYOUTS)[number];

export const DATE_ORDERS = ['DMY', 'MDY', 'YMD'] as const;
export type DateOrder = (typeof DATE_ORDERS)[number];

const heading = z.string().trim().max(200);

/** How one account's statement files are read. */
export const statementColumnsSchema = z.object({
  date: heading.min(1, 'Choose the date column.'),
  /** One or more headings, joined: some banks split the narrative. */
  description: z.array(heading.min(1)).max(4),
  reference: heading.nullable(),
  layout: z.enum(AMOUNT_LAYOUTS),
  /** split: money in and money out in two columns. */
  moneyIn: heading.nullable(),
  moneyOut: heading.nullable(),
  /** signed: one amount, minus for money out. flagged: with a Dr/Cr column. */
  amount: heading.nullable(),
  flag: heading.nullable(),
  balance: heading.nullable(),
  dateOrder: z.enum(DATE_ORDERS),
});

export type StatementColumns = z.infer<typeof statementColumnsSchema>;

/** Columns remembered on an account, or null if what is stored no longer reads. */
export function savedColumns(value: unknown): StatementColumns | null {
  const parsed = statementColumnsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface StatementFileLine {
  /** Its row in the file, counting from 1, for messages. */
  row: number;
  /** YYYY-MM-DD. */
  date: string;
  description: string;
  reference: string | null;
  /** Fils: money in positive, money out negative. */
  amountFils: number;
  /** The running balance after it, in fils, when the file shows one. */
  balanceFils: number | null;
}

export interface StatementRead {
  /** The row holding the headings (from 0), or -1 if none was found. */
  headerRow: number;
  headings: string[];
  /** Oldest first. */
  lines: StatementFileLine[];
  problems: { row: number; message: string }[];
  /** The balance before the first line, and after the last, when known. */
  openingFils: number | null;
  closingFils: number | null;
  from: string | null;
  to: string | null;
  /** Lines whose running balance does not follow from the one before. */
  balanceBreaks: number;
}

const clean = (text: string | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();
const same = (a: string, b: string) => clean(a).toLowerCase() === clean(b).toLowerCase();

/** How far down a file the headings may be. */
const HEADER_SEARCH = 40;

/** The first row holding every one of these headings. */
function rowWithHeadings(grid: string[][], names: string[]) {
  const wanted = names.filter(Boolean);
  for (let row = 0; row < Math.min(grid.length, HEADER_SEARCH); row += 1) {
    if (wanted.every((name) => grid[row].some((cell) => same(cell, name)))) return row;
  }
  return -1;
}

/** Every heading the columns name. */
export function columnHeadings(columns: StatementColumns) {
  const named = [
    columns.date,
    ...columns.description,
    columns.reference,
    columns.balance,
    ...(columns.layout === 'split' ? [columns.moneyIn, columns.moneyOut] : [columns.amount]),
    columns.layout === 'flagged' ? columns.flag : null,
  ];
  return named.filter((name): name is string => Boolean(name));
}

/** Whether a file has the headings these columns read. */
export function columnsFit(grid: string[][], columns: StatementColumns) {
  return rowWithHeadings(grid, columnHeadings(columns)) >= 0;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * A statement date as YYYY-MM-DD: 13/10/2026, 13-10-26, 13.10.2026,
 * 2026-10-13, 13-Oct-2026, 13 October 2026, Oct 13, 2026 — with any time
 * after it ignored. Numbers alone are read in the order given.
 */
export function parseStatementDate(text: string, order: DateOrder): string | null {
  const value = clean(text).replace(/[T\s]\d{1,2}:\d{2}(:\d{2})?(\s?[ap]m)?$/i, '');
  const named = /^(\d{1,2})[\s\-/.]*([a-z]{3,9})[\s\-/.,]*(\d{2,4})$/i.exec(value);
  if (named) {
    const month = MONTHS.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    return month ? isoDate(Number(named[3]), month, Number(named[1])) : null;
  }
  const monthFirst = /^([a-z]{3,9})[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{2,4})$/i.exec(value);
  if (monthFirst) {
    const month = MONTHS.indexOf(monthFirst[1].slice(0, 3).toLowerCase()) + 1;
    return month ? isoDate(Number(monthFirst[3]), month, Number(monthFirst[2])) : null;
  }
  const parts = /^(\d{1,4})[\-/.](\d{1,2})[\-/.](\d{1,4})$/.exec(value);
  if (!parts) return null;
  const [a, b, c] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // A four-digit first part is always a year first.
  if (parts[1].length === 4) return isoDate(a, b, c);
  if (order === 'MDY') return isoDate(c, a, b);
  if (order === 'YMD') return isoDate(a, b, c);
  return isoDate(c, b, a);
}

/** Day first unless a date in the file can only be month first. UAE banks write day first. */
export function guessDateOrder(values: string[]): DateOrder {
  for (const value of values) {
    const parts = /^(\d{1,2})[\-/.](\d{1,2})[\-/.]\d{2,4}/.exec(clean(value));
    if (parts && Number(parts[2]) > 12 && Number(parts[1]) <= 12) return 'MDY';
  }
  return 'DMY';
}

/**
 * An amount in fils, as a bank writes it: 1,234.56 · -1,234.56 · (1,234.56)
 * · 1,234.56 CR · AED 1,234.56 · 1234.5. Blank or a dash is null. A CR or
 * DR after it is returned too, for files that mark the direction that way.
 */
export function parseStatementAmount(
  text: string,
): { fils: number; mark: 'CR' | 'DR' | null } | null {
  let value = clean(text).toUpperCase();
  if (value === '' || value === '-' || value === '--') return null;
  let mark: 'CR' | 'DR' | null = null;
  const marked = /\s*(CR|DR)\.?$/.exec(value);
  if (marked) {
    mark = marked[1] as 'CR' | 'DR';
    value = value.slice(0, marked.index);
  }
  value = value.replace(/^(AED|DHS?|د\.إ)\s*/i, '').replace(/\s*(AED|DHS?)$/i, '');
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (value.startsWith('-')) {
    negative = !negative;
    value = value.slice(1);
  } else if (value.endsWith('-')) {
    negative = !negative;
    value = value.slice(0, -1);
  }
  value = value.replace(/^\+/, '').replace(/[,\s]/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const fils = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0');
  if (!Number.isSafeInteger(fils)) return null;
  return { fils: negative ? -fils : fils, mark };
}

const BALANCE_ROW =
  /^(opening|closing|available|ledger)\s+balance|balance\s+(b\/?f|c\/?f|brought|carried)|^total/i;
const OPENING_ROW = /^opening\s+balance|balance\s+(b\/?f|brought)/i;

/** Reads the file's lines with these columns. Nothing is thrown: what can't be read is a problem. */
export function readStatement(grid: string[][], columns: StatementColumns): StatementRead {
  const headerRow = rowWithHeadings(grid, columnHeadings(columns));
  const empty: StatementRead = {
    headerRow,
    headings: headerRow >= 0 ? grid[headerRow].map(clean) : [],
    lines: [],
    problems: [],
    openingFils: null,
    closingFils: null,
    from: null,
    to: null,
    balanceBreaks: 0,
  };
  if (headerRow < 0) {
    return {
      ...empty,
      problems: [{ row: 0, message: 'The headings chosen are not in this file.' }],
    };
  }
  const headings = grid[headerRow];
  const at = (name: string | null) => (name ? headings.findIndex((cell) => same(cell, name)) : -1);
  const index = {
    date: at(columns.date),
    description: columns.description.map(at).filter((i) => i >= 0),
    reference: at(columns.reference),
    moneyIn: at(columns.moneyIn),
    moneyOut: at(columns.moneyOut),
    amount: at(columns.amount),
    flag: at(columns.flag),
    balance: at(columns.balance),
  };
  const cell = (cells: string[], i: number) => (i >= 0 ? clean(cells[i]) : '');

  const read: StatementFileLine[] = [];
  const problems: StatementRead['problems'] = [];
  let statedOpening: number | null = null;

  for (let r = headerRow + 1; r < grid.length; r += 1) {
    const cells = grid[r];
    const row = r + 1;
    const dateText = cell(cells, index.date);
    const description = index.description
      .map((i) => cell(cells, i))
      .filter(Boolean)
      .join(' — ');
    const balance = index.balance >= 0 ? parseStatementAmount(cell(cells, index.balance)) : null;

    let amount: number | null = null;
    let amountProblem: string | null = null;
    if (columns.layout === 'split') {
      const moneyIn = parseStatementAmount(cell(cells, index.moneyIn));
      const moneyOut = parseStatementAmount(cell(cells, index.moneyOut));
      if (cell(cells, index.moneyIn) && !moneyIn) amountProblem = 'the money in can’t be read';
      if (cell(cells, index.moneyOut) && !moneyOut) amountProblem = 'the money out can’t be read';
      if (moneyIn || moneyOut) {
        amount = Math.abs(moneyIn?.fils ?? 0) - Math.abs(moneyOut?.fils ?? 0);
      }
    } else {
      const parsed = parseStatementAmount(cell(cells, index.amount));
      if (cell(cells, index.amount) && !parsed) amountProblem = 'the amount can’t be read';
      if (parsed && columns.layout === 'signed') {
        amount =
          parsed.mark === 'DR'
            ? -Math.abs(parsed.fils)
            : parsed.mark === 'CR'
              ? Math.abs(parsed.fils)
              : parsed.fils;
      } else if (parsed) {
        const flag = cell(cells, index.flag).toUpperCase();
        const direction = flag.startsWith('C') ? 1 : flag.startsWith('D') ? -1 : 0;
        if (direction === 0 && parsed.mark) {
          amount = (parsed.mark === 'CR' ? 1 : -1) * Math.abs(parsed.fils);
        } else if (direction === 0) {
          amountProblem = `“${cell(cells, index.flag)}” is neither Cr nor Dr`;
        } else {
          amount = direction * Math.abs(parsed.fils);
        }
      }
    }

    // An opening or closing balance row, or a total: not a line.
    if (!amount && BALANCE_ROW.test(description || dateText)) {
      if (OPENING_ROW.test(description || dateText) && balance) statedOpening = balance.fils;
      continue;
    }
    if (!dateText) {
      // A narrative wrapped onto the next row belongs to the line above.
      if (amount === null && !amountProblem && description && read.length > 0) {
        read[read.length - 1].description = `${read[read.length - 1].description} ${description}`;
      }
      continue;
    }
    const date = parseStatementDate(dateText, columns.dateOrder);
    if (!date) {
      // Rows after the lines (a footer, a note) rarely have an amount.
      if (amount !== null || amountProblem) {
        problems.push({ row, message: `the date “${dateText}” can’t be read` });
      }
      continue;
    }
    if (amountProblem) {
      problems.push({ row, message: amountProblem });
      continue;
    }
    if (!amount) {
      // Some banks repeat the date on a narrative's second row.
      const above = read[read.length - 1];
      if (amount === null && description && above?.date === date) {
        above.description = `${above.description} ${description}`;
      }
      continue;
    }
    read.push({
      row,
      date,
      description: description || '(no description)',
      reference: cell(cells, index.reference) || null,
      amountFils: amount,
      balanceFils: balance ? balance.fils : null,
    });
  }

  if (read.length === 0) {
    return { ...empty, problems };
  }

  // Oldest first. Some banks list the newest first; their running balance
  // only follows from line to line one way round.
  const forward = read[0].date <= read[read.length - 1].date ? read : [...read].reverse();
  const backward = [...forward].reverse();
  const breaks = (lines: StatementFileLine[]) => {
    let count = 0;
    for (let i = 1; i < lines.length; i += 1) {
      const before = lines[i - 1].balanceFils;
      const after = lines[i].balanceFils;
      if (before !== null && after !== null && before + lines[i].amountFils !== after) count += 1;
    }
    return count;
  };
  const allOneDay = forward[0].date === forward[forward.length - 1].date;
  const lines = allOneDay && breaks(backward) < breaks(forward) ? backward : forward;

  const first = lines[0];
  const last = lines[lines.length - 1];
  return {
    headerRow,
    headings: headings.map(clean),
    lines,
    problems,
    openingFils: first.balanceFils !== null ? first.balanceFils - first.amountFils : statedOpening,
    closingFils: last.balanceFils,
    from: first.date,
    to: last.date,
    balanceBreaks: breaks(lines),
  };
}

const looks = (pattern: RegExp, not?: RegExp) => (name: string) =>
  pattern.test(name) && !(not && not.test(name));

/**
 * A first guess at the columns, from the headings banks use. Null when no
 * row looks like headings; the person then chooses them.
 */
export function guessColumns(grid: string[][]): StatementColumns | null {
  const isDate = looks(/date/i);
  for (let row = 0; row < Math.min(grid.length, HEADER_SEARCH); row += 1) {
    const names = grid[row].map(clean).filter(Boolean);
    if (!names.some(isDate)) continue;
    const pick = (test: (name: string) => boolean) => names.find(test) ?? null;
    // The transaction or posting date, before a value date.
    const date =
      pick(looks(/(transaction|txn|posting|post|trans)\.?\s*date/i)) ??
      pick(looks(/date/i, /value/i)) ??
      pick(isDate)!;
    const balance = pick(looks(/balance/i));
    // "Dr/Cr" or "Debit/Credit" is the direction column, not an amount.
    const notAmount = /card|detail|desc|mode|method|type|date|\//i;
    const moneyIn = pick(looks(/credit|deposit|money\s*in|paid\s*in|receipt|^cr\.?$/i, notAmount));
    const moneyOut = pick(
      looks(/debit|withdraw|money\s*out|paid\s*out|payment|^dr\.?$/i, notAmount),
    );
    const amount = pick(looks(/amount|value/i, /date|balance/i));
    const flag = pick(looks(/dr\s*\/\s*cr|cr\s*\/\s*dr|debit\s*\/\s*credit|type|indicator/i));
    const description = names.filter(
      looks(/description|narrat|details|particular|remark|transaction$|memo/i, /date|type/i),
    );
    const reference = pick(looks(/ref|cheque|chq|check\s*no/i, /date/i));
    if (!(moneyIn && moneyOut) && !amount) continue;

    const layout: AmountLayout = moneyIn && moneyOut ? 'split' : flag ? 'flagged' : 'signed';
    const dateIndex = grid[row].findIndex((cell) => same(cell, date));
    const dateValues = grid.slice(row + 1, row + 60).map((cells) => cells[dateIndex] ?? '');
    return {
      date,
      description: description.slice(0, 2),
      reference: reference && !description.includes(reference) ? reference : null,
      layout,
      moneyIn: layout === 'split' ? moneyIn : null,
      moneyOut: layout === 'split' ? moneyOut : null,
      amount: layout === 'split' ? null : amount,
      flag: layout === 'flagged' ? flag : null,
      balance,
      dateOrder: guessDateOrder(dateValues),
    };
  }
  return null;
}

/** The headings on the row most likely to hold them, for choosing columns by hand. */
export function likelyHeadings(grid: string[][]): string[] {
  for (let row = 0; row < Math.min(grid.length, HEADER_SEARCH); row += 1) {
    const names = grid[row].map(clean).filter(Boolean);
    if (names.length >= 3 && names.some(looks(/date/i))) return names;
  }
  const widest = grid
    .slice(0, HEADER_SEARCH)
    .reduce<string[]>((best, cells) => (cells.length > best.length ? cells : best), []);
  return widest.map(clean).filter(Boolean);
}
