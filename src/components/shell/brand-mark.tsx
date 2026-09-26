import type { Brand } from '@/lib/brand/brand';

/** Sidebar/drawer brand block. Height matches the top bar so the two rules line up. */
export function BrandMark({
  brand,
  collapsed = false,
}: {
  brand: Pick<Brand, 'shortName' | 'initial'>;
  collapsed?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {/* The mark is the one place the brand violet is allowed to glow. */}
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-sidebar-primary bg-gradient-to-br from-violet-400 to-violet-700 text-sm font-bold text-sidebar-primary-foreground shadow-glow">
        {brand.initial}
      </span>
      {!collapsed ? (
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[15px] leading-tight font-semibold tracking-[-0.015em]">
            {brand.shortName}
          </span>
          <span className="truncate text-[11px] leading-tight tracking-[0.06em] text-sidebar-foreground/45 uppercase">
            Workshop
          </span>
        </span>
      ) : null}
    </div>
  );
}
