'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { Download, Share, SquarePlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/*
 * Installing Comet Autos as an app on a phone, tablet or computer.
 *
 * Android and desktop Chrome/Edge offer an install prompt the page can
 * trigger; iPhone and iPad have none, so there the button explains the two
 * taps in Safari's Share menu. Once the app is installed and opened from
 * its icon, the button disappears.
 */

type InstallPromptEvent = Event & {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

// Kept at module level: the browser can offer the prompt before any
// component has mounted, and it only offers it once per page load.
let deferredPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    notify();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  const standalone = matchMedia('(display-mode: standalone)');
  standalone.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    standalone.removeEventListener('change', listener);
  };
}

type InstallMode = 'none' | 'prompt' | 'ios';

function installMode(): InstallMode {
  const installed =
    matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (installed) return 'none';
  if (deferredPrompt) return 'prompt';
  // iPadOS reports itself as a Mac; a touch screen gives it away.
  const ios =
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  return ios ? 'ios' : 'none';
}

/** The "Install app" button for the top bar. Renders nothing where there is nothing to install. */
export function InstallAppButton() {
  const mode = useSyncExternalStore(subscribe, installMode, () => 'none' as const);
  const [iosHelp, setIosHelp] = useState(false);
  if (mode === 'none') return null;

  async function install() {
    if (mode === 'ios') return setIosHelp(true);
    const prompt = deferredPrompt;
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice;
    // The browser offers each prompt only once, whatever the answer.
    deferredPrompt = null;
    notify();
  }

  return (
    <>
      <button
        type="button"
        onClick={install}
        aria-label="Install the Comet Autos app"
        className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-border bg-card px-2.5 text-sm font-medium transition-colors hover:bg-muted sm:px-3.5"
      >
        <Download className="size-4 text-primary" />
        <span className="hidden sm:inline">Install app</span>
      </button>

      <Dialog open={iosHelp} onOpenChange={setIosHelp}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Install Comet Autos</DialogTitle>
            <DialogDescription>
              Add it to your Home Screen and it opens full-screen, like any other app.
            </DialogDescription>
          </DialogHeader>
          <ol className="flex flex-col gap-3 text-sm">
            <li className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Share className="size-4" />
              </span>
              <span>
                Tap <strong>Share</strong> in Safari’s toolbar.
              </span>
            </li>
            <li className="flex items-center gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <SquarePlus className="size-4" />
              </span>
              <span>
                Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
              </span>
            </li>
          </ol>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Registers the service worker that shows an offline page instead of the
 * browser's error. Production only: in development it would sit between
 * the code and every reload.
 */
export function ServiceWorkerRegistration() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // Without it the app still works; only the offline page is missing.
    });
  }, []);
  return null;
}
