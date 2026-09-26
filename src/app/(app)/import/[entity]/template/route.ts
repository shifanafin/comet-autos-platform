import { requireUser } from '@/lib/auth/authorize';
import { hasPermission } from '@/lib/auth/authorize';
import { IMPORTS, importTemplate } from '@/lib/data-transfer/imports';
import { csvFileName } from '@/lib/data-transfer/csv';
import { getBrand } from '@/lib/brand/brand';

/** The blank spreadsheet to fill in: the headings, and one example row. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ entity: string }> },
) {
  const user = await requireUser();
  const { entity } = await params;
  const definition = IMPORTS[entity];
  if (!definition || !hasPermission(user, definition.permission)) {
    return new Response('Not found', { status: 404 });
  }
  const { csv, label } = importTemplate(entity);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFileName((await getBrand(user.organizationId)).filePrefix, `${label}-template`)}"`,
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
