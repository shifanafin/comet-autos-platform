import type { Metadata, Viewport } from 'next';
import { CheckCircle2, Clock, FileDown, Link2Off, Receipt } from 'lucide-react';
import { getCustomerAccess } from '@/lib/customer-access/access';
import { getInvoiceDocumentForLink } from '@/lib/documents/build';
import { formatAed } from '@/lib/documents/model';
import { formatDate } from '@/lib/format';
import { customerLinkMetadata, invoicePreview } from '@/lib/customer-access/preview';
import {
  CUSTOMER_BAR_COLOR,
  CustomerNotice,
  CustomerShell,
} from '@/components/customer/customer-shell';
import {
  DocumentItems,
  DocumentStatus,
  DocumentTotals,
} from '@/components/documents/document-body';
import { CustomerDocumentActions } from '@/components/documents/share-menu';
import { VehiclePlate } from '@/components/shared/vehicle-plate';
import { cn } from '@/lib/utils';

export const viewport: Viewport = { themeColor: CUSTOMER_BAR_COLOR };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  return customerLinkMetadata(`/customer/invoice/${token}`, await invoicePreview(token));
}

export default async function CustomerInvoicePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const access = await getCustomerAccess(token, 'INVOICE');

  if (access.state === 'invalid') {
    return (
      <CustomerShell label="Invoice">
        <CustomerNotice icon={Link2Off} title="This link is not valid">
          The link may have been copied incompletely. Please contact the workshop for an up-to-date
          link.
        </CustomerNotice>
      </CustomerShell>
    );
  }
  if (access.state === 'expired') {
    return (
      <CustomerShell organization={access.organization} label="Invoice">
        <CustomerNotice icon={Clock} title="This link has expired">
          For your security, invoice links only work for a limited time. Please contact us for a new
          one
          {access.organization.phone ? ` — call ${access.organization.phone}` : ''}.
        </CustomerNotice>
      </CustomerShell>
    );
  }
  const data = await getInvoiceDocumentForLink(access.organizationId, access.resourceId);
  if (!data) {
    return (
      <CustomerShell organization={access.organization} label="Invoice">
        <CustomerNotice icon={Link2Off} title="This invoice is no longer available">
          Please contact the workshop.
        </CustomerNotice>
      </CustomerShell>
    );
  }
  const { document, balance, receipts } = data;
  const paid = balance.state === 'PAID';

  return (
    <CustomerShell organization={access.organization} label="Invoice">
      <div className="flex flex-col gap-8">
        <header className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {document.title} · {document.number}
            </p>
            <DocumentStatus status={document.status} />
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">Hello {document.customer.name},</h1>
          <p className="text-muted-foreground">
            {paid
              ? 'Here is your invoice. It is fully paid — thank you.'
              : 'Here is your invoice for the work on your vehicle.'}
          </p>
        </header>

        <section
          className={cn(
            'flex flex-col gap-4 rounded-2xl px-5 py-5',
            paid ? 'bg-success/10' : 'bg-sidebar text-sidebar-foreground',
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <span
                className={cn(
                  'text-xs font-medium tracking-wide uppercase',
                  paid ? 'text-success' : 'text-sidebar-foreground/60',
                )}
              >
                {paid ? 'Paid in full' : 'Balance due'}
              </span>
              <span className="text-3xl font-semibold tracking-tight tabular-nums">
                {formatAed(paid ? balance.total : balance.balance)}
              </span>
            </div>
            {paid ? <CheckCircle2 className="size-7 text-success" /> : null}
          </div>
          <dl
            className={cn(
              'grid grid-cols-2 gap-3 border-t pt-4 text-sm',
              paid ? 'border-success/20' : 'border-white/10',
            )}
          >
            <div>
              <dt className={paid ? 'text-muted-foreground' : 'text-sidebar-foreground/60'}>
                Invoice total
              </dt>
              <dd className="font-medium tabular-nums">{formatAed(balance.total)}</dd>
            </div>
            <div>
              <dt className={paid ? 'text-muted-foreground' : 'text-sidebar-foreground/60'}>
                Paid
              </dt>
              <dd className="font-medium tabular-nums">{formatAed(balance.paid)}</dd>
            </div>
          </dl>
        </section>

        <CustomerDocumentActions
          pdfUrl={`/customer/invoice/${token}/pdf`}
          shareText={`${document.title} ${document.number}`}
        />

        {document.vehicle ? (
          <div className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4">
            <VehiclePlate plateNumber={document.vehicle.plateNumber} />
            <div className="min-w-0">
              <p className="truncate font-medium">{document.vehicle.description}</p>
              <p className="text-sm text-muted-foreground">
                {document.meta
                  .filter((m) => m.label === 'Work order' || m.label === 'Invoice date')
                  .map((m) => (m.label === 'Work order' ? `Job ${m.value}` : m.value))
                  .join(' · ')}
              </p>
            </div>
          </div>
        ) : null}

        <section className="flex flex-col gap-4">
          <h2 className="text-base font-semibold tracking-tight">Work and parts</h2>
          <DocumentItems document={document} />
          <DocumentTotals document={document} />
        </section>

        <section className="flex flex-col gap-3" id="receipts">
          <h2 className="text-base font-semibold tracking-tight">Payments</h2>
          {receipts.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
              No payments recorded yet. Please pay at the workshop.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-card">
              {receipts.map((receipt) => (
                <li
                  key={receipt.number}
                  className="flex items-center justify-between gap-3 px-4 py-3.5"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-success/10 text-success">
                      <Receipt className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium tabular-nums">
                        {formatAed(receipt.amount)}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {receipt.number} · {formatDate(receipt.receivedAt)} · {receipt.method}
                      </span>
                    </span>
                  </span>
                  <a
                    href={`/customer/invoice/${token}/receipts/${encodeURIComponent(receipt.number)}/pdf?download=1`}
                    className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-primary hover:bg-primary/5"
                  >
                    <FileDown className="size-4" />
                    Receipt
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </CustomerShell>
  );
}
