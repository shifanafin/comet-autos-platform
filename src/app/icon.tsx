import { appIcon } from '@/lib/brand/app-icon';
import { getBrand } from '@/lib/brand/brand';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';
// Drawn on request, so the letter follows the workshop name in Settings.
export const dynamic = 'force-dynamic';

/** The browser-tab icon. */
export default async function Icon() {
  const { initial } = await getBrand();
  return appIcon(size.width, { initial });
}
