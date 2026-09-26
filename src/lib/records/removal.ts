/*
 * What "delete" means on each list. Pure data, safe for the browser: the
 * words on the button and in the confirmation, and whether a reason is
 * asked for. What actually happens lives in lib/records/remove.ts.
 *
 * Nothing that is part of the books is ever erased. A tax invoice is
 * voided, a payment or stock movement is reversed, a job card or purchase
 * is cancelled — each keeps its number and history. Only records that were
 * never used (a draft quotation, a part or supplier nobody used) are
 * removed outright; everything else is archived and can be restored.
 */

export type RemovableEntity =
  | 'customers'
  | 'vehicles'
  | 'job-cards'
  | 'quotations'
  | 'invoices'
  | 'payments'
  | 'parts'
  | 'suppliers'
  | 'purchases'
  | 'movements';

export interface RemovalCopy {
  /** Button and dialog verb: "Delete", "Void", "Cancel", "Reverse". */
  verb: string;
  /** For the result: "deleted", "voided". */
  past: string;
  singular: string;
  plural: string;
  /** What happens, and what is skipped — shown before anyone confirms. */
  explain: string;
  /** Voids and reversals are recorded with the reason, as the single actions do. */
  reason: 'required' | 'optional';
  /** Permission the user needs to see the controls (the service checks again). */
  permission: string;
}

export const REMOVAL: Record<RemovableEntity, RemovalCopy> = {
  customers: {
    verb: 'Delete',
    past: 'deleted',
    singular: 'customer',
    plural: 'customers',
    explain:
      'Deleted customers — and their vehicles — disappear from lists and pickers. Their job cards, invoices and history are kept, and you can restore them from the Deleted tab. A customer with an open job card, a booked appointment or an unpaid invoice is skipped.',
    reason: 'optional',
    permission: 'customer.edit',
  },
  vehicles: {
    verb: 'Delete',
    past: 'deleted',
    singular: 'vehicle',
    plural: 'vehicles',
    explain:
      'Deleted vehicles disappear from lists and pickers. Their job cards and invoices are kept, and you can restore them from the Deleted tab. A vehicle with an open job card or a booked appointment is skipped.',
    reason: 'optional',
    permission: 'vehicle.edit',
  },
  'job-cards': {
    verb: 'Cancel',
    past: 'cancelled',
    singular: 'job card',
    plural: 'job cards',
    explain:
      'Cancelled job cards keep their number and history, and can’t be reopened. Only job cards that haven’t been invoiced can be cancelled — the rest are skipped (void the invoice first).',
    reason: 'optional',
    permission: 'job_card.edit',
  },
  quotations: {
    verb: 'Delete',
    past: 'deleted',
    singular: 'quotation',
    plural: 'quotations',
    explain:
      'Only drafts that were never sent are deleted. A quotation the customer has seen stays on record — revise it or record their decision instead — so those are skipped.',
    reason: 'optional',
    permission: 'job_card.edit',
  },
  invoices: {
    verb: 'Void',
    past: 'voided',
    singular: 'invoice',
    plural: 'invoices',
    explain:
      'A tax invoice can’t be erased. Voiding keeps its number, marks it VOID with your reason, and sends its job card back to be invoiced again. Invoices with a payment on them are skipped — reverse the payment first.',
    reason: 'required',
    permission: 'invoice.cancel',
  },
  payments: {
    verb: 'Reverse',
    past: 'reversed',
    singular: 'payment',
    plural: 'payments',
    explain:
      'Reversing adds an equal and opposite entry with your reason: the original payment stays on record and the invoice’s balance goes back up. Payments already reversed, and payments on void invoices, are skipped.',
    reason: 'required',
    permission: 'payment.reverse',
  },
  parts: {
    verb: 'Delete',
    past: 'deleted',
    singular: 'part',
    plural: 'parts',
    explain:
      'A part nobody ever used is removed completely. A part on past quotations, purchases or jobs is archived instead — hidden from pickers, still on every document, and back with Edit → Active. Parts still in stock or on an open purchase are skipped.',
    reason: 'optional',
    permission: 'inventory.manage',
  },
  suppliers: {
    verb: 'Delete',
    past: 'deleted',
    singular: 'supplier',
    plural: 'suppliers',
    explain:
      'A supplier you never bought from is removed completely. One with purchases is archived instead — hidden from pickers, still on every purchase, and back with Edit → Active. Suppliers with an open purchase or money still owed are skipped.',
    reason: 'optional',
    permission: 'inventory.manage',
  },
  purchases: {
    verb: 'Cancel',
    past: 'cancelled',
    singular: 'purchase',
    plural: 'purchases',
    explain:
      'Cancelled purchases stay on record with their number. Only purchases with nothing received yet can be cancelled — anything received is already in stock and in the books, so those are skipped.',
    reason: 'optional',
    permission: 'purchase.create',
  },
  movements: {
    verb: 'Reverse',
    past: 'reversed',
    singular: 'stock movement',
    plural: 'stock movements',
    explain:
      'Reversing adds an equal and opposite movement with your reason, so stock goes back to what it was and the original stays in the ledger. Only adjustments and opening stock can be reversed; purchases, jobs and movements already reversed are skipped.',
    reason: 'required',
    permission: 'inventory.adjust',
  },
};

/** Most records one request may touch — a page of a list. */
export const MAX_REMOVE_AT_ONCE = 100;

export interface RemovalOutcome {
  /** Ids that were deleted, voided, cancelled or reversed. */
  done: string[];
  /** How many of `done` were archived rather than removed (parts, suppliers). */
  archived: number;
  /** Ids left as they were, each with the reason — already phrased for the user. */
  skipped: { id: string; reason: string }[];
}
