/*
 * The app's service worker — deliberately small.
 *
 * It caches nothing from the app itself: every screen holds live workshop
 * and customer data behind a sign-in, and a stale copy of a job or an
 * invoice is worse than none. It only keeps one static "You're offline"
 * page, shown when a screen can't be reached, instead of the browser's
 * dinosaur. Uploads, forms and data requests pass straight through.
 */

const CACHE = 'comet-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      // No room to keep it (private browsing, a full phone) is no reason to
      // refuse the worker: pages still load, only the offline page is missing.
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  // Only full page loads. Everything else is left to the browser.
  if (event.request.mode !== 'navigate' || event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request).catch(async () =>
      ((await caches.match(OFFLINE_URL).catch(() => undefined)) ?? Response.error()),
    ),
  );
});
