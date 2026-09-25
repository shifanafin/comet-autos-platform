import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

// Edge proxy (formerly "middleware") only does a cheap cookie-presence check
// for UX redirects (Prisma's Node driver adapter can't run in the Edge
// runtime). The actual session/permission validation — the real security
// boundary — happens on every request in requireUser()/requirePermission()
// (see lib/auth/), which run in the Node.js runtime inside Server
// Components and Server Actions.
//
// It also sets the Content Security Policy: every page gets a fresh nonce,
// and only scripts carrying it (Next.js adds it to its own) may run, so an
// injected <script> — say, in a customer name — never executes.

function contentSecurityPolicy(nonce: string) {
  const dev = process.env.NODE_ENV === 'development';
  return [
    "default-src 'self'",
    // React needs eval only for its development error overlays.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    // Inline style attributes are used throughout the UI; they can't run code.
    "style-src 'self' 'unsafe-inline'",
    // blob: for photo previews before upload, data: for signatures.
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = contentSecurityPolicy(nonce);

  const isPublicRoute =
    request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/customer/');

  if (!isPublicRoute && !request.cookies.has(SESSION_COOKIE_NAME)) {
    // Come back to the same page after signing in.
    const login = new URL('/login', request.url);
    const back = request.nextUrl.pathname + request.nextUrl.search;
    if (back !== '/') login.searchParams.set('next', back);
    return NextResponse.redirect(login);
  }

  // Next.js reads the nonce from the request's policy header and stamps it
  // on the scripts it renders; the browser enforces the response's copy.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

// Static files and the installable-app files are public: a phone reads the
// manifest, icons and service worker before anyone has signed in.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|manifest\\.webmanifest$|icon$|apple-icon$|app-icons/|sw\\.js$|offline\\.html$).*)',
  ],
};
