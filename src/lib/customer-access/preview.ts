import type { Metadata } from 'next';
import { getCustomerAccess } from '@/lib/customer-access/access';
import { loadCustomerQuote } from '@/lib/customer-access/quote';
import { getInvoiceDocumentForLink } from '@/lib/documents/build';
import { formatAed } from '@/lib/documents/model';
import { getRequestOrigin } from '@/lib/request-origin';

/*
 * What a shared customer link shows before it is opened: the title, the
 * line under it and the picture (lib/brand/share-card) that WhatsApp puts
 * above the message. One place for the words, so the page's preview tags
 * and its picture always agree.
 */

export interface LinkPreview {
  workshop: string;
  title: string;
  description: string;
  heading: string | null;
  amountLabel: string | null;
  amount: string | null;
  button: string;
}

export async function quotePreview(rawToken: string): Promise<LinkPreview> {
  const access = await getCustomerAccess(rawToken, 'ESTIMATE');
  const workshop = access.state === 'invalid' ? 'Comet Autos' : access.organization.name;
  const quote = access.state === 'open' ? await loadCustomerQuote(rawToken) : null;
  if (!quote) {
    return {
      workshop,
      title: `Your quotation — ${workshop}`,
      description: 'Tap to open. If the link has expired, the workshop can send you a new one.',
      heading: 'Your quotation',
      amountLabel: null,
      amount: null,
      button: 'Open',
    };
  }
  const awaiting = quote.status === 'SENT' && !quote.expired && quote.approvals.length === 0;
  const total = formatAed(quote.totalAmount.toString());
  return {
    workshop,
    title: `Quotation ${quote.estimateNumber} — ${workshop}`,
    description: awaiting
      ? `Total ${total}. Tap to view and approve.`
      : `Total ${total}. Tap to view.`,
    heading: `Quotation ${quote.estimateNumber}`,
    amountLabel: 'Total',
    amount: total,
    button: awaiting ? 'View & approve' : 'View quotation',
  };
}

export async function invoicePreview(rawToken: string): Promise<LinkPreview> {
  const access = await getCustomerAccess(rawToken, 'INVOICE');
  const workshop = access.state === 'invalid' ? 'Comet Autos' : access.organization.name;
  const data =
    access.state === 'open'
      ? await getInvoiceDocumentForLink(access.organizationId, access.resourceId)
      : null;
  if (!data) {
    return {
      workshop,
      title: `Your invoice — ${workshop}`,
      description: 'Tap to open. If the link has expired, the workshop can send you a new one.',
      heading: 'Your invoice',
      amountLabel: null,
      amount: null,
      button: 'Open',
    };
  }
  const paid = data.balance.state === 'PAID';
  const amount = formatAed(paid ? data.balance.total : data.balance.balance);
  return {
    workshop,
    title: `Invoice ${data.document.number} — ${workshop}`,
    description: paid
      ? `Paid in full: ${amount}. Tap to view.`
      : `Balance due ${amount}. Tap to view.`,
    heading: `Invoice ${data.document.number}`,
    amountLabel: paid ? 'Paid' : 'Balance due',
    amount,
    button: 'View invoice',
  };
}

/** Page metadata for a customer link, with the preview WhatsApp shows when it is shared. */
export async function customerLinkMetadata(path: string, preview: LinkPreview): Promise<Metadata> {
  // Link previews need absolute addresses.
  const origin = await getRequestOrigin();
  return {
    title: preview.title,
    description: preview.description,
    robots: { index: false, follow: false },
    // Keep the secret link out of Referer headers sent to other sites.
    referrer: 'no-referrer',
    openGraph: {
      type: 'website',
      url: `${origin}${path}`,
      siteName: preview.workshop,
      title: preview.title,
      description: preview.description,
      images: [{ url: `${origin}${path}/preview`, width: 1200, height: 630, alt: preview.title }],
    },
  };
}
