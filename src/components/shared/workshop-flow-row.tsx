import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { WorkflowStatus } from '@/lib/workshop/stages';
import { JOB_STATUS_TONE, TONE_CLASSES } from '@/lib/workshop/status-tone';

export interface FlowStage {
  key: string;
  label: string;
  status: string;
  count: number;
}

/**
 * The workshop pipeline: one column per workflow stage, each with a live
 * count and a progress rule. Laid out as an even grid (not a row of cards)
 * so it reads as a single continuous process across the available width.
 */
// A short path (the simple job card's) fits on one line; the full one wraps into two even rows.
const WIDE_COLUMNS: Record<number, string> = {
  5: 'lg:grid-cols-5',
  6: 'lg:grid-cols-6',
  7: 'lg:grid-cols-7',
  8: 'lg:grid-cols-8',
};

export function WorkshopFlowRow({ stages }: { stages: FlowStage[] }) {
  return (
    <ol
      className={cn(
        'grid grid-cols-3 gap-x-4 gap-y-6 sm:grid-cols-4',
        WIDE_COLUMNS[stages.length] ?? 'lg:grid-cols-6',
      )}
    >
      {stages.map((stage) => {
        const tone = TONE_CLASSES[JOB_STATUS_TONE[stage.status as WorkflowStatus]];
        const active = stage.count > 0;
        return (
          <li key={stage.key} className="min-w-0">
            <Link
              href={`/job-cards?status=${stage.status}`}
              className={cn(
                'group flex flex-col gap-2.5 rounded-lg p-2.5 outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
                'transition-colors duration-150 hover:bg-muted/60 motion-reduce:transition-none',
              )}
            >
              {/* The rule carries the stage's colour only where vehicles are actually sitting. */}
              <span
                className={cn(
                  'h-1.5 rounded-full transition-opacity',
                  active ? cn(tone.dot, 'opacity-90 group-hover:opacity-100') : 'bg-border',
                )}
                aria-hidden
              />
              <span className="flex flex-col gap-1">
                <span
                  className={cn(
                    'text-[26px] leading-none font-semibold tracking-[-0.02em] tabular-nums',
                    active ? tone.text : 'text-foreground/20',
                  )}
                >
                  {stage.count}
                </span>
                <span
                  className={cn(
                    'truncate text-xs transition-colors',
                    active
                      ? 'font-medium text-foreground/80 group-hover:text-foreground'
                      : 'text-muted-foreground/70',
                  )}
                  title={stage.label}
                >
                  {stage.label}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
