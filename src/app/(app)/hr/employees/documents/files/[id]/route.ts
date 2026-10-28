import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentUser } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { readAttachment } from '@/lib/documents/attachments';

/** Opens a copy of an employee's document, for a user who manages employee records. */
export async function GET(
  _request: NextRequest,
  ctx: RouteContext<'/hr/employees/documents/files/[id]'>,
) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse('Sign in to view this file.', { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse('Not found', { status: 404 });
  try {
    const file = await readAttachment(user, 'EmployeeDocument', id);
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        'Content-Type': file.mimeType,
        'Content-Length': String(file.bytes.length),
        'Content-Disposition': `inline; filename="${file.fileName.replace(/[^\w .()-]/g, '_')}"`,
        // Personal papers: never kept by a shared cache.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        // Images get a locked-down page; a PDF needs the browser's own viewer.
        ...(file.mimeType === 'application/pdf'
          ? {}
          : {
              'Content-Security-Policy':
                "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
            }),
      },
    });
  } catch (error) {
    if (error instanceof NotFoundError) return new NextResponse('Not found', { status: 404 });
    if (error instanceof AuthError) return new NextResponse('Forbidden', { status: 403 });
    throw error;
  }
}
