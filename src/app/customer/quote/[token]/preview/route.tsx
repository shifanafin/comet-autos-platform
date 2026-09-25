import { shareCard } from '@/lib/brand/share-card';
import { quotePreview } from '@/lib/customer-access/preview';

/** The picture WhatsApp shows above a shared quotation link. */
export async function GET(_request: Request, ctx: RouteContext<'/customer/quote/[token]/preview'>) {
  return shareCard(await quotePreview((await ctx.params).token));
}
