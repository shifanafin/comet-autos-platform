'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';

/** List-page search that keeps the query in the URL (?q=), so results survive refresh and can be shared. */
export function SearchField({
  initialQuery,
  placeholder,
  keep,
}: {
  initialQuery: string;
  placeholder: string;
  /** Other filters in the URL to keep while searching, e.g. { show: 'deleted' }. */
  keep?: Record<string, string>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState(initialQuery);

  useEffect(() => {
    if (query.trim() === initialQuery.trim()) return;
    const timeout = setTimeout(() => {
      const params = new URLSearchParams(keep);
      if (query.trim()) params.set('q', query.trim());
      router.replace(`${pathname}${params.size ? `?${params}` : ''}`);
    }, 300);
    return () => clearTimeout(timeout);
  }, [query, initialQuery, pathname, router, keep]);

  return (
    <div className="relative w-full sm:max-w-md">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-10 pl-9"
      />
    </div>
  );
}
