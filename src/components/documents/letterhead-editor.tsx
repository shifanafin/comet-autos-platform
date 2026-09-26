'use client';

import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent } from 'react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  CalendarDays,
  Eraser,
  Heading,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Mail,
  MapPin,
  Phone,
  Printer,
  Trash2,
  Underline,
  Globe,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmAction } from '@/components/shared/confirm-action';
import { formatDate } from '@/lib/format';
import type { LetterheadDetails } from '@/lib/documents/letterhead';
import { cn } from '@/lib/utils';

/*
 * A letter on the company letterhead: typed here, printed or saved as a PDF
 * from the browser's print dialog.
 *
 * The name, phone, email and address come from Settings. The Arabic name,
 * website and logo are kept in this browser (with the draft), so nothing
 * about the letterhead is written into the code.
 *
 * The body is a contentEditable area with a small toolbar. Pasted content
 * arrives as plain text, so formatting from other programs — and anything
 * that isn't text — never comes along.
 */

interface LocalExtras {
  arabicName: string;
  website: string;
  /** A small image as a data URL. */
  logo: string;
}

const EMPTY_EXTRAS: LocalExtras = { arabicName: '', website: '', logo: '' };
/** Large enough for a logo, small enough for browser storage. */
const MAX_LOGO_BYTES = 300 * 1024;

interface Tool {
  label: string;
  icon: LucideIcon;
  /** A document.execCommand command. */
  command: string;
  value?: string;
  /** Inserts today's date, worked out when pressed. */
  today?: boolean;
}

const TOOLS: Tool[] = [
  { label: 'Bold', icon: Bold, command: 'bold' },
  { label: 'Italic', icon: Italic, command: 'italic' },
  { label: 'Underline', icon: Underline, command: 'underline' },
  { label: 'Heading', icon: Heading, command: 'formatBlock', value: 'h3' },
  { label: 'Bulleted list', icon: List, command: 'insertUnorderedList' },
  { label: 'Numbered list', icon: ListOrdered, command: 'insertOrderedList' },
  { label: 'Align left', icon: AlignLeft, command: 'justifyLeft' },
  { label: 'Centre', icon: AlignCenter, command: 'justifyCenter' },
  { label: 'Align right', icon: AlignRight, command: 'justifyRight' },
  { label: 'Insert today’s date', icon: CalendarDays, command: 'insertText', today: true },
  { label: 'Clear formatting', icon: Eraser, command: 'removeFormat' },
];

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or disabled: the letter still prints, it just isn't kept.
  }
}

/** Runs a formatting command on the current selection in the letter. */
function format(command: string, value?: string) {
  // execCommand is the one formatting API every browser supports for
  // contentEditable without a library; it is deprecated but not going away.
  document.execCommand(command, false, value);
}

