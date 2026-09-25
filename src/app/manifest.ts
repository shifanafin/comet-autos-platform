import type { MetadataRoute } from 'next';
import { APP_BACKGROUND } from '@/lib/brand/app-icon';

/**
 * Makes Comet Autos installable: "Install app" on Android and desktop
 * Chrome/Edge, "Add to Home Screen" on iPhone. It opens full-screen, with
 * its own icon, straight onto the dashboard (or the sign-in page).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Comet Autos Workshop',
    short_name: 'Comet Autos',
    description: 'Work orders, quotations, invoices and payments for the Comet Autos workshop.',
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
      { src: '/app-icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'New work order', short_name: 'Work order', url: '/check-in' },
      { name: 'New quotation', short_name: 'Quotation', url: '/quotations/new' },
      { name: 'New invoice', short_name: 'Invoice', url: '/finance/invoices/new' },
    ],
  };
}
