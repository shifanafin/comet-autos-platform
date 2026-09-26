import type { CustomerDocumentModel, DocumentTone } from '@/lib/documents/model';
import { formatAed, formatQuantity } from '@/lib/documents/model';
import { StatusPill, type PillTone } from '@/components/shared/status-pill';
import { cn } from '@/lib/utils';

/*
 * The priced part of a customer document (item groups and totals), laid out
 * for phones. Reads the same model the PDF is drawn from, so the page and the
 * PDF can never disagree.
 */

const TONE: Record<DocumentTone, PillTone> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  info: 'info',
  neutral: 'neutral',
};

export function DocumentStatus({ status }: { status: CustomerDocumentModel['status'] }) {
  if (!status) return null;
  return <StatusPill tone={TONE[status.tone]}>{status.label}</StatusPill>;
}

/** Numbered lines, each marked parts or labour — the same list the PDF prints. */
export function DocumentItems({ document }: { document: CustomerDocumentModel }) {
  // One running number across every section, as on the paper sheet.
  const offsets = document.sections.reduce<number[]>(
    (acc, section, index) => [...acc, index === 0 ? 0 : acc[index - 1] + document.sections[index - 1].lines.length],
    [],
  );
  return (
    <div className="flex flex-col gap-6">
      {document.sections.map((section, sectionIndex) => (
        <section key={section.title || 'lines'} className="flex flex-col gap-2">
          {section.title ? (
            <h3 className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {section.title}
            </h3>
          ) : null}
          <ul className="flex flex-col divide-y divide-border rounded-2xl border border-border bg-card">
            {section.lines.map((line, index) => (
              <li key={index} className="flex items-start gap-3 px-4 py-3.5">
                <span className="w-6 shrink-0 pt-0.5 text-right text-xs text-muted-foreground tabular-nums">
                  {offsets[sectionIndex] + index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.95rem] leading-snug font-medium">
                    {line.description}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 pt-0.5 text-xs text-muted-foreground tabular-nums">
                    {line.type ? (
                      <span className="font-semibold tracking-wide">
                        {line.type === 'LABOUR' ? 'Labour' : 'Parts'}
                      </span>
                    ) : null}
                    <span>
                      {formatQuantity(line.quantity)} × {formatAed(line.unitPrice)}
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-[0.95rem] font-medium tabular-nums">
                  {formatAed(line.lineTotal)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function DocumentTotals({ document }: { document: CustomerDocumentModel }) {
  return (
    <dl className="flex flex-col gap-2.5 rounded-2xl bg-muted/70 px-4 py-4 text-sm">
      {document.totals.map((total) => (
        <div
          key={total.label}
          className={cn(
            'flex items-baseline justify-between gap-4',
            total.emphasis === 'total' && 'border-t border-border pt-3 text-lg font-semibold',
            total.emphasis === 'balance' && 'text-base font-semibold text-primary',
          )}
        >
          <dt className={cn(!total.emphasis && 'text-muted-foreground')}>{total.label}</dt>
          <dd className="tabular-nums">{formatAed(total.amount)}</dd>
        </div>
      ))}
    </dl>
  );
}
