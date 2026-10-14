/**
 * Unit tests for reading bank statement files and matching them to the books:
 *
 *  - dates and amounts as UAE banks write them;
 *  - the columns guessed from a bank's headings, past the lines about the
 *    account above them;
 *  - money in and out in two columns, one signed amount, or an amount with a
 *    Dr/Cr column — newest line first or last — read oldest first, with the
 *    opening and closing balance;
 *  - balance rows, wrapped narratives and footers are not lines; a line
 *    that can't be read is reported, never skipped;
 *  - a statement line pairs with the book line of the same amount nearest
 *    in date; a shared cheque number makes a later match sure.
 *
 *   npm run test:unit
 */
import './unit-env';
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvRows } from '@/lib/data-transfer/csv';
import {
  guessColumns,
  parseStatementAmount,
  parseStatementDate,
  readStatement,
  savedColumns,
  type StatementColumns,
} from '@/lib/accounting/statement-file';
import { matchLines, references } from '@/lib/accounting/statement-match';

describe('statement dates and amounts', () => {
  test('dates as banks write them', () => {
    assert.equal(parseStatementDate('13/10/2026', 'DMY'), '2026-10-13');
    assert.equal(parseStatementDate('13-10-26', 'DMY'), '2026-10-13');
    assert.equal(parseStatementDate('03.10.2026', 'DMY'), '2026-10-03');
    assert.equal(parseStatementDate('2026-10-13', 'DMY'), '2026-10-13');
    assert.equal(parseStatementDate('13-Oct-2026', 'DMY'), '2026-10-13');
    assert.equal(parseStatementDate('13 October 2026', 'DMY'), '2026-10-13');
    assert.equal(parseStatementDate('Oct 13, 2026', 'DMY'), '2026-10-13');
    assert.equal(parseStatementDate('13/10/2026 14:05:00', 'DMY'), '2026-10-13');
    assert.equal(parseStatementDate('10/13/2026', 'MDY'), '2026-10-13');
    assert.equal(parseStatementDate('31/02/2026', 'DMY'), null, 'no 31 February');
    assert.equal(parseStatementDate('Opening balance', 'DMY'), null);
  });

  test('amounts as banks write them', () => {
    assert.deepEqual(parseStatementAmount('1,234.56'), { fils: 123456, mark: null });
    assert.deepEqual(parseStatementAmount('-1,234.56'), { fils: -123456, mark: null });
    assert.deepEqual(parseStatementAmount('(250.00)'), { fils: -25000, mark: null });
    assert.deepEqual(parseStatementAmount('1,234.56 CR'), { fils: 123456, mark: 'CR' });
    assert.deepEqual(parseStatementAmount('AED 99.5'), { fils: 9950, mark: null });
    assert.deepEqual(parseStatementAmount('250.00-'), { fils: -25000, mark: null });
    assert.equal(parseStatementAmount(''), null);
    assert.equal(parseStatementAmount('-'), null);
    assert.equal(parseStatementAmount('12.345'), null, 'more than fils is not money');
  });
});

/** An Emirates-style download: account lines, then headings, newest first. */
const SPLIT_FILE = [
  'Account Statement',
  'Account Number,XXXX1234',
  'Period,01/10/2026 to 13/10/2026',
  '',
  'Transaction Date,Value Date,Description,Cheque No,Debit,Credit,Balance',
  '12/10/2026,12/10/2026,CHEQUE 000451 CLEARED,000451,"1,500.00",,"8,250.00"',
  '10/10/2026,10/10/2026,Bank charges,,52.50,,"9,750.00"',
  '10/10/2026,10/10/2026,VAT on charges,,2.63,,"9,802.50"',
  '05/10/2026,05/10/2026,TRANSFER FROM AL NOOR GARAGE,,,"2,805.13","9,805.13"',
  '05/10/2026,05/10/2026,REF FT26100512,,,,',
  'Closing balance,,,,,,"8,250.00"',
].join('\n');

