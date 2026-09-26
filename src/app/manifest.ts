import type { MetadataRoute } from 'next';
import { APP_BACKGROUND } from '@/lib/brand/app-icon';
import { getBrand } from '@/lib/brand/brand';

// Read when requested, so a new workshop name reaches the installed app.
export const dynamic = 'force-dynamic';

/**
 * Makes the app installable: "Install app" on Android and desktop
 * Chrome/Edge, "Add to Home Screen" on iPhone. It opens full-screen, with
 * its own icon, straight onto the dashboard (or the sign-in page).
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const brand = await getBrand();
  return {
    id: '/',
    name: brand.name,
    short_name: brand.shortName,
    description: `Job cards, quotations, invoices and payments for ${brand.name}.`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: APP_BACKGROUND,
    theme_color: APP_BACKGROUND,
    categories: ['business', 'productivity'],
    icons: [
      { src: '/app-icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/app-icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      {
        src: '/app-icons/maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      { name: 'New job card', short_name: 'Job card', url: '/check-in' },
      { name: 'New quotation', short_name: 'Quotation', url: '/quotations/new' },
      { name: 'New invoice', short_name: 'Invoice', url: '/finance/invoices/new' },
    ],
  };
}
