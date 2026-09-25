import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

// Edge proxy (formerly "middleware") only does a cheap cookie-presence check
// for UX redirects (Prisma's Node driver adapter can't run in the Edge
// runtime). The actual session/permission validation — the real security
// boundary — happens on every request in requireUser()/requirePermission()
// (see lib/auth/), which run in the Node.js runtime inside Server
// Components and Server Actions.
export function proxy(request: NextRequest) {
  const isPublicRoute =
    request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/customer/');

  if (isPublicRoute) {
    return NextResponse.next();
  }

  const hasSessionCookie = request.cookies.has(SESSION_COOKIE_NAME);
  if (!hasSessionCookie) {
    // Come back to the same page after signing in.
    const login = new URL('/login', request.url);
    const back = request.nextUrl.pathname + request.nextUrl.search;
    if (back !== '/') login.searchParams.set('next', back);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

// Static files and the installable-app files are public: a phone reads the
// manifest, icons and service worker before anyone has signed in.
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|manifest\\.webmanifest$|icon$|apple-icon$|app-icons/|sw\\.js$|offline\\.html$).*)',
  ],
};