describe('reading a statement', () => {
  test('two columns, newest first: guessed, read oldest first, balances followed', () => {
    const grid = parseCsvRows(SPLIT_FILE);
    const columns = guessColumns(grid);
    assert.ok(columns);
    assert.equal(columns.date, 'Transaction Date', 'the transaction date, not the value date');
    assert.equal(columns.layout, 'split');
    assert.equal(columns.moneyOut, 'Debit');
    assert.equal(columns.moneyIn, 'Credit');
    assert.equal(columns.balance, 'Balance');
    assert.equal(columns.reference, 'Cheque No');
    assert.deepEqual(columns.description, ['Description']);

    const read = readStatement(grid, columns);
    assert.deepEqual(read.problems, []);
    assert.equal(read.lines.length, 4, 'the wrapped reference and closing row are not lines');
    assert.equal(read.from, '2026-10-05');
    assert.equal(read.to, '2026-10-12');
    assert.equal(read.lines[0].amountFils, 280513);
    assert.match(read.lines[0].description, /FT26100512/, 'the wrapped row joins its line');
    assert.equal(read.lines[3].amountFils, -150000);
    assert.equal(read.openingFils, 700000, '9,805.13 less the 2,805.13 that came in');
    assert.equal(read.closingFils, 825000);
    assert.equal(read.balanceBreaks, 0);
  });

  test('one signed amount', () => {
    const grid = parseCsvRows(
      'Date,Narrative,Amount,Running Balance\n01/10/2026,Card settlement,1200.00,3200.00\n02/10/2026,Rent,-2500.00,700.00\n',
    );
    const columns = guessColumns(grid)!;
    assert.equal(columns.layout, 'signed');
    const read = readStatement(grid, columns);
    assert.deepEqual(
      read.lines.map((line) => line.amountFils),
      [120000, -250000],
    );
    assert.equal(read.openingFils, 200000);
    assert.equal(read.closingFils, 70000);
  });

  test('an amount with a Dr/Cr column', () => {
    const grid = parseCsvRows(
      'Posting Date,Details,Amount,Dr/Cr,Balance\n01/10/2026,Deposit,500.00,CR,1500.00\n02/10/2026,ATM,200.00,DR,1300.00\n',
    );
    const columns = guessColumns(grid)!;
    assert.equal(columns.layout, 'flagged');
    assert.equal(columns.flag, 'Dr/Cr');
    const read = readStatement(grid, columns);
    assert.deepEqual(
      read.lines.map((line) => line.amountFils),
      [50000, -20000],
    );
  });

  test('a line that cannot be read is reported, not dropped', () => {
    const grid = parseCsvRows(
      'Date,Description,Debit,Credit,Balance\n01/10/2026,Fuel,abc,,100.00\n32/10/2026,Fuel,10.00,,90.00\n',
    );
    const read = readStatement(grid, guessColumns(grid)!);
    assert.equal(read.lines.length, 0);
    assert.deepEqual(
      read.problems.map((problem) => problem.row),
      [2, 3],
    );
  });

  test('a jump in the running balance is counted', () => {
    const grid = parseCsvRows(
      'Date,Description,Debit,Credit,Balance\n01/10/2026,A,,100.00,1100.00\n02/10/2026,B,50.00,,1000.00\n',
    );
    assert.equal(readStatement(grid, guessColumns(grid)!).balanceBreaks, 1);
  });

  test('columns are remembered by heading, and stale ones are refused', () => {
    const columns: StatementColumns = guessColumns(parseCsvRows(SPLIT_FILE))!;
    assert.deepEqual(savedColumns(JSON.parse(JSON.stringify(columns))), columns);
    assert.equal(savedColumns({ date: 'Date' }), null);
    // Another file without those headings reads nothing, and says why.
    const read = readStatement(parseCsvRows('When,What,How much\n'), columns);
    assert.equal(read.headerRow, -1);
    assert.equal(read.problems.length, 1);
  });
});

describe('matching to the books', () => {
  const book = (id: string, date: string, amountFils: number, text = '') => ({
    id,
    date,
    amountFils,
    text,
  });

  test('the same amount nearest in date, each line once', () => {
    const matches = matchLines(
      [book('s1', '2026-10-05', 10000), book('s2', '2026-10-09', 10000)],
      [
        book('b1', '2026-10-08', 10000),
        book('b2', '2026-10-04', 10000),
        book('b3', '2026-10-05', 9999),
      ],
    );
    const pairs = Object.fromEntries(matches.map((match) => [match.statementId, match.bookId]));
    assert.deepEqual(pairs, { s1: 'b2', s2: 'b1' });
    assert.ok(matches.every((match) => match.sure));
  });

  test('a gap past a few days is only a suggestion, unless a reference is shared', () => {
    const [far] = matchLines(
      [book('s', '2026-10-20', -150000)],
      [book('b', '2026-10-10', -150000)],
    );
    assert.equal(far.sure, false);
    const [cheque] = matchLines(
      [book('s', '2026-10-20', -150000, 'CHEQUE 000451 CLEARED')],
      [book('b', '2026-10-10', -150000, 'JE-0042 Supplier payment cheque 451')],
    );
    assert.equal(cheque.sharedReference, true);
    assert.equal(cheque.sure, true);
    assert.equal(
      matchLines([book('s', '2026-11-20', 100)], [book('b', '2026-10-01', 100)]).length,
      0,
      'past the window, no match at all',
    );
  });

  test('references are numbers worth matching', () => {
    assert.deepEqual(references('CHEQUE 000451 REF FT26100512'), ['451', 'FT26100512']);
    assert.deepEqual(references('Bank charges'), []);
  });
});
