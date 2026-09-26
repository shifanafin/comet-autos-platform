import Link from 'next/link';
import { ArrowLeft, SearchX } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** A record that doesn't exist — or that this account may not see (deliberately indistinguishable). */
export default function AppNotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-5 px-6 py-20 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <SearchX className="size-6" />
      </span>
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight">We couldn&apos;t find that</h1>
        <p className="text-sm text-muted-foreground">
          The page or record may have been moved, or the link was copied incompletely. Search for
          the job, customer or vehicle instead.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <Button size="lg" nativeButton={false} render={<Link href="/job-cards" />}>
          Job cards
        </Button>
        <Button size="lg" variant="outline" nativeButton={false} render={<Link href="/" />}>
          <ArrowLeft />
          Dashboard
        </Button>
      </div>
    </div>
  );
}
