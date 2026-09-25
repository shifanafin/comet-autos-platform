import { appIcon } from '@/lib/brand/app-icon';

/**
 * The installed app's icons, as the web app manifest lists them. Built once
 * at build time; the proxy lets them through without a session, because a
 * phone fetches them before anyone has signed in.
 */
const ICONS: Record<string, { size: number; maskable: boolean }> = {
  'icon-192.png': { size: 192, maskable: false },
  'icon-512.png': { size: 512, maskable: false },
  'maskable-512.png': { size: 512, maskable: true },
};

export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(ICONS).map((file) => ({ file }));
}

export async function GET(_request: Request, ctx: RouteContext<'/app-icons/[file]'>) {
  const icon = ICONS[(await ctx.params).file];
  if (!icon) return new Response('Not found', { status: 404 });
  return appIcon(icon.size, { maskable: icon.maskable });
}
