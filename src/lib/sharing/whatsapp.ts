import { formatAed } from '@/lib/documents/model';

/*
 * WhatsApp sharing by deep link (wa.me): the app prepares the message and
 * WhatsApp opens with it filled in, for a staff member to review and send.
 * Nothing is sent automatically and no WhatsApp API is involved.
 *
 * Messages carry only what the customer needs: their name, the vehicle, the
 * document number and amounts, and the secure link, which opens the
 * document with one tap. They read like a note from the workshop, not a
 * printout: a warm hello, each fact on its own marked line, a pointing hand
 * right above the link, and an invitation to reply. WhatsApp shows the link
 * as a preview card drawn as a button (lib/brand/share-card). *Bold* is
 * WhatsApp's own formatting. No internal ids, no staff details, no notes.
 */

/**
 * The international number wa.me expects (digits only, no "+" or leading
 * zeros). Local UAE numbers are assumed when no country code is given:
 * "050 123 4567" → "971501234567". Returns null when the number can't be a
 * real mobile number — WhatsApp then opens without a recipient.
 */
export function normalizeWhatsAppNumber(
  phone: string | null | undefined,
  defaultCountryCode = '971',
): string | null {
  if (!phone) return null;
  let digits = phone.replace(/\D/g, '');
  if (phone.trim().startsWith('+')) {
    // Already international.
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2);
  } else if (
    digits.startsWith(defaultCountryCode) &&
    digits.length > defaultCountryCode.length + 7
  ) {
    // Country code typed without "+".
  } else if (digits.startsWith('0')) {
    digits = defaultCountryCode + digits.replace(/^0+/, '');
  } else if (digits.length === 9) {
    digits = defaultCountryCode + digits;
  }
  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}

/** https://wa.me/<number>?text=<message>, with the message fully URL-encoded. */
export function whatsAppUrl(phone: string | null | undefined, message: string): string {
  const number = normalizeWhatsAppNumber(phone);
  return `https://wa.me/${number ?? ''}?text=${encodeURIComponent(message)}`;
}

export interface ShareMessageInput {
  customerName: string;
  workshopName: string;
  vehicle: string | null;
  plateNumber: string | null;
  link: string;
}

const greeting = (name: string) => `Hello ${name.trim() || 'there'} 👋`;

/** The close: an open door, then who it is from. */
const signOff = (workshop: string) => [
  'Any questions? Just reply to this message.',
  `*${workshop}*`,
];

/** "🚗 *Toyota Camry* · A 12345" — the car, as the customer knows it. */
const vehicleLine = (input: ShareMessageInput) => {
  if (!input.vehicle && !input.plateNumber) return [];
  const parts = [input.vehicle ? `*${input.vehicle}*` : null, input.plateNumber].filter(Boolean);
  return [`🚗 ${parts.join(' · ')}`];
};

/** The call to action, right above the link WhatsApp turns into the preview card. */
const tapLine = (text: string) => `👇 *${text}*`;

const isZero = (amount: string) => Number(amount) === 0;

export function quotationMessage(
  input: ShareMessageInput & { number: string; total: string; awaitingDecision: boolean },
): string {
  return [
    greeting(input.customerName),
    '',
    `Your quotation from *${input.workshopName}* is ready.`,
    '',
    ...vehicleLine(input),
    `🧾 Quotation *${input.number}*`,
    `💰 Total *${formatAed(input.total)}*`,
    '',
    tapLine(
      input.awaitingDecision ? 'Tap below to view and approve' : 'Tap below to view your quotation',
    ),
    input.link,
    '',
    ...signOff(input.workshopName),
  ].join('\n');
}

export function invoiceMessage(
  input: ShareMessageInput & { number: string; total: string; paid: string; balance: string },
): string {
  const settled = isZero(input.balance);
  return [
    greeting(input.customerName),
    '',
    `Thank you for choosing *${input.workshopName}*. Your invoice is ready.`,
    '',
    ...vehicleLine(input),
    `🧾 Invoice *${input.number}*`,
    `💰 Total ${formatAed(input.total)}`,
    ...(isZero(input.paid) ? [] : [`✅ Paid ${formatAed(input.paid)}`]),
    settled ? '🎉 *Paid in full — thank you!*' : `⏳ *Balance due ${formatAed(input.balance)}*`,
    '',
    tapLine('Tap below to view your invoice'),
    input.link,
    '',
    ...signOff(input.workshopName),
  ].join('\n');
}

export function receiptMessage(
  input: ShareMessageInput & {
    number: string;
    invoiceNumber: string;
    amount: string;
    balance: string;
  },
): string {
  return [
    greeting(input.customerName),
    '',
    '✅ *Payment received — thank you!*',
    '',
    ...vehicleLine(input),
    `🧾 Receipt *${input.number}* · invoice ${input.invoiceNumber}`,
    `💵 Amount paid *${formatAed(input.amount)}*`,
    isZero(input.balance)
      ? '🎉 *Your invoice is now fully paid.*'
      : `⏳ Remaining balance *${formatAed(input.balance)}*`,
    '',
    tapLine('Tap below to view your invoice and receipts'),
    input.link,
    '',
    ...signOff(input.workshopName),
  ].join('\n');
}

export function jobCardMessage(
  input: ShareMessageInput & { number: string; stage: string },
): string {
  return [
    greeting(input.customerName),
    '',
    `Here is the job card for your vehicle at *${input.workshopName}*.`,
    '',
    ...vehicleLine(input),
    `🛠️ Job card *${input.number}*`,
    `📍 Now: *${input.stage}*`,
    '',
    tapLine('Tap below to see where your job is'),
    input.link,
    '',
    ...signOff(input.workshopName),
  ].join('\n');
}
