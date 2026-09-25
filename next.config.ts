import type { NextConfig } from 'next';

/*
 * Security headers for every response. The Content Security Policy is set
 * per request in src/proxy.ts, because it carries a fresh nonce each time.
 */
const SECURITY_HEADERS = [
  // HTTPS only, for a year, once seen over HTTPS. Subdomains are left out:
  // other services on the domain (mail, a website) aren't this app's to force.
  { key: 'Strict-Transport-Security', value: 'max-age=31536000' },
  // No site may show these pages inside a frame (clickjacking).
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // Other sites see only our domain, never a page path or a customer link.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Only this site may ask for the camera (photos); nothing may ask for
  // the microphone, location, payments or USB devices.
  {
    key: 'Permissions-Policy',
    value: 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    serverActions: {
      // CSV imports are allowed up to 2 MB (lib/data-transfer/imports.ts);
      // leave room for the form's own overhead so the friendly size message,
      // not a framework error, is what a larger file meets.
      bodySizeLimit: '3mb',
    },
  },
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
