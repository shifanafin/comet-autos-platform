import { appIcon } from '@/lib/brand/app-icon';
import { getBrand } from '@/lib/brand/brand';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';
// Drawn on request, so the letter follows the workshop name in Settings.
export const dynamic = 'force-dynamic';

/** The iPhone/iPad home-screen icon. iOS rounds the corners itself, so the tile is full-bleed. */
export default async function AppleIcon() {
  const { initial } = await getBrand();
  return appIcon(size.width, { initial, maskable: true });
}
