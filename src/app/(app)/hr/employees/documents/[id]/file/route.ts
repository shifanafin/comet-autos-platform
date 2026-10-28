import { NextResponse, type NextRequest } from 'next/server';
import { revalidatePath } from 'next/cache';
import { getCurrentUser } from '@/lib/auth/session';
import { toActionError } from '@/lib/errors';
import { attachFile } from '@/lib/documents/attachments';

/**
 * Keeps one copy (a photo or PDF — front, back, the whole document) with an
 * employee's document (multipart, one file). A route handler rather than a
 * Server Action because a scan can pass the Server Action body limit; same
 * rules otherwise: signed-in user, same-site request, permission and
 * ownership checked in the service.
 */
export async function POST(
  request: NextRequest,
  ctx: RouteContext<'/hr/employees/documents/[id]/file'>,
) {
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== request.headers.get('host')) {
    return NextResponse.json(
      { ok: false, error: 'This request came from another site and was refused.' },
      { status: 403 },
    );
  }
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { ok: false, error: 'Your session has ended. Sign in again, then add the copy.' },
      { status: 401 },
    );
  }
  const { id } = await ctx.params;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json(
      { ok: false, error: 'The upload was interrupted. Check the connection and try again.' },
      { status: 400 },
    );
  }
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return NextResponse.json({ ok: false, error: 'Choose the copy to add.' }, { status: 400 });
  }
  try {
    await attachFile(user, 'EmployeeDocument', id, {
      name: file.name,
      bytes: Buffer.from(await file.arrayBuffer()),
    });
    revalidatePath('/hr', 'layout');
    return NextResponse.json({ ok: true });
  } catch (error) {
    const result = toActionError(error);
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
}
