'use client';

import type { PriceBasis } from '@/lib/vat-entry';
import { cn } from '@/lib/utils';

const OPTIONS: { value: PriceBasis; label: string }[] = [
  { value: 'EXCLUSIVE', label: 'Excluding VAT' },
  { value: 'INCLUSIVE', label: 'Including VAT' },
];

/**
 * Whether the figures typed on a form already include VAT. Zero-rated, exempt
 * and out-of-scope lines carry no VAT, so the choice makes no difference to them.
 */
export function PriceBasisToggle({
  value,
  onChange,
  label = 'Amounts are',
  className,
}: {
  value: PriceBasis;
  onChange: (basis: PriceBasis) => void;
  label?: string;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2 text-sm', className)}>
      <span className="text-muted-foreground">{label}</span>
      <div role="radiogroup" aria-label={label} className="flex gap-1 rounded-lg bg-muted p-1">
        {OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={value === option.value}
            onClick={() => onChange(option.value)}
            className={
              value === option.value
                ? 'rounded-md bg-card px-3 py-1.5 font-medium shadow-card'
                : 'rounded-md px-3 py-1.5 text-muted-foreground hover:text-foreground'
            }
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
