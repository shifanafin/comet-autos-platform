import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

/** Letters and digits that can't be misread (no 0/O, 1/I/L). */
const READABLE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * A one-time password for a new login or a reset: 10 random characters
 * (about 49 bits), read out or sent once, changed at the first sign-in.
 * Never derived from anything guessable such as the employee code.
 */
export function temporaryPassword(length = 10): string {
  let password = '';
  for (let i = 0; i < length; i += 1) password += READABLE[randomInt(READABLE.length)];
  return password;
}

const SALT_ROUNDS = 12;

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
