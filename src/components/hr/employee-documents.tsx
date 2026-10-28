'use client';

import { useId, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FilePlus2, Paperclip, Pencil, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, FormError, NativeSelect, TextField } from '@/components/forms/fields';
import { SubmitButton } from '@/components/forms/submit-button';
import { useFormAction } from '@/components/forms/use-form-action';
import { StatusPill } from '@/components/shared/status-pill';
import type { ActionResult } from '@/lib/errors';
import type { EmployeeDocumentKind } from '@/generated/prisma/enums';
import { formatCalendarDate } from '@/lib/format';
import {
  addEmployeeDocumentAction,
  removeEmployeeDocumentAction,
  removeEmployeeDocumentFileAction,
  updateEmployeeDocumentAction,
} from '@/app/(app)/hr/actions';

/*
 * An employee's papers: a checklist of what every employee needs, each
 * document with its number and expiry, and its copies (photos or PDFs —
 * front, back). Copies open in a new tab; a phone can photograph one
 * straight from the camera.
 */

export interface DocumentKindOption {
  kind: EmployeeDocumentKind;
  label: string;
  expires: boolean;
}

export interface DocumentRow {
  id: string;
  kind: EmployeeDocumentKind;
  label: string;
  documentNumber: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  notes: string | null;
  status: 'expired' | 'soon' | 'valid' | 'none';
  replaced: boolean;
  /** Days to the expiry (negative once past). */
  days: number | null;
  files: { id: string; fileName: string }[];
}

const ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

/** Uploads copies one by one; returns how many failed (each told by a toast). */
async function uploadCopies(documentId: string, files: File[]) {
  let failed = 0;
  for (const file of files) {
    const form = new FormData();
    form.set('file', file);
    const response = await fetch(`/hr/employees/documents/${documentId}/file`, {
      method: 'POST',
      body: form,
    });
    const result = (await response.json().catch(() => null)) as {
      ok: boolean;
      error?: string;
    } | null;
    if (!result?.ok) {
      failed += 1;
      toast.error(result?.error ?? `“${file.name}” could not be added.`);
    }
  }
  return failed;
}

function ExpiryPill({ row }: { row: DocumentRow }) {
  if (row.replaced) return <StatusPill tone="neutral">Replaced by a newer one</StatusPill>;
  if (row.status === 'expired') {
    return (
      <StatusPill tone="danger">
        {row.days === 0 ? 'Expired today' : `Expired ${Math.abs(row.days ?? 0)} days ago`}
      </StatusPill>
    );
  }
  if (row.status === 'soon') {
    return (
      <StatusPill tone="warning">
        {row.days === 0 ? 'Expires today' : `Expires in ${row.days} days`}
      </StatusPill>
    );
  }
  if (row.status === 'valid') return <StatusPill tone="success">Valid</StatusPill>;
  return null;
}

