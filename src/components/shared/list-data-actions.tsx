'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, FileSpreadsheet, Loader2, MoreHorizontal, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useFormAction } from '@/components/forms/use-form-action';
import type { ActionResult } from '@/lib/errors';
import type { ImportColumn, ImportOutcome } from '@/lib/data-transfer/imports';
import { importCsvAction } from '@/app/(app)/import/actions';
import { cn } from '@/lib/utils';

/*
 * Spreadsheet in, spreadsheet out, on the list itself.
 *
 * Export downloads exactly what the screen is showing — the same search and
 * filters, just without the page limit. Import is offered only on the lists
 * where it is safe (customers, vehicles, parts, suppliers); documents are
 * export-only so their numbering and VAT can't be bypassed.
 *
 * On a phone both collapse into one menu, so they never compete with the
 * screen's primary action.
 */

export function ListDataActions({
  entity,
  /** The screen's current query string, so the file matches the screen. */
  search,
  /** Import is offered when the list allows it and the user may create rows. */
  canImport = false,
  label,
  columns = [],
}: {
  entity: string;
  search?: string;
  canImport?: boolean;
  /** What the rows are called, e.g. "customers". */
  label: string;
  columns?: ImportColumn[];
}) {
  const [importing, setImporting] = useState(false);
  // Closing the dialog bumps this, which remounts it — so the next import
  // starts on a fresh form rather than the last one's report.
  const [session, setSession] = useState(0);
  const query = search && search.length > 0 ? `?${search}` : '';
  const exportHref = `/export/${entity}${query}`;

  function setImportOpen(open: boolean) {
    setImporting(open);
    if (!open) setSession((current) => current + 1);
  }

  return (
    <>
      {/* Phone: one quiet menu beside the primary action. */}
      <div className="sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="outline" size="icon" className="size-12" aria-label="Import or export" />}
          >
            <MoreHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            {/* A real link: the browser downloads the file rather than routing to it. */}
            <DropdownMenuItem className="gap-2.5 py-2.5" render={<a href={exportHref} />}>
              <Download className="size-4" />
              Export {label}
            </DropdownMenuItem>
            {canImport ? (
              <DropdownMenuItem className="gap-2.5 py-2.5" onClick={() => setImportOpen(true)}>
                <Upload className="size-4" />
                Import {label}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Tablet and up: the buttons themselves. */}
      <div className="hidden gap-2 sm:flex">
        {canImport ? (
          <Button variant="outline" className="h-10" onClick={() => setImportOpen(true)}>
            <Upload />
            Import
          </Button>
        ) : null}
        <Button
          variant="outline"
          className="h-10"
          nativeButton={false}
          render={<a href={exportHref} />}
        >
          <Download />
          Export
        </Button>
      </div>

      {canImport ? (
        <ImportDialog
          key={session}
          entity={entity}
          label={label}
          columns={columns}
          open={importing}
          onOpenChange={setImportOpen}
        />
      ) : null}
    </>
  );
}

function ImportDialog({
  entity,
  label,
  columns,
  open,
  onOpenChange,
}: {
  entity: string;
  label: string;
  columns: ImportColumn[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [state, onSubmit, isPending] = useFormAction<ActionResult<ImportOutcome>>(
    async (previous, formData) => {
      const result = await importCsvAction(entity, previous, formData);
      if (result.ok && result.data && result.data.created > 0) {
        toast.success(`${result.data.created} ${label} imported`);
        router.refresh();
      }
      return result;
    },
    { ok: false },
  );
  const outcome = state.ok ? state.data : undefined;

  function close(next: boolean) {
    if (isPending) return;
    onOpenChange(next);
    if (!next) {
      formRef.current?.reset();
      setFileName(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import {label}</DialogTitle>
          <DialogDescription>
            A CSV file, one row per {label.replace(/s$/, '')}. Rows already on file are skipped, and
            if any row can&apos;t be read nothing is imported.
          </DialogDescription>
        </DialogHeader>

        {outcome ? (
          <ImportReport outcome={outcome} label={label} onDone={() => close(false)} />
        ) : (
          <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-5">
            <a
              href={`/import/${entity}/template`}
              className="inline-flex items-center gap-2 self-start text-sm font-medium text-primary hover:underline"
            >
              <FileSpreadsheet className="size-4" />
              Download the template
            </a>

            {columns.length > 0 ? (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-3">
                <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
                  Columns
                </p>
                <ul className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                  {columns.map((column) => (
                    <li key={column.header} className={column.required ? 'font-semibold' : 'text-muted-foreground'}>
                      {column.header}
                      {column.required ? ' *' : ''}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  * required. Extra columns are ignored, and the order doesn&apos;t matter.
                </p>
              </div>
            ) : null}

            <label className="flex flex-col gap-2">
              <span className="text-sm font-medium">CSV file</span>
              <input
                type="file"
                name="file"
                accept=".csv,text/csv"
                required
                onChange={(event) => setFileName(event.target.files?.[0]?.name ?? null)}
                className="block w-full text-sm file:mr-3 file:h-11 file:cursor-pointer file:rounded-lg file:border file:border-border file:bg-card file:px-4 file:text-sm file:font-medium hover:file:bg-muted"
              />
              {fileName ? <span className="text-xs text-muted-foreground">{fileName}</span> : null}
            </label>

            {state.error ? (
              <p
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
              >
                {state.error}
              </p>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-2">
              <Button type="submit" className="h-12 sm:h-11" disabled={isPending}>
                {isPending ? <Loader2 className="animate-spin" /> : <Upload />}
                {isPending ? 'Importing…' : 'Import'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="h-12 sm:h-11"
                disabled={isPending}
                onClick={() => close(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportReport({
  outcome,
  label,
  onDone,
}: {
  outcome: ImportOutcome;
  label: string;
  onDone: () => void;
}) {
  const failed = outcome.errors.length > 0;
  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          'rounded-lg border px-4 py-3 text-sm',
          failed ? 'border-destructive/30 bg-destructive/5' : 'border-success/30 bg-success/5',
        )}
      >
        <p className={cn('font-semibold', failed ? 'text-destructive' : 'text-success')}>
          {failed
            ? 'Nothing was imported'
            : `${outcome.created} ${label} imported`}
        </p>
        <p className="mt-1 text-muted-foreground">
          {failed
            ? `${outcome.errors.length} of ${outcome.total} rows could not be read. Fix them and import the file again — nothing was saved.`
            : outcome.skipped.length > 0
              ? `${outcome.skipped.length} row${outcome.skipped.length === 1 ? ' was' : 's were'} already on file and left alone.`
              : `All ${outcome.total} rows were new.`}
        </p>
      </div>

      {outcome.errors.length > 0 ? (
        <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto text-sm">
          {outcome.errors.slice(0, 40).map((error) => (
            <li key={error.row} className="flex gap-2">
              <span className="w-14 shrink-0 text-muted-foreground tabular-nums">Row {error.row}</span>
              <span>{error.message}</span>
            </li>
          ))}
          {outcome.errors.length > 40 ? (
            <li className="text-muted-foreground">…and {outcome.errors.length - 40} more.</li>
          ) : null}
        </ul>
      ) : null}

      {!failed && outcome.skipped.length > 0 ? (
        <ul className="flex max-h-40 flex-col gap-1.5 overflow-y-auto text-sm text-muted-foreground">
          {outcome.skipped.slice(0, 20).map((skip) => (
            <li key={skip.row} className="flex gap-2">
              <span className="w-14 shrink-0 tabular-nums">Row {skip.row}</span>
              <span>{skip.reason}</span>
            </li>
          ))}
          {outcome.skipped.length > 20 ? (
            <li>…and {outcome.skipped.length - 20} more.</li>
          ) : null}
        </ul>
      ) : null}

      <Button className="h-12 sm:h-11" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}
