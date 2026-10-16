'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { BookCheck, CheckCircle2, Loader2, RefreshCw, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/layout/primitives';
import { StatusPill } from '@/components/shared/status-pill';
import { formatCalendarDate, formatDateTime } from '@/lib/format';
import type { BooksCheck as Result } from '@/lib/accounting/books-check';
import type { PostedSource } from '@/lib/accounting/journal';
import {
  bringIntoStepAction,
  runBooksCheckAction,
} from '@/app/(app)/finance/accounting/books-check/actions';

/*
 * The books check on screen: run it, see what is out of step, and bring
 * each one into step by its record's own rule — or all at once.
 */

const STATE: Record<string, { label: string; tone: 'danger' | 'warning' }> = {
  missing: { label: 'Not in the books', tone: 'danger' },
  differs: { label: 'Entry no longer matches its record', tone: 'warning' },
  orphan: { label: 'Entry left behind', tone: 'warning' },
};

export function BooksCheck({ canFix }: { canFix: boolean }) {
  const [result, setResult] = useState<Result | null>(null);
  const [running, startRun] = useTransition();
  const [fixing, startFix] = useTransition();
  const [fixingId, setFixingId] = useState<string | null>(null);

  const run = () =>
    startRun(async () => {
      const response = await runBooksCheckAction();
      if (!response.ok || !response.data) {
        toast.error(response.error ?? 'The check could not run.');
        return;
      }
      setResult(response.data);
    });

  const fix = (only?: { source: PostedSource; sourceId: string }) => {
    setFixingId(only ? `${only.source}:${only.sourceId}` : 'all');
    startFix(async () => {
      const response = await bringIntoStepAction(only);
      setFixingId(null);
      if (!response.ok || !response.data) {
        toast.error(response.error ?? 'Nothing could be changed.');
        return;
      }
      const { fixed, failed } = response.data;
      if (failed.length) {
        toast.warning(`${fixed} brought into step; ${failed.length} could not be: ${failed[0].why}`);
      } else {
        toast.success(`${fixed} brought into step`);
      }
      run();
    });
  };

  if (!result) {
    return (
      <Panel className="flex flex-col items-start gap-4">
        <p className="text-sm text-muted-foreground">
          Compares every record — invoices, payments, expenses, stock, payroll, VAT returns, credit
          notes, assets, transfers, advances, owner&apos;s money, vouchers — with its journal entry.
          It takes up to a minute.
        </p>
        <Button size="lg" onClick={run} disabled={running}>
          {running ? <Loader2 className="animate-spin" /> : <BookCheck />}
          {running ? 'Checking every record…' : 'Run the check'}
        </Button>
      </Panel>
    );
  }

  const busy = running || fixing;
  return (
    <div className="flex flex-col gap-6">
      <Panel className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start gap-3">
          {result.problems.length === 0 ? (
            <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success" />
          ) : (
            <Wrench className="mt-0.5 size-5 shrink-0 text-warning" />
          )}
          <div>
            <p className="font-semibold">
              {result.problems.length === 0
                ? `All ${result.checked} records are in the books, as their records say.`
                : `${result.problems.length} of ${result.checked} records are out of step.`}
            </p>
            <p className="text-xs text-muted-foreground">
              Checked {formatDateTime(result.checkedAt)}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={run} disabled={busy}>
            {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Check again
          </Button>
          {canFix && result.problems.length > 0 ? (
            <Button onClick={() => fix()} disabled={busy}>
              {fixing && fixingId === 'all' ? <Loader2 className="animate-spin" /> : <Wrench />}
              Bring all into step
            </Button>
          ) : null}
        </div>
      </Panel>

      {result.problems.length > 0 ? (
        <Panel padding="none" className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-180 text-sm">
              <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                <tr>
                  <th className="px-4 py-3 pl-6">Record</th>
                  <th className="w-56 px-2 py-3">What is wrong</th>
                  <th className="w-40 px-4 py-3 pr-6 text-right" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.problems.map((row) => {
                  const key = `${row.source}:${row.sourceId}`;
                  return (
                    <tr key={key}>
                      <td className="px-4 py-3 pl-6">
                        {row.href ? (
                          <Link href={row.href} className="font-medium hover:underline">
                            {row.description}
                          </Link>
                        ) : (
                          <span className="font-medium">{row.description}</span>
                        )}
                        <span className="block text-xs text-muted-foreground">
                          {[
                            row.kind,
                            row.entryNumber,
                            row.entryDate ? `booked ${formatCalendarDate(row.entryDate)}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </td>
                      <td className="px-2 py-3">
                        <StatusPill tone={STATE[row.state].tone}>{STATE[row.state].label}</StatusPill>
                      </td>
                      <td className="px-4 py-3 pr-6 text-right">
                        {canFix ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            onClick={() => fix({ source: row.source, sourceId: row.sourceId })}
                          >
                            {fixing && fixingId === key ? <Loader2 className="animate-spin" /> : null}
                            Bring into step
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground sm:px-6">
            Bringing into step books each one by its record&apos;s own rule: corrected where it
            stands while its period is open, reversed and booked again once it is closed. The audit
            log keeps what each entry said before.
          </p>
        </Panel>
      ) : null}

      {result.kept.length > 0 ? (
        <details className="rounded-xl border border-border bg-card">
          <summary className="cursor-pointer px-4 py-3 text-sm font-medium sm:px-6">
            {`${result.kept.length} historical stock entries kept as booked, on purpose`}
          </summary>
          <ul className="divide-y divide-border border-t border-border text-sm">
            {result.kept.map((row) => (
              <li key={`${row.source}:${row.sourceId}`} className="px-4 py-2.5 sm:px-6">
                <span className="block">{row.description}</span>
                <span className="block text-xs text-muted-foreground">
                  {[row.entryNumber, row.entryDate ? formatCalendarDate(row.entryDate) : null, row.why]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <Panel padding="none" className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="px-4 py-3 pl-6">Kind of record</th>
              <th className="w-28 px-2 py-3 text-right">Checked</th>
              <th className="w-32 px-4 py-3 pr-6 text-right">Out of step</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {result.summary.map((row) => (
              <tr key={row.source}>
                <td className="px-4 py-2.5 pl-6">{row.label}</td>
                <td className="px-2 py-2.5 text-right tabular-nums">{row.checked}</td>
                <td className="px-4 py-2.5 pr-6 text-right tabular-nums">
                  {row.problems ? (
                    <span className="font-semibold text-warning">{row.problems}</span>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
