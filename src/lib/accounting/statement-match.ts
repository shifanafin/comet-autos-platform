/*
 * Matching statement lines to the books.
 *
 * A statement line and a book line are the same money when the amount is
 * the same to the fil and the dates are close: a bank credits a transfer a
 * day or two after it is recorded, and presents a cheque days or weeks after
 * it is written. A reference both carry — a cheque number, a transfer
 * reference — makes a match certain across a longer gap.
 *
 *   sure       same amount, within SURE_DAYS, or within WINDOW_DAYS with a
 *              shared reference: ticked at once
 *   suggested  same amount within WINDOW_DAYS: offered, for a person to confirm
 *
 * Each line is used once. Closest first, so two equal amounts on different
 * days pair with their own days.
 *
 * Pure: the server ticks the sure matches; the screen shows the suggestions.
 */

export const SURE_DAYS = 3;
export const WINDOW_DAYS = 14;

export interface MatchLine {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  /** Fils, money in positive. */
  amountFils: number;
  /** Everything written on it, for references. */
  text: string;
}

export interface Match {
  statementId: string;
  bookId: string;
  days: number;
  sharedReference: boolean;
  sure: boolean;
}

const DAY = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY;

/**
 * References worth matching on: cheque, transfer and invoice numbers — a word
 * of three or more with a digit in it. Dates and years are left out (every
 * line has one), and leading zeros dropped: a bank's 000451 is cheque 451.
 */
export function references(text: string): string[] {
  const words = text.toUpperCase().split(/[^A-Z0-9\-/]+/);
  return [
    ...new Set(
      words
        .filter((word) => !/^\d{1,4}[\-/]\d{1,2}[\-/]\d{1,4}$/.test(word))
        .map((word) => word.replace(/[\-/]/g, '').replace(/^0+(?=\d)/, ''))
        .filter((word) => word.length >= 3 && /\d/.test(word) && !/^(19|20)\d\d$/.test(word)),
    ),
  ];
}

function shareReference(a: string[], b: string[]) {
  return a.some((ref) => b.includes(ref));
}

/** Every pairing worth considering, best first, each line used once. */
export function matchLines(statement: MatchLine[], books: MatchLine[]): Match[] {
  const bookRefs = new Map(books.map((line) => [line.id, references(line.text)]));
  const candidates: Match[] = [];
  for (const line of statement) {
    const refs = references(line.text);
    for (const book of books) {
      if (book.amountFils !== line.amountFils) continue;
      const days = Math.abs(dayNumber(line.date) - dayNumber(book.date));
      if (days > WINDOW_DAYS) continue;
      const sharedReference = shareReference(refs, bookRefs.get(book.id) ?? []);
      candidates.push({
        statementId: line.id,
        bookId: book.id,
        days,
        sharedReference,
        sure: days <= SURE_DAYS || sharedReference,
      });
    }
  }
  candidates.sort(
    (a, b) => Number(b.sharedReference) - Number(a.sharedReference) || a.days - b.days,
  );
  const usedStatement = new Set<string>();
  const usedBook = new Set<string>();
  const matches: Match[] = [];
  for (const match of candidates) {
    if (usedStatement.has(match.statementId) || usedBook.has(match.bookId)) continue;
    usedStatement.add(match.statementId);
    usedBook.add(match.bookId);
    matches.push(match);
  }
  return matches;
}
