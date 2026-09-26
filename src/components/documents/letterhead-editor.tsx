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
import { cleanPastedHtml } from '@/lib/documents/letter-paste';
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
 * The body is a contentEditable area with a small toolbar. Text pasted from
 * Word or a web page keeps its bold, italic, underline, headings and lists;
 * everything else — fonts, colours, images, links, scripts — is dropped
 * (see lib/documents/letter-paste.ts).
 */

interface LocalExtras {
  arabicName: string;
  website: string;
  /** A small image as a data URL. */
  logo: string;
}

const EMPTY_EXTRAS: LocalExtras = { arabicName: '', website: '', logo: '' };
/** A plain office typeface; each computer uses the first it has. */
const LETTER_FONT = "Calibri, Carlito, 'Segoe UI', Arial, sans-serif";
const ARABIC_FONT = "'Traditional Arabic', 'Segoe UI', 'Noto Naskh Arabic', serif";
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

/** The letterhead's double line: a heavy rule over a hairline. */
function Rule({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('flex flex-col gap-0.5', className)}>
      <div className="h-0.75 bg-neutral-600" />
      <div className="h-px bg-neutral-600" />
    </div>
  );
}

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
    const html = event.clipboardData.getData('text/html');
    if (html) format('insertHTML', cleanPastedHtml(html));
    else format('insertText', event.clipboardData.getData('text/plain'));
    saveDraft();
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

      {/*
       * The A4 page — the only thing printed.
       *
       * On screen it is one sheet. In print the header, footer and watermark
       * are fixed to the page, so the browser repeats them on every page of a
       * long letter; the table's header and footer rows are blank spacers the
       * browser also repeats, keeping the text clear of them on each page.
       * Sizes: header 38mm + 8mm gap, footer 28mm + 8mm gap.
       */}
      <div className="overflow-x-auto pb-2">
        <article
          className="letterhead-page relative mx-auto flex min-h-[297mm] w-[210mm] flex-col bg-white px-[18mm] text-black shadow-md ring-1 ring-black/5 print:block print:min-h-0 print:w-auto print:shadow-none print:ring-0"
          style={{ fontFamily: LETTER_FONT }}
          aria-label="Letter"
        >
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 print:fixed"
          >
            {extras.logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local data URL, not a remote image
              <img src={extras.logo} alt="" className="w-[125mm] max-w-none opacity-[0.09]" />
            ) : (
              <p className="w-[150mm] text-center text-[34px] leading-tight font-black tracking-[2px] uppercase opacity-[0.07]">
                {details.legalName}
              </p>
            )}
          </div>

          <header className="relative flex h-[38mm] items-center gap-5 pt-[12mm] print:fixed print:inset-x-[18mm] print:top-0">
            <div className="min-w-0 flex-1">
              {extras.arabicName ? (
                <p
                  dir="rtl"
                  className="w-fit text-[19px] leading-snug font-bold text-neutral-800"
                  style={{ fontFamily: ARABIC_FONT }}
                >
                  {extras.arabicName}
                </p>
              ) : null}
              <Rule className="mt-1.5" />
              <p className="mt-2 text-[15px] tracking-[0.6px] text-neutral-700 uppercase">
                {details.legalName}
              </p>
            </div>
            {extras.logo ? (
              // eslint-disable-next-line @next/next/no-img-element -- a local data URL, not a remote image
              <img
                src={extras.logo}
                alt=""
                className="max-h-[26mm] max-w-[48mm] shrink-0 object-contain"
              />
            ) : null}
          </header>

          <table className="relative my-[8mm] w-full border-collapse print:my-0">
            <thead className="hidden print:table-header-group">
              <tr>
                <td className="h-[46mm] p-0" />
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="p-0 align-top">
                  <div
                    ref={bodyRef}
                    contentEditable
                    suppressContentEditableWarning
                    role="textbox"
                    aria-multiline
                    aria-label="Letter text"
                    data-placeholder="Type or paste the letter here…"
                    onInput={saveDraft}
                    onBlur={saveDraft}
                    onPaste={onPaste}
                    className={cn(
                      'min-h-[150mm] px-[6mm] text-[14.5px] leading-relaxed outline-none print:min-h-0',
                      'empty:before:text-neutral-400 empty:before:content-[attr(data-placeholder)]',
                      '[&_h3]:mt-4 [&_h3]:mb-2 [&_h3]:text-[18px] [&_h3]:font-bold [&_h4]:font-bold',
                      '[&_ol]:list-decimal [&_ol]:pl-7 [&_ul]:list-disc [&_ul]:pl-7 [&_li]:my-0.5',
                      '[&_ol_ol]:list-[lower-alpha] [&_ul_ul]:list-[circle]',
                      '[&_p]:my-2 [&_div]:min-h-lh [&_li]:break-inside-avoid',
                    )}
                  />
                </td>
              </tr>
            </tbody>
            <tfoot className="hidden print:table-footer-group">
              <tr>
                <td className="h-[36mm] p-0" />
              </tr>
            </tfoot>
          </table>

          <footer className="relative mt-auto flex h-[28mm] flex-col justify-end pb-[10mm] print:fixed print:inset-x-[18mm] print:bottom-0">
            <Rule />
            {contact.length ? (
              <div className="mt-3 flex flex-wrap items-center justify-around gap-x-6 gap-y-1 text-[13px] text-neutral-800">
                {contact.map(({ icon: Icon, value }) => (
                  <span key={value} className="flex items-center gap-1.5">
                    <Icon className="size-3.5" aria-hidden />
                    {value}
                  </span>
                ))}
              </div>
            ) : null}
            {details.address ? (
              <p className="mt-1 text-center text-[13px] font-semibold text-neutral-800">
                {details.address}
              </p>
            ) : null}
          </footer>
        </article>
      </div>
    </div>
  );
}