export function LetterheadEditor({
  details,
  storageKey,
}: {
  details: LetterheadDetails;
  /** Scopes what this browser keeps to one workshop. */
  storageKey: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [extras, setExtras] = useState<LocalExtras>(EMPTY_EXTRAS);
  const [logoError, setLogoError] = useState<string | null>(null);
  const extrasKey = `${storageKey}:letterhead`;
  const draftKey = `${storageKey}:letter-draft`;

  // Load what this browser kept: the extra details and the last draft.
  useEffect(() => {
    const timeout = setTimeout(() => {
      setExtras({ ...EMPTY_EXTRAS, ...read<Partial<LocalExtras>>(extrasKey, {}) });
      if (bodyRef.current) bodyRef.current.innerHTML = read<string>(draftKey, '');
    }, 0);
    return () => clearTimeout(timeout);
  }, [extrasKey, draftKey]);

  function updateExtras(patch: Partial<LocalExtras>) {
    setExtras((current) => {
      const next = { ...current, ...patch };
      write(extrasKey, next);
      return next;
    });
  }

  function saveDraft() {
    if (bodyRef.current) write(draftKey, bodyRef.current.innerHTML);
  }

  function onPaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    format('insertText', event.clipboardData.getData('text/plain'));
  }

  function onLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLogoError(null);
    if (!file.type.startsWith('image/')) return setLogoError('Choose an image file.');
    if (file.size > MAX_LOGO_BYTES) return setLogoError('Choose an image under 300 KB.');
    const reader = new FileReader();
    reader.onload = () => updateExtras({ logo: String(reader.result) });
    reader.readAsDataURL(file);
  }

  function run(command: string, value?: string) {
    bodyRef.current?.focus();
    format(command, value);
    saveDraft();
  }

  function clearLetter() {
    if (bodyRef.current) bodyRef.current.innerHTML = '';
    saveDraft();
  }

  function apply(tool: Tool) {
    run(tool.command, tool.today ? formatDate(new Date()) : tool.value);
  }

  const contact: { icon: LucideIcon; value: string }[] = [
    { icon: Phone, value: details.phone },
    { icon: Mail, value: details.email },
    { icon: Globe, value: extras.website },
  ].filter((item) => item.value);

  return (
    <div className="flex flex-col gap-6">
      {/* Controls — never printed. */}
      <div className="letterhead-controls flex flex-col gap-4">
        <div className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-3 sm:p-5">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Name in Arabic</span>
            <Input
              dir="rtl"
              value={extras.arabicName}
              onChange={(event) => updateExtras({ arabicName: event.target.value })}
              placeholder="الاسم بالعربية"
              className="h-10"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Website</span>
            <Input
              value={extras.website}
              onChange={(event) => updateExtras({ website: event.target.value })}
              placeholder="www.example.com"
              className="h-10"
            />
          </label>
          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Logo</span>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-lg border border-border bg-card px-3 font-medium hover:bg-muted">
                <ImagePlus className="size-4" />
                {extras.logo ? 'Change' : 'Add logo'}
                <input type="file" accept="image/*" className="sr-only" onChange={onLogo} />
              </label>
              {extras.logo ? (
                <Button variant="ghost" size="sm" onClick={() => updateExtras({ logo: '' })}>
                  Remove
                </Button>
              ) : null}
            </div>
            {logoError ? <span className="text-xs text-destructive">{logoError}</span> : null}
          </div>
          <p className="text-xs text-muted-foreground sm:col-span-3">
            The name, phone, email and address come from Settings. These three are kept in this
            browser only.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="toolbar"
            aria-label="Formatting"
            className="flex flex-wrap gap-1 rounded-lg border border-border bg-card p-1"
          >
            {TOOLS.map((tool) => {
              const Icon = tool.icon;
              return (
                <Button
                  key={tool.label}
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={tool.label}
                  title={tool.label}
                  // Keep the selection in the letter while the button is pressed.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => apply(tool)}
                >
                  <Icon />
                </Button>
              );
            })}
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <ConfirmAction
              trigger={
                <Button variant="outline">
                  <Trash2 />
                  New letter
                </Button>
              }
              title="Start a new letter?"
              description="The text of this letter is cleared. The letterhead details stay."
              confirmLabel="Clear letter"
              onConfirm={async () => clearLetter()}
            />
            <Button onClick={() => window.print()}>
              <Printer />
              Print / Save as PDF
            </Button>
          </div>
        </div>
      </div>

      {/* The A4 page — the only thing printed. */}
      <div className="overflow-x-auto pb-2">
        <article
          className="letterhead-page relative mx-auto flex min-h-[297mm] w-[210mm] flex-col justify-between bg-white px-[20mm] pt-[15mm] pb-[20mm] text-black shadow-md ring-1 ring-black/5"
          aria-label="Letter"
        >
          {/* Watermark */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-[15%] top-1/2 -translate-y-1/2 text-center text-[32px] leading-tight font-black tracking-[2px] uppercase opacity-[0.07]"
          >
            {details.legalName}
          </div>

          <div className="relative flex flex-1 flex-col">
            <header className="flex items-start justify-between gap-6 pb-2.5">
              <div className="flex min-w-0 flex-col gap-1">
                {extras.arabicName ? (
                  <p
                    dir="rtl"
                    className="text-[18px] font-bold"
                    style={{ fontFamily: "'Amiri', 'Traditional Arabic', 'Segoe UI', sans-serif" }}
                  >
                    {extras.arabicName}
                  </p>
                ) : null}
                <p className="text-[14px] font-bold tracking-[0.5px] uppercase">
                  {details.legalName}
                </p>
              </div>
              {extras.logo ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local data URL, not a remote image
                <img src={extras.logo} alt="" className="max-h-20 max-w-[45mm] object-contain" />
              ) : null}
            </header>

            <div
              ref={bodyRef}
              contentEditable
              suppressContentEditableWarning
              role="textbox"
              aria-multiline
              aria-label="Letter text"
              data-placeholder="Type the letter here…"
              onInput={saveDraft}
              onBlur={saveDraft}
              onPaste={onPaste}
              className={cn(
                'mt-[30px] mb-10 flex-1 text-[14px] leading-relaxed outline-none',
                'empty:before:text-neutral-400 empty:before:content-[attr(data-placeholder)]',
                '[&_h3]:mb-1 [&_h3]:text-[17px] [&_h3]:font-bold [&_h4]:font-bold',
                '[&_ol]:list-decimal [&_ol]:pl-6 [&_ul]:list-disc [&_ul]:pl-6 [&_li]:my-0.5',
                '[&_p]:my-2 [&_div]:min-h-[1lh]',
              )}
            />
          </div>

          <footer className="relative">
            <div className="mb-3 h-[2px] border-t-2 border-b border-black" />
            {contact.length ? (
              <div className="mb-1.5 flex flex-wrap items-center justify-around gap-x-6 gap-y-1 text-[12px] font-bold">
                {contact.map(({ icon: Icon, value }) => (
                  <span key={value} className="flex items-center gap-1.5">
                    <Icon className="size-3.5" aria-hidden />
                    {value}
                  </span>
                ))}
              </div>
            ) : null}
            {details.address ? (
              <p className="flex items-center justify-center gap-1.5 text-center text-[11px] font-bold">
                <MapPin className="size-3" aria-hidden />
                {details.address}
              </p>
            ) : null}
          </footer>
        </article>
      </div>
    </div>
  );
}
