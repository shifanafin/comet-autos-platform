import { appIcon } from '@/lib/brand/app-icon';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

/** The iPhone/iPad home-screen icon. iOS rounds the corners itself, so the tile is full-bleed. */
export default function AppleIcon() {
  return appIcon(size.width, { maskable: true });
}
