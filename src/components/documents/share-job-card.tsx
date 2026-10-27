'use client';

import { useRef, useState } from 'react';
import { Check, Copy, Loader2, MessageCircle } from 'lucide-react';
import { toast } from 'sonner';
import { copyText } from '@/components/documents/share-menu';
import { shareDocumentAction, type ShareActionData } from '@/app/(app)/documents/actions';

const BUTTON =
  'inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted disabled:opacity-60';

/**
 * Shares the job card with its customer: a secure link to where the job is
 * and the work approved (app/customer/job). One link per visit.
 */
export function ShareJobCard({ jobCardId }: { jobCardId: string }) {
  const shared = useRef<ShareActionData | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function prepare(): Promise<ShareActionData | null> {
    if (shared.current) return shared.current;
    setBusy(true);
    const result = await shareDocumentAction({ kind: 'job_card', id: jobCardId });
    setBusy(false);
    if (!result.ok || !result.data) {
      toast.error(result.error ?? 'Could not create the customer link.');
      return null;
    }
    shared.current = result.data;
    return result.data;
  }

  async function whatsApp() {
    // Open the tab inside the click, so pop-up blockers allow it.
    const tab = shared.current ? null : window.open('about:blank', '_blank');
    const data = await prepare();
    if (!data) return tab?.close();
    if (tab) tab.location.href = data.whatsappUrl;
    else window.open(data.whatsappUrl, '_blank', 'noopener');
    toast.success('WhatsApp opened with the message ready to send');
  }

  async function copyLink() {
    const data = await prepare();
    if (data && (await copyText(data.link))) {
      setCopied(true);
      toast.success('Secure customer link copied');
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <>
      <button type="button" className={BUTTON} onClick={whatsApp} disabled={busy}>
        {busy ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : (
          <MessageCircle className="size-4 text-muted-foreground" />
        )}
        Share
      </button>
      <button
        type="button"
        className={BUTTON}
        onClick={copyLink}
        disabled={busy}
        aria-label="Copy the customer link"
      >
        {copied ? (
          <Check className="size-4 text-success" />
        ) : (
          <Copy className="size-4 text-muted-foreground" />
        )}
        <span className="hidden sm:inline">Copy link</span>
      </button>
    </>
  );
}
