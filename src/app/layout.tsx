import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { APP_BACKGROUND } from '@/lib/brand/app-icon';
import { getBrand } from '@/lib/brand/brand';
import { ServiceWorkerRegistration } from '@/components/shell/install-app';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

/** Titles and the app name follow the workshop name in Settings. */
export async function generateMetadata(): Promise<Metadata> {
  const brand = await getBrand();
  return {
    // A page sets only its own name ("Invoices"); the workshop name is added here.
    title: { default: brand.shortName, template: `%s — ${brand.shortName}` },
    description: `${brand.name} — workshop management`,
    applicationName: brand.shortName,
    // Opened from the iPhone home screen: full-screen, under its own name.
    appleWebApp: { capable: true, title: brand.shortName, statusBarStyle: 'default' },
    // Numbers meant to be dialled are linked on purpose; stop iOS turning
    // invoice numbers and amounts into phone links.
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  themeColor: APP_BACKGROUND,
  // Lets the bottom bars sit clear of the iPhone home indicator.
  viewportFit: 'cover',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {children}
        <Toaster position="top-right" />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