export function EmployeeDocuments({
  employeeId,
  kinds,
  documents,
  missing,
}: {
  employeeId: string;
  kinds: DocumentKindOption[];
  documents: DocumentRow[];
  missing: DocumentKindOption[];
}) {
  const [adding, setAdding] = useState<EmployeeDocumentKind | null>(null);

  return (
    <div className="flex flex-col">
      {missing.length > 0 ? (
        <div className="flex flex-col gap-2 border-b border-border bg-warning/5 px-4 py-3 sm:px-6">
          <p className="text-sm font-medium">Still needed</p>
          <div className="flex flex-wrap gap-2">
            {missing.map((option) => (
              <Button
                key={option.kind}
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAdding(option.kind)}
              >
                <FilePlus2 />
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      {documents.length === 0 ? (
        <p className="px-4 py-5 text-sm text-muted-foreground sm:px-6">
          No documents yet. Add a photo or PDF of each one — the passport, visa, Emirates ID, work
          permit, labour contract and health insurance card first.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {documents.map((row) => (
            <DocumentItem key={row.id} row={row} kinds={kinds} />
          ))}
        </ul>
      )}

      <div className="border-t border-border px-4 py-4 sm:px-6">
        {adding !== null ? (
          <AddDocumentForm
            key={adding}
            employeeId={employeeId}
            kinds={kinds}
            initialKind={adding}
            onDone={() => setAdding(null)}
          />
        ) : (
          <Button type="button" variant="outline" onClick={() => setAdding('PASSPORT')}>
            <FilePlus2 />
            Add document
          </Button>
        )}
      </div>
    </div>
  );
}

function DocumentItem({ row, kinds }: { row: DocumentRow; kinds: DocumentKindOption[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [isPending, startTransition] = useTransition();
  const input = useRef<HTMLInputElement>(null);

  async function addCopies(files: File[]) {
    if (files.length === 0) return;
    setUploading(true);
    try {
      const failed = await uploadCopies(row.id, files);
      if (failed < files.length)
        toast.success(files.length - failed === 1 ? 'Copy added' : 'Copies added');
      router.refresh();
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <li className={row.replaced ? 'px-4 py-4 opacity-70 sm:px-6' : 'px-4 py-4 sm:px-6'}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{row.label}</span>
            <ExpiryPill row={row} />
          </span>
          <span className="text-xs text-muted-foreground">
            {[
              row.documentNumber ? `No. ${row.documentNumber}` : null,
              row.issueDate ? `Issued ${formatCalendarDate(row.issueDate)}` : null,
              row.expiryDate ? `Expires ${formatCalendarDate(row.expiryDate)}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'No number or dates recorded'}
          </span>
          {row.notes ? <span className="text-xs text-muted-foreground">{row.notes}</span> : null}
        </div>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing((open) => !open)}
            aria-expanded={editing}
          >
            <Pencil />
            Edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={() => {
              if (!window.confirm(`Remove this ${row.label.toLowerCase()} from the record?`))
                return;
              startTransition(async () => {
                const result = await removeEmployeeDocumentAction(row.id);
                if (result.ok) router.refresh();
                else toast.error(result.error ?? 'Could not remove it.');
              });
            }}
            aria-label={`Remove ${row.label}`}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        {row.files.map((file) => (
          <span key={file.id} className="inline-flex items-center gap-0.5">
            <a
              href={`/hr/employees/documents/files/${file.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex max-w-48 items-center gap-1 truncate text-xs text-primary hover:underline"
              title={file.fileName}
            >
              <Paperclip className="size-3 shrink-0" />
              <span className="truncate">{file.fileName}</span>
            </a>
            <button
              type="button"
              aria-label={`Remove ${file.fileName}`}
              disabled={isPending}
              onClick={() =>
                startTransition(async () => {
                  const result = await removeEmployeeDocumentFileAction(file.id);
                  if (result.ok) router.refresh();
                  else toast.error(result.error ?? 'Could not remove it.');
                })
              }
              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        {row.files.length === 0 ? (
          <span className="text-xs text-warning">No copy kept yet</span>
        ) : null}
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(event) => void addCopies(Array.from(event.target.files ?? []))}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={uploading}
          onClick={() => input.current?.click()}
          className="h-7 px-2 text-xs"
        >
          <Paperclip className="size-3" />
          {uploading ? 'Adding…' : 'Add copy'}
        </Button>
      </div>

      {editing ? (
        <div className="mt-4">
          <EditDocumentForm row={row} kinds={kinds} onDone={() => setEditing(false)} />
        </div>
      ) : null}
    </li>
  );
}

function DocumentFields({
  kinds,
  errors,
  defaults,
}: {
  kinds: DocumentKindOption[];
  errors: Record<string, string>;
  defaults: Partial<
    Pick<DocumentRow, 'kind' | 'documentNumber' | 'issueDate' | 'expiryDate' | 'notes'>
  >;
}) {
  // Several of these forms can be open at once: each its own ids.
  const id = useId();
  return (
    <div className="@container">
      <div className="grid gap-4 @md:grid-cols-2">
        <Field label="Document" htmlFor={`${id}-kind`} error={errors.kind}>
          <NativeSelect
            id={`${id}-kind`}
            name="kind"
            defaultValue={defaults.kind ?? 'PASSPORT'}
            className="h-11"
          >
            {kinds.map((option) => (
              <option key={option.kind} value={option.kind}>
                {option.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <TextField
          id={`${id}-number`}
          label="Number"
          name="documentNumber"
          defaultValue={defaults.documentNumber ?? ''}
          error={errors.documentNumber}
          hint="Optional"
        />
        <TextField
          id={`${id}-issued`}
          label="Issued on"
          name="issueDate"
          type="date"
          defaultValue={defaults.issueDate ?? ''}
          error={errors.issueDate}
          hint="Optional"
        />
        <TextField
          id={`${id}-expires`}
          label="Expires on"
          name="expiryDate"
          type="date"
          defaultValue={defaults.expiryDate ?? ''}
          error={errors.expiryDate}
          hint="Flagged 30 days before."
        />
        <TextField
          id={`${id}-notes`}
          label="Note"
          name="notes"
          defaultValue={defaults.notes ?? ''}
          error={errors.notes}
          hint="Optional"
          className="@md:col-span-2"
        />
      </div>
    </div>
  );
}

function AddDocumentForm({
  employeeId,
  kinds,
  initialKind,
  onDone,
}: {
  employeeId: string;
  kinds: DocumentKindOption[];
  initialKind: EmployeeDocumentKind;
  onDone: () => void;
}) {
  const router = useRouter();
  const filesId = useId();
  const [state, onSubmit, isPending] = useFormAction<ActionResult<{ id: string }>>(
    async (prev, formData) => {
      // The copies go to their own upload route: a scan can pass the action's size limit.
      const files = formData
        .getAll('files')
        .filter((value): value is File => value instanceof File && value.size > 0);
      formData.delete('files');
      const result = await addEmployeeDocumentAction(employeeId, prev, formData);
      if (result.ok && result.data) {
        const failed = files.length ? await uploadCopies(result.data.id, files) : 0;
        if (failed === 0) toast.success('Document added');
        router.refresh();
        onDone();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <DocumentFields kinds={kinds} errors={errors} defaults={{ kind: initialKind }} />
      <Field
        label="Copies"
        htmlFor={filesId}
        hint="Photos or PDFs, up to 10 MB each — the front and the back."
      >
        <input
          id={filesId}
          name="files"
          type="file"
          accept={ACCEPT}
          multiple
          className="block w-full text-sm file:mr-3 file:h-10 file:rounded-md file:border file:border-border file:bg-card file:px-3 file:text-sm file:font-medium"
        />
      </Field>
      <FormError message={state.error} />
      <div className="flex flex-wrap gap-3">
        <SubmitButton pending={isPending} pendingLabel="Saving…">
          Save document
        </SubmitButton>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function EditDocumentForm({
  row,
  kinds,
  onDone,
}: {
  row: DocumentRow;
  kinds: DocumentKindOption[];
  onDone: () => void;
}) {
  const router = useRouter();
  const [state, onSubmit, isPending] = useFormAction<ActionResult>(
    async (prev, formData) => {
      const result = await updateEmployeeDocumentAction(row.id, prev, formData);
      if (result.ok) {
        toast.success('Document updated');
        router.refresh();
        onDone();
      }
      return result;
    },
    { ok: false },
  );
  const errors = state.fieldErrors ?? {};

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <p className="text-xs text-muted-foreground">
        Correct the details here. A renewed passport or visa is added as a new document — the old
        one then shows as replaced.
      </p>
      <DocumentFields kinds={kinds} errors={errors} defaults={row} />
      <FormError message={state.error} />
      <div className="flex flex-wrap gap-3">
        <SubmitButton pending={isPending} pendingLabel="Saving…">
          Save changes
        </SubmitButton>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
