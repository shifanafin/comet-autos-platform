import type { NextRequest } from 'next/server';
import { getAdvanceReceiptDocument } from '@/lib/documents/advance-receipt';
import { staffPdf } from '@/lib/documents/http';

/** The customer advance's receipt — a tax invoice for the advance — as a PDF. */
export async function GET(request: NextRequest, ctx: RouteContext<'/documents/advance/[id]'>) {
  const { id } = await ctx.params;
  return staffPdf(request, (user) => getAdvanceReceiptDocument(user, id));
}
