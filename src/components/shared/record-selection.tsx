'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Loader2, Trash2, Undo2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TextareaField } from '@/components/forms/fields';
import { TableCell, TableHead } from '@/components/ui/table';
import { removeRecordsAction } from '@/app/(app)/records/actions';
import {
  MAX_REMOVE_AT_ONCE,
  REMOVAL,
  type RemovableEntity,
  type RemovalOutcome,
} from '@/lib/records/removal';
import { cn } from '@/lib/utils';

/*
 * Delete on a list: one row from its own button, or many at once by ticking
 * them. Both go through the same confirmation — which says in plain words
 * what will happen (deleted, voided, cancelled, reversed) and what will be
 * skipped — and the same server action, which runs each row through the
 * service its own screen uses. Rows that can't go are listed with the reason.
 *
 * A list opts in by wrapping its rows in <RecordSelection>. Without the
 * permission (`enabled` false) every piece renders nothing.
 */

interface Row {
  id: string;
  label: string;
}

interface SelectionContext {
  entity: RemovableEntity;
  enabled: boolean;
  selected: Map<string, string>;
  toggle: (row: Row, on: boolean) => void;
  setMany: (rows: Row[], on: boolean) => void;
  clear: () => void;
  confirm: (rows: Row[]) => void;
}

const Context = createContext<SelectionContext | null>(null);

function useSelection() {
  const context = useContext(Context);
  if (!context) throw new Error('Wrap the list in <RecordSelection>.');
  return context;
}

/** Void and cancel stop a record; reverse undoes it; delete removes it. */
function VerbIcon({ verb, className }: { verb: string; className?: string }) {
  if (verb === 'Void' || verb === 'Cancel') return <Ban className={className} />;
  if (verb === 'Reverse') return <Undo2 className={className} />;
  return <Trash2 className={className} />;
}

export function RecordSelection({
  entity,
  enabled,
  children,
}: {
  entity: RemovableEntity;
  /** Whether this user may remove these records at all. */
  enabled: boolean;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Map<string, string>>(new Map());
  const [target, setTarget] = useState<Row[] | null>(null);

  const toggle = useCallback((row: Row, on: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      if (on) next.set(row.id, row.label);
      else next.delete(row.id);
      return next;
    });
  }, []);
  const setMany = useCallback((rows: Row[], on: boolean) => {
    setSelected((current) => {
      const next = new Map(current);
      for (const row of rows) {
        if (on) next.set(row.id, row.label);
        else next.delete(row.id);
      }
      return next;
    });
  }, []);
  const clear = useCallback(() => setSelected(new Map()), []);

  const value = useMemo(
    () => ({ entity, enabled, selected, toggle, setMany, clear, confirm: setTarget }),
    [entity, enabled, selected, toggle, setMany, clear],
  );

  return (
    <Context.Provider value={value}>
      {children}
      {enabled ? (
        <>
          <SelectionBar />
          <RemoveDialog
            rows={target}
            onClose={() => setTarget(null)}
            onDone={(ids) =>
              setMany(
                ids.map((id) => ({ id, label: '' })),
                false,
              )
            }
          />
        </>
      ) : null}
    </Context.Provider>
  );
}

const CHECKBOX =
  'relative z-10 size-4 shrink-0 cursor-pointer rounded accent-[var(--primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** The tick box for one row. Sits above a row-wide link, so ticking never opens the record. */
export function RowCheckbox({ id, label, className }: Row & { className?: string }) {
  const { enabled, selected, toggle } = useSelection();
  if (!enabled) return null;
  return (
    <input
      type="checkbox"
      className={cn(CHECKBOX, className)}
      checked={selected.has(id)}
      onChange={(event) => toggle({ id, label }, event.target.checked)}
      onClick={(event) => event.stopPropagation()}
      aria-label={`Select ${label}`}
    />
  );
}

/** Ticks or clears every row on this page. */
export function SelectAllCheckbox({ rows, className }: { rows: Row[]; className?: string }) {
  const { enabled, selected, setMany, entity } = useSelection();
  if (!enabled || rows.length === 0) return null;
  const count = rows.filter((row) => selected.has(row.id)).length;
  return (
    <input
      type="checkbox"
      className={cn(CHECKBOX, className)}
      checked={count === rows.length}
      ref={(element) => {
        if (element) element.indeterminate = count > 0 && count < rows.length;
      }}
      onChange={(event) => setMany(rows, event.target.checked)}
      aria-label={`Select all ${REMOVAL[entity].plural} on this page`}
    />
  );
}

/** The one-row action: the same confirmation as the bulk one, for just this record. */
export function RowRemoveButton({ id, label, className }: Row & { className?: string }) {
  const { enabled, entity, confirm } = useSelection();
  if (!enabled) return null;
  const copy = REMOVAL[entity];
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        confirm([{ id, label }]);
      }}
      className={cn(
        'relative z-10 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
        className,
      )}
      aria-label={`${copy.verb} ${label}`}
      title={`${copy.verb} ${copy.singular}`}
    >
      <VerbIcon verb={copy.verb} className="size-4" />
    </button>
  );
}

/** Appears once anything is ticked: how many, and the action for all of them. */
function SelectionBar() {
  const { entity, selected, clear, confirm } = useSelection();
  if (selected.size === 0) return null;
  const copy = REMOVAL[entity];
  const tooMany = selected.size > MAX_REMOVE_AT_ONCE;
  return (
    <div
      role="region"
      aria-label="Selected rows"
      className="fixed inset-x-3 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-xl items-center gap-2 rounded-2xl border border-border bg-card/95 p-2 pl-4 shadow-raised backdrop-blur md:bottom-6"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums">
        {selected.size} {selected.size === 1 ? copy.singular : copy.plural} selected
        {tooMany ? (
          <span className="block text-xs font-normal text-destructive">
            Up to {MAX_REMOVE_AT_ONCE} at a time
          </span>
        ) : null}
      </span>
      <Button variant="ghost" size="sm" onClick={clear} aria-label="Clear selection">
        <X />
        <span className="hidden sm:inline">Clear</span>
      </Button>
      <Button
        variant="destructive"
        disabled={tooMany}
        onClick={() => confirm([...selected].map(([id, label]) => ({ id, label })))}
      >
        <VerbIcon verb={copy.verb} />
        {copy.verb} {selected.size}
      </Button>
    </div>
  );
}

