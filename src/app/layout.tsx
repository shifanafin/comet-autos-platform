import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { Toaster } from 'sonner';
import { APP_BACKGROUND } from '@/lib/brand/app-icon';
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

export const metadata: Metadata = {
  title: 'Comet Autos',
  description: 'Comet Autos Workshop Management System',
  applicationName: 'Comet Autos',
  // Opened from the iPhone home screen: full-screen, under its own name.
  appleWebApp: { capable: true, title: 'Comet Autos', statusBarStyle: 'default' },
  // Numbers meant to be dialled are linked on purpose; stop iOS turning
  // invoice numbers and amounts into phone links.
  formatDetection: { telephone: false },
};

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
