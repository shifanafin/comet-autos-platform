/*
 * How the app looks to one person: light, dark or following the device, and a
 * colour theme. Kept in this browser, and applied by a small script in the
 * page's head before anything is drawn, so a page never flashes the wrong
 * theme. Customer links keep the workshop's own look, whoever opens them, and
 * printing is always on the light theme.
 *
 * The colours themselves are tokens in globals.css (`.dark`, `[data-accent]`).
 */

export type ThemeMode = 'light' | 'dark' | 'system';

export const THEME_MODES: { value: ThemeMode; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Device' },
];

export const ACCENTS = [
  { value: 'violet', label: 'Violet', swatch: '#7c3aed' },
  { value: 'blue', label: 'Blue', swatch: '#2563eb' },
  { value: 'teal', label: 'Teal', swatch: '#0f766e' },
  { value: 'orange', label: 'Orange', swatch: '#c2410c' },
  { value: 'rose', label: 'Rose', swatch: '#be123c' },
  { value: 'graphite', label: 'Graphite', swatch: '#334155' },
] as const;

export type Accent = (typeof ACCENTS)[number]['value'];

export interface ThemeSettings {
  mode: ThemeMode;
  accent: Accent;
}

export const DEFAULT_THEME: ThemeSettings = { mode: 'light', accent: 'violet' };

const THEME_KEY = 'garage:theme';

/** The saved choice; the defaults where there is none (or no storage). */
export function readTheme(): ThemeSettings {
  try {
    const saved = JSON.parse(window.localStorage.getItem(THEME_KEY) ?? '{}') as Partial<
      Record<keyof ThemeSettings, string>
    >;
    return {
      mode: THEME_MODES.find((mode) => mode.value === saved.mode)?.value ?? DEFAULT_THEME.mode,
      accent:
        ACCENTS.find((accent) => accent.value === saved.accent)?.value ?? DEFAULT_THEME.accent,
    };
  } catch {
    return DEFAULT_THEME;
  }
}

/** Saves a choice and applies it to the page at once. */
export function saveTheme(settings: ThemeSettings) {
  try {
    window.localStorage.setItem(THEME_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing / storage disabled: it still applies until the next page load.
  }
  (window as unknown as { __garageTheme?: (saved?: ThemeSettings) => void }).__garageTheme?.(
    settings,
  );
}

/**
 * Runs in the page's head, before the first paint. Plain JavaScript in a
 * string: it can't wait for the app's own code to load. It also follows the
 * device's setting, other tabs, and switches to light for printing.
 */
export const THEME_SCRIPT = `(function(){try{
if(location.pathname.indexOf('/customer/')===0)return;
var d=document.documentElement,k=${JSON.stringify(THEME_KEY)},q=matchMedia('(prefers-color-scheme: dark)');
function apply(s){
if(!s){try{s=JSON.parse(localStorage.getItem(k)||'{}')}catch(e){s={}}}
d.dataset.themeMode=s.mode||'light';
d.classList.toggle('dark',s.mode==='dark'||(s.mode==='system'&&q.matches));
if(s.accent&&s.accent!=='violet')d.dataset.accent=s.accent;else delete d.dataset.accent;
}
window.__garageTheme=apply;apply();
q.addEventListener('change',function(){if(d.dataset.themeMode==='system')apply()});
addEventListener('storage',function(e){if(e.key===k)apply()});
addEventListener('beforeprint',function(){d.classList.remove('dark')});
addEventListener('afterprint',function(){apply()});
}catch(e){}})();`;

/** Cookies, so the server draws the sidebar and the dashboard as they were left. */
export const SIDEBAR_COOKIE = 'garage-sidebar';
export const DASHBOARD_CLOSED_COOKIE = 'garage-dashboard-closed';

export function setPreferenceCookie(name: string, value: string) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; SameSite=Lax`;
}

/** The sidebar's opener in the top bar, and the sidebar itself, are apart on the page. */
export const TOGGLE_SIDEBAR_EVENT = 'garage:toggle-sidebar';
