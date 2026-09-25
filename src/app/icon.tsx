import { appIcon } from '@/lib/brand/app-icon';

export const size = { width: 64, height: 64 };
export const contentType = 'image/png';

/** The browser-tab icon. */
export default function Icon() {
  return appIcon(size.width);
}
