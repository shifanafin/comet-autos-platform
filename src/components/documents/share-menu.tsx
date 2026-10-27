'use client';

import type { ReactElement } from 'react';
import { Copy, Download, MessageCircle, Printer, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

/*
 * Document actions shared by staff and customer screens. Nothing here talks
 * to the server beyond fetching the PDF the link points at.
 */

export const WHATSAPP = 'text-[#1fa855]';

/**
 * Whether this browser shows a PDF inside a page. Desktop Chrome, Edge,
 * Firefox and Safari do; phones and tablets (and an installed app on them)
 * mostly don't — they download a framed PDF instead of showing it, so there
 * would be nothing to print.
 */
function showsPdfInPage() {
  if (typeof navigator === 'undefined') return false;
  // Older browsers don't say; guess from the device.
  const nav: Navigator & { pdfViewerEnabled?: boolean } = navigator;
  if (typeof nav.pdfViewerEnabled === 'boolean') return nav.pdfViewerEnabled;
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent);
}

/**
 * Prints a document PDF.
 *
 * On a computer it loads the PDF into a hidden frame on this page and opens
 * the print dialog for it — the printer list is the computer's own. Where a
 * PDF can't be shown in a page (a phone, a tablet), it opens the PDF straight
 * away, within the tap, so no pop-up blocker stops it; print or share it from
 * there. If the frame can't be printed for any other reason, the PDF opens
 * in a new tab the same way.
 */
export function printPdf(url: string) {
  if (!showsPdfInPage()) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  // If the frame can't print, the PDF opens in a tab instead. That happens
  // after the tap, so a strict pop-up blocker may still ask to allow it once.
  let fallback: Window | null = null;
  const frame = document.createElement('iframe');
  frame.title = 'Document to print';
  frame.style.cssText =
    'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
  frame.src = url;
  frame.onload = () => {
    try {
      const target = frame.contentWindow;
      if (!target) throw new Error('No frame to print.');
      // The browser's PDF viewer needs a moment after load before it can print.
      setTimeout(() => {
        try {
          target.focus();
          target.print();
        } catch {
          fallback = window.open(url, '_blank', 'noopener');
        }
      }, 250);
    } catch {
      fallback = window.open(url, '_blank', 'noopener');
    }
    // Long enough for the print dialog to finish with it.
    setTimeout(() => frame.remove(), 60_000);
  };
  frame.onerror = () => {
    if (!fallback) fallback = window.open(url, '_blank', 'noopener');
    frame.remove();
  };
  document.body.appendChild(frame);
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const downloadUrl = (pdfUrl: string) =>
  `${pdfUrl}${pdfUrl.includes('?') ? '&' : '?'}download=1`;

export function ShareMenu({
  trigger,
  onWhatsApp,
  onCopyLink,
  pdfUrl,
}: {
  trigger: ReactElement;
  onWhatsApp: () => void;
  onCopyLink: () => void;
  pdfUrl: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={trigger} />
      <DropdownMenuContent align="end" className="min-w-52">
        <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">Share via</p>
        <DropdownMenuItem onClick={onWhatsApp} className="gap-2.5 py-2">
          <MessageCircle className={cn('size-4', WHATSAPP)} />
          WhatsApp
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onCopyLink} className="gap-2.5 py-2">
          <Copy className="size-4" />
          Copy link
        </DropdownMenuItem>
        <DropdownMenuItem render={<a href={downloadUrl(pdfUrl)} />} className="gap-2.5 py-2">
          <Download className="size-4" />
          Download PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Customer page actions: Download PDF · Print · Share. The customer shares
 * the page they are on (their own secure link); whoever opens it still has
 * to confirm the registration and mobile number.
 */
export function CustomerDocumentActions({
  pdfUrl,
  shareText,
}: {
  pdfUrl: string;
  shareText: string;
}) {
  const message = () => `${shareText}\n${window.location.href}`;
  return (
    <div className="grid grid-cols-3 gap-2">
      <Button
        variant="outline"
        className="h-11"
        nativeButton={false}
        render={<a href={downloadUrl(pdfUrl)} />}
      >
        <Download />
        PDF
      </Button>
      <Button variant="outline" className="h-11" onClick={() => printPdf(pdfUrl)}>
        <Printer />
        Print
      </Button>
      <ShareMenu
        pdfUrl={pdfUrl}
        trigger={
          <Button variant="outline" className="h-11">
            <Share2 />
            Share
          </Button>
        }
        onWhatsApp={() =>
          // api.whatsapp.com, not wa.me: wa.me's forwarding breaks emojis (lib/sharing/whatsapp.ts).
          window.open(
            `https://api.whatsapp.com/send?text=${encodeURIComponent(message())}`,
            '_blank',
            'noopener',
          )
        }
        onCopyLink={async () => {
          if (await copyText(window.location.href)) toast.success('Link copied');
        }}
      />
    </div>
  );
}
