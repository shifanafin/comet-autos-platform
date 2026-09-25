import { requireUser } from '@/lib/auth/authorize';
import { AuthError } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { buildExport, EXPORTS, type ExportFilters } from '@/lib/data-transfer/exports';
import { csvFileName } from '@/lib/data-transfer/csv';

/*
 * Downloading a list as a spreadsheet.
 *
 * The search and filters ride along in the query string, so the file holds
 * exactly the rows the screen was showing. The list service does its own
 * permission check, so a user who may not see a list cannot download it —
 * and, as everywhere else, a list that isn't theirs reads as not found
 * rather than forbidden.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ entity: string }> },
) {
  const user = await requireUser();
  const { entity } = await params;
  if (!Object.hasOwn(EXPORTS, entity)) {
    return new Response('Not found', { status: 404 });
  }

  const search = new URL(request.url).searchParams;
  const filters: ExportFilters = {
    q: search.get('q') ?? undefined,
    status: search.get('status') ?? undefined,
    stock: search.get('stock') ?? undefined,
    category: search.get('category') ?? undefined,
    supplierId: search.get('supplierId') ?? undefined,
    partId: search.get('partId') ?? undefined,
    type: search.get('type') ?? undefined,
  };

  try {
    const { csv, label } = await buildExport(user, entity, filters);
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${csvFileName(label)}"`,
        // A spreadsheet of live data should never be cached or stored.
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    if (error instanceof AuthError) return new Response('Not found', { status: 404 });
    if (error instanceof NotFoundError) return new Response('Not found', { status: 404 });
    throw error;
  }
}
