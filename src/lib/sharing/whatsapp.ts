import { formatAed } from '@/lib/documents/model';

/*
 * WhatsApp sharing by deep link (wa.me): the app prepares the message and
 * WhatsApp opens with it filled in, for a staff member to review and send.
 * Nothing is sent automatically and no WhatsApp API is involved.
 *
 * Messages carry only what the customer needs: their name, the vehicle, the
 * document number and amounts, and the secure link, which opens the
 * document with one tap. WhatsApp shows that link as a preview card drawn
 * as a "View" button (lib/brand/share-card); the line above the link is in
 * *bold* (WhatsApp's own formatting) so it reads as the call to action.
 * No internal ids, no staff details, no notes.
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

const greeting = (name: string) => `Hello ${name.trim() || 'there'},`;
const signOff = (workshop: string) => `Thank you,\n${workshop}`;
const vehicleLines = (input: ShareMessageInput) =>
  [
    input.vehicle ? `Vehicle: ${input.vehicle}` : null,
    input.plateNumber ? `Registration: ${input.plateNumber}` : null,
  ].filter((line): line is string => line !== null);

export function quotationMessage(
  input: ShareMessageInput & { number: string; total: string; awaitingDecision: boolean },
): string {
  return [
    greeting(input.customerName),
    '',
    `Your quotation from ${input.workshopName} is ready.`,
    '',
    ...vehicleLines(input),
    `Quotation: ${input.number}`,
    `Total: ${formatAed(input.total)}`,
    '',
    input.awaitingDecision
      ? '👉 *Tap to view and approve your quotation:*'
      : '👉 *View your quotation:*',
    input.link,
    '',
    signOff(input.workshopName),
  ].join('\n');
}

export function invoiceMessage(
  input: ShareMessageInput & { number: string; total: string; paid: string; balance: string },
): string {
  return [
    greeting(input.customerName),
    '',
    `Your invoice from ${input.workshopName} is ready.`,
    '',
    ...vehicleLines(input),
    `Invoice: ${input.number}`,
    `Total: ${formatAed(input.total)}`,
    `Paid: ${formatAed(input.paid)}`,
    `Balance: ${formatAed(input.balance)}`,
    '',
    '👉 *View your invoice:*',
    input.link,
    '',
    signOff(input.workshopName),
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
    `Thank you for your payment to ${input.workshopName}.`,
    '',
    ...vehicleLines(input),
    `Receipt: ${input.number}`,
    `Invoice: ${input.invoiceNumber}`,
    `Amount paid: ${formatAed(input.amount)}`,
    `Remaining balance: ${formatAed(input.balance)}`,
    '',
    '👉 *View your invoice and receipts:*',
    input.link,
    '',
    signOff(input.workshopName),
  ].join('\n');
}
