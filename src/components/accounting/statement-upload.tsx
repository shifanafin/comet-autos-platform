'use client';

import { useMemo, useState, useTransition, type FormEvent } from 'react';
import { FileUp, Settings2, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { parseCsvRows } from '@/lib/data-transfer/csv';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { filsToString } from '@/lib/money';
import {
  columnsFit,
  guessColumns,
  likelyHeadings,
  readStatement,
  type AmountLayout,
  type DateOrder,
  type StatementColumns,
} from '@/lib/accounting/statement-file';
import { uploadStatementAction } from '@/app/(app)/finance/bank-reconciliation/actions';

/** A statement is small; a file past this is not one. */
const MAX_BYTES = 2 * 1024 * 1024;

const BLANK: StatementColumns = {
  date: '',
  description: [],
  reference: null,
  layout: 'split',
  moneyIn: null,
  moneyOut: null,
  amount: null,
  flag: null,
  balance: null,
  dateOrder: 'DMY',
};

const LAYOUTS: { value: AmountLayout; label: string }[] = [
  { value: 'split', label: 'Money in and money out in two columns' },
  { value: 'signed', label: 'One amount, minus for money out' },
  { value: 'flagged', label: 'One amount, with a Dr/Cr column' },
];

const DATE_ORDERS: { value: DateOrder; label: string }[] = [
  { value: 'DMY', label: 'Day first — 13/10/2026' },
  { value: 'MDY', label: 'Month first — 10/13/2026' },
  { value: 'YMD', label: 'Year first — 2026-10-13' },
];

const signedMoney = (fils: number) =>
  fils < 0 ? `−${formatMoney(filsToString(-fils))}` : formatMoney(filsToString(fils));

export interface UploadAccount {
  id: string;
  label: string;
  /** How this account's last statement was read, if one was uploaded. */
  columns: StatementColumns | null;
}

/** Why a file can't be read as it is, and what to do instead. */
function refuse(file: File): string | null {
  if (/\.(xlsx?|xlsm|xlsb)$/i.test(file.name)) {
    return 'Excel files can’t be read directly yet. Open it in Excel, choose File → Save As → “CSV UTF-8”, and upload that.';
  }
  if (/\.pdf$/i.test(file.name)) {
    return 'A PDF statement can’t be read line by line. In online banking, download the statement as CSV — or as Excel, then save it as CSV.';
  }
  if (!/\.(csv|txt|tsv)$/i.test(file.name)) {
    return 'Choose the statement as a CSV file (it ends in .csv).';
  }
  if (file.size > MAX_BYTES) return 'That file is larger than 2 MB. Download one month at a time.';
  return null;
}

/** The columns to start from: the account's own, if they fit this file, else a guess. */
function startingColumns(grid: string[][], saved: StatementColumns | null) {
  if (saved && columnsFit(grid, saved)) return { columns: saved, remembered: true };
  return { columns: guessColumns(grid) ?? BLANK, remembered: false };
}

/**
 * Uploading a statement: the file is read here first, so the lines, the
 * balances and anything that can't be read are seen before it is saved.
 */
export function StatementUpload({ accounts }: { accounts: UploadAccount[] }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [file, setFile] = useState<{ name: string; grid: string[][] } | null>(null);
  const [columns, setColumns] = useState<StatementColumns>(BLANK);
  const [remembered, setRemembered] = useState(false);
  const [showColumns, setShowColumns] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  const account = accounts.find((item) => item.id === accountId);
  const read = useMemo(
    () => (file && columns.date ? readStatement(file.grid, columns) : null),
    [file, columns],
  );
  const headings = useMemo(() => {
    if (!file) return [];
    if (read && read.headerRow >= 0) return read.headings.filter(Boolean);
    return likelyHeadings(file.grid);
  }, [file, read]);

  function applyColumns(grid: string[][], saved: StatementColumns | null) {
    const start = startingColumns(grid, saved);
    setColumns(start.columns);
    setRemembered(start.remembered);
    setShowColumns(!start.remembered);
  }

  async function onFile(chosen: File | undefined) {
    setError(undefined);
    setFieldErrors({});
    setFile(null);
    if (!chosen) return;
    const refusal = refuse(chosen);
    if (refusal) {
      setError(refusal);
      return;
    }
    const grid = parseCsvRows(await chosen.text());
    if (grid.length === 0) {
      setError('The file is empty.');
      return;
    }
    setFile({ name: chosen.name, grid });
    applyColumns(grid, account?.columns ?? null);
  }

  function onAccount(id: string) {
    setAccountId(id);
    if (file) applyColumns(file.grid, accounts.find((item) => item.id === id)?.columns ?? null);
  }

  const set = (patch: Partial<StatementColumns>) =>
    setColumns((current) => ({ ...current, ...patch }));

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || !read) return;
    const form = new FormData(event.currentTarget);
    // The rows from the headings down are all the server needs.
    const grid = file.grid
      .slice(Math.max(read.headerRow, 0))
      .map((cells) => cells.slice(0, 80).map((cell) => cell.slice(0, 1000)));
    setError(undefined);
    setFieldErrors({});
    startTransition(async () => {
      const result = await uploadStatementAction({
        accountId,
        fileName: file.name,
        grid,
        columns,
        statementDate: String(form.get('statementDate') ?? ''),
        statementBalance: String(form.get('statementBalance') ?? ''),
      });
      // On success the reconciliation opens.
      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
      }
    });
  }

  const preview = read
    ? read.lines.length > 7
      ? [...read.lines.slice(0, 5), null, read.lines[read.lines.length - 1]]
      : read.lines
    : [];
  const ready = Boolean(read && read.lines.length > 0 && read.problems.length === 0);

  return (
    <form onSubmit={onSubmit} className="@container flex flex-col gap-6">
      <div className="grid gap-6 @2xl:grid-cols-2">
        <Field label="Account" htmlFor="statement-account" required>
          <NativeSelect
            id="statement-account"
            value={accountId}
            onChange={(event) => onAccount(event.target.value)}
            className="h-11"
          >
            {accounts.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field
          label="Statement file (CSV)"
          htmlFor="statement-file"
          required
          hint="Download it from online banking as CSV, for the month you are reconciling."
        >
          <Input
            id="statement-file"
            type="file"
            accept=".csv,.txt,.tsv,text/csv"
            onChange={(event) => onFile(event.target.files?.[0])}
            className="h-11 py-2"
          />
        </Field>
      </div>

      {file ? (
        <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <FileUp className="size-4 shrink-0" />
              <span className="truncate">{file.name}</span>
              {remembered ? (
                <span className="text-xs font-normal text-muted-foreground">
                  read the way this account’s last statement was
                </span>
              ) : null}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowColumns((value) => !value)}
            >
              <Settings2 />
              {showColumns ? 'Hide columns' : 'Change columns'}
            </Button>
          </div>

          {showColumns ? <ColumnChoices columns={columns} headings={headings} set={set} /> : null}

          {!columns.date ? (
            <p className="text-sm text-muted-foreground">
              Choose which column holds the date, and which hold the amounts.
            </p>
          ) : read && read.problems.length > 0 ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              <p className="font-medium">Some lines can’t be read with these columns:</p>
              <ul className="mt-1 list-disc pl-5">
                {read.problems.slice(0, 5).map((problem) => (
                  <li key={`${problem.row}-${problem.message}`}>
                    {problem.row > 0 ? `Row ${problem.row}: ` : ''}
                    {problem.message}
                  </li>
                ))}
              </ul>
              {read.problems.length > 5 ? (
                <p className="mt-1">{`…and ${read.problems.length - 5} more.`}</p>
              ) : null}
            </div>
          ) : read && read.lines.length === 0 ? (
            <p className="text-sm text-destructive">
              No lines with a date and an amount were found. Check the columns.
            </p>
          ) : read ? (
            <>
              <p className="text-sm">
                {`${read.lines.length} line${read.lines.length === 1 ? '' : 's'}, ${formatCalendarDate(read.from!)} to ${formatCalendarDate(read.to!)}.`}
                {read.openingFils !== null ? ` Opening ${signedMoney(read.openingFils)}.` : ''}
                {read.closingFils !== null ? ` Closing ${signedMoney(read.closingFils)}.` : ''}
              </p>
              {read.balanceBreaks > 0 ? (
                <p className="text-sm text-warning">
                  {`The running balance jumps on ${read.balanceBreaks} line${read.balanceBreaks === 1 ? '' : 's'} — the file may be missing lines, or the money in and out columns are swapped.`}
                </p>
              ) : null}
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                    <tr>
                      <th className="w-28 px-3 py-2">Date</th>
                      <th className="px-2 py-2">On the statement</th>
                      <th className="w-28 px-2 py-2 text-right">Money in</th>
                      <th className="w-28 px-2 py-2 text-right">Money out</th>
                      <th className="w-28 px-3 py-2 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {preview.map((line, index) =>
                      line ? (
                        <tr key={line.row}>
                          <td className="px-3 py-2 tabular-nums whitespace-nowrap">
                            {formatCalendarDate(line.date)}
                          </td>
                          <td className="max-w-0 truncate px-2 py-2">{line.description}</td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {line.amountFils > 0 ? signedMoney(line.amountFils) : ''}
                          </td>
                          <td className="px-2 py-2 text-right tabular-nums">
                            {line.amountFils < 0 ? signedMoney(-line.amountFils) : ''}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {line.balanceFils !== null ? signedMoney(line.balanceFils) : ''}
                          </td>
                        </tr>
                      ) : (
                        <tr key={`gap-${index}`}>
                          <td colSpan={5} className="px-3 py-1 text-center text-muted-foreground">
                            …
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
              <div
                key={`${file.name}-${read.to}-${read.closingFils}`}
                className="grid gap-6 @2xl:grid-cols-2"
              >
                <Field
                  label="Statement date"
                  htmlFor="statement-date"
                  error={fieldErrors.statementDate}
                  hint="The last day the statement covers."
                >
                  <Input
                    id="statement-date"
                    name="statementDate"
                    type="date"
                    defaultValue={read.to ?? ''}
                    className="h-11"
                  />
                </Field>
                <TextField
                  label="Closing balance on the statement (AED)"
                  name="statementBalance"
                  numeric="money"
                  allowNegative
                  required={read.closingFils === null}
                  defaultValue={
                    read.closingFils === null
                      ? ''
                      : read.closingFils < 0
                        ? `-${filsToString(-read.closingFils)}`
                        : filsToString(read.closingFils)
                  }
                  error={fieldErrors.statementBalance}
                  hint={
                    read.closingFils === null
                      ? 'This file shows no balance: type it from the statement.'
                      : 'From the file. Check it against the statement.'
                  }
                  className="[&_input]:h-11 [&_input]:text-right [&_input]:tabular-nums"
                />
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      <FormError message={error} />
      <div>
        <Button type="submit" disabled={!ready || isPending} className="h-11">
          <Upload />
          {isPending ? 'Uploading and matching…' : 'Upload and match'}
        </Button>
      </div>
    </form>
  );
}

/** Which heading holds what. */
function ColumnChoices({
  columns,
  headings,
  set,
}: {
  columns: StatementColumns;
  headings: string[];
  set: (patch: Partial<StatementColumns>) => void;
}) {
  const choose = (
    id: string,
    label: string,
    value: string | null,
    onChange: (value: string | null) => void,
    optional = false,
  ) => (
    <Field label={label} htmlFor={id} required={!optional}>
      <NativeSelect
        id={id}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
        className="h-11"
      >
        <option value="">{optional ? '— none —' : 'Choose…'}</option>
        {headings.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );

  return (
    <div className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
      {choose('col-date', 'Date', columns.date || null, (value) => set({ date: value ?? '' }))}
      <Field label="Dates are written" htmlFor="col-date-order">
        <NativeSelect
          id="col-date-order"
          value={columns.dateOrder}
          onChange={(event) => set({ dateOrder: event.target.value as DateOrder })}
          className="h-11"
        >
          {DATE_ORDERS.map((order) => (
            <option key={order.value} value={order.value}>
              {order.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {choose(
        'col-description',
        'Description',
        columns.description[0] ?? null,
        (value) => set({ description: value ? [value, ...columns.description.slice(1)] : [] }),
        true,
      )}
      {choose(
        'col-reference',
        'Reference or cheque number',
        columns.reference,
        (value) => set({ reference: value }),
        true,
      )}
      <Field label="Amounts" htmlFor="col-layout">
        <NativeSelect
          id="col-layout"
          value={columns.layout}
          onChange={(event) => set({ layout: event.target.value as AmountLayout })}
          className="h-11"
        >
          {LAYOUTS.map((layout) => (
            <option key={layout.value} value={layout.value}>
              {layout.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {columns.layout === 'split' ? (
        <>
          {choose('col-in', 'Money in (credit)', columns.moneyIn, (value) =>
            set({ moneyIn: value }),
          )}
          {choose('col-out', 'Money out (debit)', columns.moneyOut, (value) =>
            set({ moneyOut: value }),
          )}
        </>
      ) : (
        <>
          {choose('col-amount', 'Amount', columns.amount, (value) => set({ amount: value }))}
          {columns.layout === 'flagged'
            ? choose('col-flag', 'Dr/Cr', columns.flag, (value) => set({ flag: value }))
            : null}
        </>
      )}
      {choose(
        'col-balance',
        'Running balance',
        columns.balance,
        (value) => set({ balance: value }),
        true,
      )}
    </div>
  );
}
