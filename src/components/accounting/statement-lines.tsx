'use client';

import Link from 'next/link';
import { Fragment, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Link2, RefreshCw, Unlink } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { formatCalendarDate, formatMoney } from '@/lib/format';
import { filsToString, toFils } from '@/lib/money';
import { cn } from '@/lib/utils';
import type { ReconciliationDetail } from '@/lib/accounting/reconciliation';
import type { StatementView } from '@/lib/accounting/statement-import';
import {
  matchStatementLineAction,
  rematchStatementAction,
  unmatchStatementLineAction,
} from '@/app/(app)/finance/bank-reconciliation/actions';

type BookRow = ReconciliationDetail['rows'][number];
type StatementRow = StatementView['rows'][number];

const signedFils = (value: string) =>
  value.startsWith('-') ? -toFils(value.slice(1)) : toFils(value);
const money = (fils: number) => formatMoney(filsToString(Math.abs(fils)));
const bookFils = (row: BookRow) => (row.moneyIn ? toFils(row.moneyIn) : -toFils(row.moneyOut));
const dayGap = (a: string, b: string) =>
  Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/**
 * The uploaded statement, line by line, beside the books: what each line is
 * matched to, a likely match to confirm, or the lines to match it to.
 */
export function StatementLines({
  reconciliationId,
  editable,
  view,
  fileName,
  books,
}: {
  reconciliationId: string;
  editable: boolean;
  view: StatementView;
  fileName: string | null;
  books: BookRow[];
}) {
  const router = useRouter();
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const bookById = useMemo(() => new Map(books.map((row) => [row.id, row])), [books]);

  function run(action: () => Promise<{ ok: boolean; error?: string }>, success?: string) {
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        if (success) toast.success(success);
        setPicking(null);
        router.refresh();
      } else {
        toast.error(result.error ?? 'Something went wrong.');
      }
    });
  }

  function rematch() {
    startTransition(async () => {
      const result = await rematchStatementAction(reconciliationId);
      if (!result.ok) {
        toast.error(result.error ?? 'Could not match.');
        return;
      }
      const matched = result.data?.matched ?? 0;
      toast.success(
        matched ? `${matched} more line${matched === 1 ? '' : 's'} matched` : 'No new matches',
      );
      router.refresh();
    });
  }

  const rows = view.rows.filter((row) => !onlyOpen || row.status !== 'matched');

  return (
    <section className="flex flex-col gap-4 print:hidden">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-base font-semibold">Bank statement</h2>
          <p className="text-sm text-muted-foreground">
            {`${view.matched} of ${view.rows.length} line${view.rows.length === 1 ? '' : 's'} matched to the books`}
            {fileName ? ` · ${fileName}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setOnlyOpen((value) => !value)}
          >
            {onlyOpen ? 'Show every line' : 'Only what’s not matched'}
          </Button>
          {editable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isPending}
              onClick={rematch}
            >
              <RefreshCw />
              Find matches again
            </Button>
          ) : null}
        </div>
      </div>

      {view.checks.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm">
          {view.checks.map((check) => (
            <p key={check} className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              {check}
            </p>
          ))}
        </div>
      ) : null}

      {editable && view.open > 0 ? (
        <p className="text-xs text-muted-foreground">
          A line not in the books — a bank charge, interest, a transfer not yet recorded: record it
          first (bank charges as an{' '}
          <Link href="/finance/expenses" target="_blank" className="text-primary hover:underline">
            expense
          </Link>{' '}
          paid from this account, with the bank’s VAT if it charged any; anything else as a{' '}
          <Link
            href="/finance/accounting/journal/new"
            target="_blank"
            className="text-primary hover:underline"
          >
            journal entry
          </Link>
          ), then press Find matches again.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="w-28 px-4 py-3">Date</th>
              <th className="px-2 py-3">On the statement</th>
              <th className="w-28 px-2 py-3 text-right">Money in</th>
              <th className="w-28 px-2 py-3 text-right">Money out</th>
              <th className="w-72 px-4 py-3">In the books</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                  Every line is matched.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const amount = signedFils(row.amount);
                return (
                  <Fragment key={row.id}>
                    <tr className={cn(row.status === 'matched' && 'bg-success/5')}>
                      <td className="px-4 py-2.5 align-top tabular-nums whitespace-nowrap">
                        {formatCalendarDate(row.date)}
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        <span className={cn(row.broughtForward && 'font-medium')}>
                          {row.description}
                        </span>
                        {row.reference ? (
                          <span className="ml-1 font-mono text-xs text-muted-foreground">
                            {row.reference}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-2 py-2.5 text-right align-top tabular-nums">
                        {amount > 0 ? money(amount) : ''}
                      </td>
                      <td className="px-2 py-2.5 text-right align-top tabular-nums">
                        {amount < 0 ? money(amount) : ''}
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <MatchCell
                          row={row}
                          editable={editable}
                          pending={isPending}
                          bookById={bookById}
                          onPick={() => setPicking(picking === row.id ? null : row.id)}
                          onConfirm={(lineId) =>
                            run(
                              () => matchStatementLineAction(reconciliationId, row.id, [lineId]),
                              'Matched',
                            )
                          }
                          onUnmatch={() =>
                            run(() => unmatchStatementLineAction(reconciliationId, row.id))
                          }
                        />
                      </td>
                    </tr>
                    {picking === row.id ? (
                      <tr>
                        <td colSpan={5} className="bg-muted/20 px-4 py-3">
                          <Picker
                            row={row}
                            books={books}
                            pending={isPending}
                            onCancel={() => setPicking(null)}
                            onMatch={(lineIds) =>
                              run(
                                () => matchStatementLineAction(reconciliationId, row.id, lineIds),
                                'Matched',
                              )
                            }
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function MatchCell({
  row,
  editable,
  pending,
  bookById,
  onPick,
  onConfirm,
  onUnmatch,
}: {
  row: StatementRow;
  editable: boolean;
  pending: boolean;
  bookById: Map<string, BookRow>;
  onPick: () => void;
  onConfirm: (lineId: string) => void;
  onUnmatch: () => void;
}) {
  if (row.status !== 'open') {
    const matched = row.matchedLineIds.map((id) => bookById.get(id)).filter(Boolean) as BookRow[];
    return (
      <div className="flex flex-col gap-1">
        <span
          className={cn(
            'flex items-center gap-1 text-xs font-medium',
            row.status === 'matched' ? 'text-success' : 'text-warning',
          )}
        >
          <Check className="size-3.5" />
          {row.status === 'matched'
            ? row.broughtForward
              ? `Clears ${matched.length} line${matched.length === 1 ? '' : 's'} before the statement`
              : 'Matched'
            : 'Partly matched — unmatch and match again'}
        </span>
        {!row.broughtForward
          ? matched.slice(0, 3).map((line) => (
              <span key={line.id} className="truncate text-xs text-muted-foreground">
                <span className="font-mono">{line.entryNumber ?? ''}</span> {line.description}
              </span>
            ))
          : null}
        {editable ? (
          <button
            type="button"
            disabled={pending}
            onClick={onUnmatch}
            className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <Unlink className="size-3" />
            Unmatch
          </button>
        ) : null}
      </div>
    );
  }
  const suggestion = row.suggestedLineId ? bookById.get(row.suggestedLineId) : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      {row.broughtForward ? (
        <span className="text-xs text-muted-foreground">
          The books’ lines before the statement don’t come to this. Match it to the lines the bank
          had already cleared.
        </span>
      ) : suggestion ? (
        <span className="text-xs">
          {'Likely: '}
          <span className="font-mono text-muted-foreground">
            {suggestion.entryNumber ?? ''}
          </span>{' '}
          {`${suggestion.description} · ${formatCalendarDate(suggestion.date)}`}
        </span>
      ) : (
        <span className="text-xs text-warning">Not found in the books</span>
      )}
      {editable ? (
        <span className="flex flex-wrap gap-1.5">
          {suggestion ? (
            <Button
              type="button"
              size="xs"
              disabled={pending}
              onClick={() => onConfirm(suggestion.id)}
            >
              <Check />
              Confirm
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="outline" disabled={pending} onClick={onPick}>
            <Link2 />
            Match…
          </Button>
        </span>
      ) : null}
    </div>
  );
}

/** Choosing the book lines a statement line is: one, or several that come to it. */
function Picker({
  row,
  books,
  pending,
  onCancel,
  onMatch,
}: {
  row: StatementRow;
  books: BookRow[];
  pending: boolean;
  onCancel: () => void;
  onMatch: (lineIds: string[]) => void;
}) {
  const amount = signedFils(row.amount);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  // Not yet ticked; the same amount first, then the nearest in date.
  const candidates = useMemo(
    () =>
      books
        .filter((book) => !book.ticked)
        .sort(
          (a, b) =>
            Number(bookFils(b) === amount) - Number(bookFils(a) === amount) ||
            dayGap(a.date, row.date) - dayGap(b.date, row.date),
        ),
    [books, amount, row.date],
  );
  const total = candidates
    .filter((book) => chosen.has(book.id))
    .reduce((sum, book) => sum + bookFils(book), 0);
  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {`Tick the line in the books this is — or several that together make ${amount < 0 ? '−' : ''}${money(amount)} (a deposit of several days’ takings, say).`}
      </p>
      {candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Every line in the books is already ticked. Record what this is first.
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border bg-card">
          {candidates.map((book) => {
            const fils = bookFils(book);
            return (
              <li key={book.id}>
                <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/40">
                  <input
                    type="checkbox"
                    checked={chosen.has(book.id)}
                    onChange={() => toggle(book.id)}
                    className="size-4 shrink-0"
                  />
                  <span className="w-24 shrink-0 tabular-nums">
                    {formatCalendarDate(book.date)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-mono text-xs text-muted-foreground">
                      {book.entryNumber ?? ''}
                    </span>{' '}
                    {book.description}
                  </span>
                  <span
                    className={cn(
                      'w-28 shrink-0 text-right tabular-nums',
                      fils === amount && 'font-medium',
                    )}
                  >
                    {`${fils < 0 ? '−' : ''}${money(fils)}`}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          size="sm"
          disabled={pending || chosen.size === 0 || total !== amount}
          onClick={() => onMatch([...chosen])}
        >
          <Link2 />
          Match
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {chosen.size > 0 ? (
          <span
            className={cn(
              'text-xs tabular-nums',
              total === amount ? 'text-success' : 'text-warning',
            )}
          >
            {`Chosen ${total < 0 ? '−' : ''}${money(total)} of ${amount < 0 ? '−' : ''}${money(amount)}`}
          </span>
        ) : null}
      </div>
    </div>
  );
}
