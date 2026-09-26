import { appIcon } from '@/lib/brand/app-icon';
import { getBrand } from '@/lib/brand/brand';

/**
 * The installed app's icons, as the web app manifest lists them. Drawn on
 * request so the letter follows the workshop name in Settings; the proxy
 * lets them through without a session, because a phone fetches them before
 * anyone has signed in.
 */
const ICONS: Record<string, { size: number; maskable: boolean }> = {
  'icon-192.png': { size: 192, maskable: false },
  'icon-512.png': { size: 512, maskable: false },
  'maskable-512.png': { size: 512, maskable: true },
};

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, ctx: RouteContext<'/app-icons/[file]'>) {
  const icon = ICONS[(await ctx.params).file];
  if (!icon) return new Response('Not found', { status: 404 });
  const { initial } = await getBrand();
  return appIcon(icon.size, { initial, maskable: icon.maskable });
}
