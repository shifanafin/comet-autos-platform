import { ImageResponse } from 'next/og';

/*
 * The Comet Autos app icon: the sidebar's violet "C" tile, drawn at any size
 * for the browser tab, the iPhone home screen and the installed app. Drawn
 * in code so there is one mark to change, not a folder of exported PNGs.
 */

export const BRAND_VIOLET = '#7c3aed';
export const APP_BACKGROUND = '#f4f5f8';

/**
 * `maskable` fills the whole square and keeps the letter inside the middle
 * 80%, so Android can crop it to a circle or squircle without clipping it.
 * The standard icon is a rounded tile on a transparent ground.
 */
export function appIcon(size: number, { maskable = false } = {}) {
  const letter = Math.round(size * (maskable ? 0.46 : 0.6));
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 55%, #6d28d9 100%)',
        borderRadius: maskable ? 0 : Math.round(size * 0.22),
        color: '#ffffff',
        fontSize: letter,
        fontWeight: 700,
        lineHeight: 1,
        letterSpacing: '-0.04em',
      }}
    >
      C
    </div>,
    { width: size, height: size },
  );
}
