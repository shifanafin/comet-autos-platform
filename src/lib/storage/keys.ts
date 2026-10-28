import { randomUUID } from 'node:crypto';
import { localDateString } from '@/lib/format';

/*
 * Where a new file is kept.
 *
 * One readable tree, so the files can be found in the storage provider's own
 * browser — by what they are and the month they were added — instead of
 * sitting loose at the top level:
 *
 *   comet-autos/bills/2026-09/…        supplier bills (expenses, purchases)
 *   comet-autos/invoices/2026-09/…     files kept with sales invoices
 *   comet-autos/receipts/2026-09/…     files kept with receipts and payments
 *   comet-autos/job-photos/2026-09/…   photos taken on a job
 *   comet-autos/signatures/2026-09/…   customer signatures
 *   comet-autos/team/2026-09/…         photos and voice notes on staff tasks
 *   comet-autos/staff-documents/2026-09/…  employees' passports, visas, IDs, contracts
 *   comet-autos/accounts/2026-09/…     journals, fixed assets, payroll, VAT
 *   comet-autos/other/2026-09/…        anything else
 *
 * The name itself is random and never the user's file name. The folder is
 * for people browsing storage; the app finds a file by the key saved on its
 * Document row, so files stored under the older `org/…` keys keep working.
 */

export type StorageFolder =
  | 'bills'
  | 'invoices'
  | 'receipts'
  | 'job-photos'
  | 'signatures'
  | 'team'
  | 'staff-documents'
  | 'accounts'
  | 'other';

/** The top folder. Another workshop on the same storage account sets its own. */
const root = () =>
  (process.env.STORAGE_FOLDER ?? 'comet-autos').replace(/[^a-z0-9-]/g, '') || 'comet-autos';

export function storageKey(folder: StorageFolder, extension: string): string {
  const month = localDateString().slice(0, 7);
  return `${root()}/${folder}/${month}/${randomUUID()}.${extension}`;
}
