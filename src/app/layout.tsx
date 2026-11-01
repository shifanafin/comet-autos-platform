import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { headers } from 'next/headers';
import { Toaster } from 'sonner';
import { APP_BACKGROUND } from '@/lib/brand/app-icon';
import { getBrand } from '@/lib/brand/brand';
import { ServiceWorkerRegistration } from '@/components/shell/install-app';
import { THEME_SCRIPT } from '@/lib/theme';
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

export default async function RootLayout({ children }: LayoutProps<'/'>) {
  // The page's security policy allows inline script only with this request's nonce.
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  return (
    // The theme script sets the theme on <html> before React takes over.
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }}
        />
      </head>
      <body>
        {children}
        <Toaster position="top-right" />
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
