import { ImageResponse } from 'next/og';

/*
 * The picture WhatsApp shows above a shared customer link. A WhatsApp
 * message opened from the app can't carry real buttons (those need the paid
 * WhatsApp Business API), but it does show this link preview — so the
 * preview is drawn as the button: the document, its amount, and a large
 * "View quotation" to tap.
 */

export const SHARE_CARD_SIZE = { width: 1200, height: 630 };

export function shareCard(card: {
  workshop: string;
  /** "Quotation EST-0012" */
  heading: string | null;
  amountLabel: string | null;
  amount: string | null;
  /** "View quotation" */
  button: string;
}) {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '64px 72px',
        background: '#111118',
        color: '#f8f8fa',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, #a78bfa 0%, #7c3aed 55%, #6d28d9 100%)',
            fontSize: 40,
          }}
        >
          {card.workshop.trim().charAt(0).toUpperCase() || 'C'}
        </div>
        <div style={{ fontSize: 40, color: 'rgba(248,248,250,0.85)' }}>{card.workshop}</div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {card.heading ? <div style={{ fontSize: 56 }}>{card.heading}</div> : null}
        {card.amount ? (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 20 }}>
            <div style={{ fontSize: 34, color: 'rgba(248,248,250,0.6)' }}>{card.amountLabel}</div>
            <div style={{ fontSize: 76, letterSpacing: '-0.02em' }}>{card.amount}</div>
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
          height: 112,
          borderRadius: 24,
          background: '#7c3aed',
          fontSize: 46,
        }}
      >
        {card.button} →
      </div>
    </div>,
    {
      ...SHARE_CARD_SIZE,
      // The card names a document and its amount: never kept by a shared cache.
      headers: { 'Cache-Control': 'private, no-store' },
    },
  );
}
