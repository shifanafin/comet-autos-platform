/*
 * The permission catalogue: one place naming every code the system enforces,
 * and how they group for a human reading a role.
 *
 * This is a description of the catalogue, not a second authorization system.
 * Enforcement stays exactly where it was — `requirePermission` against the
 * codes a session resolved from the database. The seed and the
 * `ensure-permissions` script write these rows; nothing here grants anything.
 */

export interface PermissionModule {
  /** The `module` column on Permission — the prefix of every code in it. */
  key: string;
  label: string;
  /** What a person actually gets, in terms of the screens they will use. */
  covers: string;
  permissions: { code: string; label: string; detail: string }[];
}

export const PERMISSION_MODULES: PermissionModule[] = [
  {
    key: 'job_card',
    label: 'Job cards & workshop',
    covers: 'Job cards, check-in, appointments, inspection, diagnosis, estimates and approvals.',
    permissions: [
      {
        code: 'job_card.view',
        label: 'View job cards',
        detail: 'Open jobs, inspections, diagnoses, estimates and approvals.',
      },
      {
        code: 'job_card.create',
        label: 'Check vehicles in',
        detail: 'Start a new job from the check-in screen.',
      },
      {
        code: 'job_card.edit',
        label: 'Work on jobs',
        detail: 'Record inspection, diagnosis, repair, labour, quality checks and photos.',
      },
      {
        code: 'job_card.assign',
        label: 'Assign technicians',
        detail: 'Put a technician on a job.',
      },
      {
        code: 'job_card.close',
        label: 'Hand vehicles back',
        detail: 'Deliver a paid job and close it.',
      },
    ],
  },
  {
    key: 'customer',
    label: 'Customers',
    covers: 'The customer directory.',
    permissions: [
      { code: 'customer.view', label: 'View customers', detail: 'Browse and search customers.' },
      {
        code: 'customer.create',
        label: 'Add customers',
        detail: 'Create a customer, including during check-in.',
      },
      { code: 'customer.edit', label: 'Edit customers', detail: 'Change a customer’s details.' },
    ],
  },
  {
    key: 'vehicle',
    label: 'Vehicles',
    covers: 'The vehicle directory and ownership transfers.',
    permissions: [
      {
        code: 'vehicle.view',
        label: 'View vehicles',
        detail: 'Browse vehicles and their service history.',
      },
      {
        code: 'vehicle.create',
        label: 'Add vehicles',
        detail: 'Register a vehicle, including during check-in.',
      },
      {
        code: 'vehicle.edit',
        label: 'Edit & transfer vehicles',
        detail: 'Change details, and transfer a vehicle to a new owner.',
      },
    ],
  },
  {
    key: 'inventory',
    label: 'Inventory',
    covers: 'Parts, stock levels and stock movements.',
    permissions: [
      {
        code: 'inventory.view',
        label: 'View stock',
        detail: 'Parts, suppliers, purchases and stock movements.',
      },
      {
        code: 'inventory.issue',
        label: 'Issue parts to jobs',
        detail: 'Take stock out for a repair.',
      },
      {
        code: 'inventory.adjust',
        label: 'Adjust stock',
        detail: 'Correct a stock level, with a reason.',
      },
      {
        code: 'inventory.manage',
        label: 'Manage parts & suppliers',
        detail: 'Create and edit parts and suppliers.',
      },
    ],
  },
  {
    key: 'purchase',
    label: 'Purchasing',
    covers: 'Buying parts from suppliers.',
    permissions: [
      { code: 'purchase.create', label: 'Raise purchases', detail: 'Order parts from a supplier.' },
      {
        code: 'purchase.receive',
        label: 'Receive deliveries',
        detail: 'Book a delivery in and move stock.',
      },
    ],
  },
  {
    key: 'invoice',
    label: 'Invoicing',
    covers: 'Customer invoices.',
    permissions: [
      {
        code: 'invoice.view',
        label: 'View invoices',
        detail: 'Invoices, the finance overview and outstanding balances.',
      },
      {
        code: 'invoice.create',
        label: 'Issue invoices',
        detail: 'Turn completed work into an invoice.',
      },
      { code: 'invoice.cancel', label: 'Cancel invoices', detail: 'Cancel an issued invoice.' },
    ],
  },
  {
    key: 'payment',
    label: 'Payments',
    covers: 'Money received from customers.',
    permissions: [
      { code: 'payment.view', label: 'View payments', detail: 'See what has been received.' },
      {
        code: 'payment.create',
        label: 'Take payments',
        detail: 'Record a payment against an invoice.',
      },
      {
        code: 'payment.reverse',
        label: 'Reverse payments',
        detail: 'Reverse a payment recorded in error.',
      },
    ],
  },
  {
    key: 'accounting',
    label: 'Accounting & settings',
    covers: 'Expenses, VAT, and the workshop’s own details on customer documents.',
    permissions: [
      {
        code: 'accounting.view',
        label: 'View accounts',
        detail: 'Expenses, VAT and the workshop settings screen.',
      },
      { code: 'accounting.create', label: 'Record expenses', detail: 'Enter an expense.' },
      {
        code: 'accounting.edit',
        label: 'Edit accounts & settings',
        detail: 'Void expenses, and change the workshop details and VAT rate.',
      },
      {
        code: 'accounting.export',
        label: 'Export accounts',
        detail: 'Take accounting data out of the system.',
      },
    ],
  },
  {
    key: 'payroll',
    label: 'Team & payroll',
    covers: 'Employee records, attendance, leave and pay.',
    permissions: [
      {
        code: 'payroll.view',
        label: 'View the team',
        detail: 'Employee records, attendance and leave.',
      },
      {
        code: 'payroll.create',
        label: 'Manage employees & payroll',
        detail: 'Add and edit employees, and prepare payroll.',
      },
      { code: 'payroll.approve', label: 'Approve payroll', detail: 'Sign off a payroll run.' },
      {
        code: 'payroll.export',
        label: 'Export payroll',
        detail: 'Take payroll data out of the system.',
      },
    ],
  },
  {
    key: 'user',
    label: 'Access management',
    covers: 'Who can sign in, and what they are allowed to do.',
    permissions: [
      {
        code: 'user.view',
        label: 'View users & roles',
        detail: 'See the user list, a user’s roles, and what each role allows.',
      },
      {
        code: 'user.manage',
        label: 'Manage users',
        detail:
          'Create logins, assign roles and branches, activate and deactivate, reset passwords.',
      },
      {
        code: 'role.manage',
        label: 'Manage roles',
        detail: 'Create roles and change which permissions a role carries.',
      },
    ],
  },
];

/** Every code the system knows about, in catalogue order. */
export const PERMISSION_CODES = PERMISSION_MODULES.flatMap((module) =>
  module.permissions.map((permission) => permission.code),
);

/**
 * The access-management codes. They did not exist in the original V1
 * catalogue — before this, changing who could sign in meant SQL. They are
 * granted to whichever roles already carried every other permission, so no
 * one gained access they did not already effectively have.
 */
export const ACCESS_PERMISSION_CODES = ['user.view', 'user.manage', 'role.manage'];

const LABELS = new Map(
  PERMISSION_MODULES.flatMap((module) =>
    module.permissions.map((permission) => [permission.code, permission.label] as const),
  ),
);

/** A code's human label, falling back to the code itself for anything unknown. */
export function permissionLabel(code: string) {
  return LABELS.get(code) ?? code;
}
