import { shareCard } from '@/lib/brand/share-card';
import { invoicePreview } from '@/lib/customer-access/preview';

/** The picture WhatsApp shows above a shared invoice link. */
export async function GET(
  _request: Request,
  ctx: RouteContext<'/customer/invoice/[token]/preview'>,
) {
  return shareCard(await invoicePreview((await ctx.params).token));
}