function RemoveDialog({
  rows,
  onClose,
  onDone,
}: {
  rows: Row[] | null;
  onClose: () => void;
  onDone: (ids: string[]) => void;
}) {
  const { entity } = useSelection();
  const router = useRouter();
  const copy = REMOVAL[entity];
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<(RemovalOutcome & { labels: Map<string, string> }) | null>(
    null,
  );
  const [isPending, startTransition] = useTransition();

  const open = rows !== null;
  const count = rows?.length ?? 0;
  const what = count === 1 && rows ? rows[0].label : `${count} ${copy.plural}`;

  function close() {
    if (isPending) return;
    setReason('');
    setError(null);
    setReport(null);
    onClose();
  }

  function run() {
    if (!rows) return;
    const trimmed = reason.trim();
    if (copy.reason === 'required' && trimmed.length < 3) {
      setError(`Say why, in a few words — it is kept with each ${copy.singular}.`);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await removeRecordsAction({
        entity,
        ids: rows.map((row) => row.id),
        reason: trimmed || undefined,
      });
      if (!result.ok || !result.data) {
        setError(result.error ?? 'Nothing was changed. Please try again.');
        return;
      }
      const outcome = result.data;
      onDone(outcome.done);
      router.refresh();
      if (outcome.done.length > 0) {
        const archivedNote =
          outcome.archived > 0 ? ` (${outcome.archived} kept as archived — they have history)` : '';
        toast.success(
          `${outcome.done.length} ${outcome.done.length === 1 ? copy.singular : copy.plural} ${copy.past}${archivedNote}.`,
        );
      }
      if (outcome.skipped.length === 0) {
        close();
        return;
      }
      setReport({ ...outcome, labels: new Map(rows.map((row) => [row.id, row.label])) });
    });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : close())}>
      <DialogContent className="sm:max-w-md">
        {report ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {report.skipped.length} {report.skipped.length === 1 ? copy.singular : copy.plural}{' '}
                left as {report.skipped.length === 1 ? 'it was' : 'they were'}
              </DialogTitle>
              <DialogDescription>
                {report.done.length > 0
                  ? `${report.done.length} ${copy.past}. These were not changed:`
                  : 'Nothing was changed:'}
              </DialogDescription>
            </DialogHeader>
            <ul className="-mx-1 flex max-h-72 flex-col gap-2 overflow-y-auto px-1 text-sm">
              {report.skipped.map((row) => (
                <li key={row.id} className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                  <span className="font-medium">{report.labels.get(row.id) ?? copy.singular}</span>
                  <span className="block text-muted-foreground">{row.reason}</span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button onClick={close}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>
                {copy.verb} {what}?
              </DialogTitle>
              <DialogDescription>{copy.explain}</DialogDescription>
            </DialogHeader>
            {count > 1 && count <= 8 && rows ? (
              <ul className="flex flex-wrap gap-1.5 text-xs">
                {rows.map((row) => (
                  <li key={row.id} className="rounded-md bg-muted px-2 py-1 font-medium">
                    {row.label}
                  </li>
                ))}
              </ul>
            ) : null}
            <TextareaField
              name="removal-reason"
              label={copy.reason === 'required' ? 'Reason' : 'Reason (optional)'}
              required={copy.reason === 'required'}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              maxLength={500}
              rows={2}
              className="[&_textarea]:min-h-16"
              placeholder={
                copy.reason === 'required' ? 'e.g. Raised on the wrong customer' : 'For the history'
              }
              error={error ?? undefined}
            />
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={isPending}>
                Keep {count === 1 ? 'it' : 'them'}
              </Button>
              <Button variant="destructive" onClick={run} disabled={isPending}>
                {isPending ? <Loader2 className="animate-spin" /> : <VerbIcon verb={copy.verb} />}
                {isPending
                  ? 'Working…'
                  : `${copy.verb} ${count === 1 ? copy.singular : `${count} ${copy.plural}`}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/*
 * Table cells for the pieces above. They render nothing without the
 * permission, so a list's columns line up either way.
 */

export function SelectHead({ rows }: { rows: Row[] }) {
  const { enabled } = useSelection();
  if (!enabled) return null;
  return (
    <TableHead className="w-10 pr-0">
      <SelectAllCheckbox rows={rows} />
    </TableHead>
  );
}

/** `removable` false: this row can't be removed (say, a sent quotation), so it gets no box. */
export function SelectCell({ removable = true, ...row }: Row & { removable?: boolean }) {
  const { enabled } = useSelection();
  if (!enabled) return null;
  return <TableCell className="w-10 pr-0">{removable ? <RowCheckbox {...row} /> : null}</TableCell>;
}

export function RemoveHead() {
  const { enabled } = useSelection();
  if (!enabled) return null;
  return <TableHead className="w-12" aria-label="Actions" />;
}

export function RemoveCell({ removable = true, ...row }: Row & { removable?: boolean }) {
  const { enabled } = useSelection();
  if (!enabled) return null;
  return (
    <TableCell className="w-12 py-1 pr-2 text-right">
      {removable ? <RowRemoveButton {...row} /> : null}
    </TableCell>
  );
}
