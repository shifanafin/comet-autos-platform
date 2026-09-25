import { NextResponse, type NextRequest } from 'next/server';
import type { CustomerAccessResourceType } from '@/generated/prisma/enums';
import { getCurrentUser, type AuthenticatedUser } from '@/lib/auth/session';
import { AuthError } from '@/lib/auth/authorize';
import { NotFoundError } from '@/lib/errors';
import { getCustomerAccess } from '@/lib/customer-access/access';
import type { CustomerDocumentModel } from '@/lib/documents/model';
import { renderDocumentPdf } from '@/lib/documents/pdf/render';

/*
 * HTTP plumbing for document PDFs: who may fetch them, and how the bytes are
 * sent. `?download=1` asks the browser to save the file; otherwise it opens
 * inline (view / print). Responses are never cached and never leak the
 * secret customer link through the Referer header.
 */

export function pdfResponse(document: CustomerDocumentModel, request: NextRequest) {
  const download = request.nextUrl.searchParams.get('download') === '1';
  const body = new Uint8Array(renderDocumentPdf(document));
  return new NextResponse(body, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.byteLength),
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${document.fileName.replace(/[^A-Za-z0-9._-]/g, '-')}.pdf"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

/** Staff PDFs: a signed-in user with the loader's permission; otherwise login, 403 or 404. */
export async function staffPdf(
  request: NextRequest,
  load: (user: AuthenticatedUser) => Promise<CustomerDocumentModel>,
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL('/login', request.url));
  try {
    return pdfResponse(await load(user), request);
  } catch (error) {
    if (error instanceof NotFoundError) return new NextResponse('Not found', { status: 404 });
    if (error instanceof AuthError) return new NextResponse('Forbidden', { status: 403 });
    throw error;
  }
}

/**
 * Customer PDFs: for a live link, like the customer page itself. An expired
 * or revoked link is sent to the page, which explains what happened.
 */
export async function customerPdf(
  request: NextRequest,
  type: CustomerAccessResourceType,
  rawToken: string,
  load: (organizationId: string, resourceId: string) => Promise<CustomerDocumentModel | null>,
) {
  const access = await getCustomerAccess(rawToken, type);
  const pagePath = `/customer/${type === 'ESTIMATE' ? 'quote' : 'invoice'}/${encodeURIComponent(rawToken)}`;
  if (access.state !== 'open') return NextResponse.redirect(new URL(pagePath, request.url));
  const document = await load(access.organizationId, access.resourceId);
  if (!document) return new NextResponse('Not found', { status: 404 });
  return pdfResponse(document, request);
}
