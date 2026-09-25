import {
  LayoutDashboard,
  CalendarDays,
  LogIn,
  ClipboardList,
  ClipboardCheck,
  FileText,
  BadgeCheck,
  Users,
  Car,
  Cog,
  Truck,
  ShoppingCart,
  History,
  Receipt,
  Wallet,
  HandCoins,
  ChartPie,
  ReceiptText,
  Calculator,
  Percent,
  IdCard,
  CalendarCheck,
  CalendarOff,
  Banknote,
  BarChart3,
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Permission needed to see the item (the page itself still checks on the server). */
  permission?: string;
  /** Module not built yet: shown muted with a "Soon" tag; the route shows a placeholder. */
  soon?: boolean;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

/*
 * The sidebar, grouped by how the workshop works. Items a user has no
 * permission for are not shown (hiding is convenience only — every page and
 * action enforces permissions on the server). Modules not built yet stay
 * listed, marked "Soon", so nothing silently disappears.
 */
export const NAV_GROUPS: NavGroup[] = [
  { label: null, items: [{ label: 'Dashboard', href: '/', icon: LayoutDashboard }] },
  /*
   * The four documents the workshop actually touches every day come first,
   * in the order they happen. The detailed lifecycle screens — inspections,
   * approvals, appointments — are still here, one group down, for the jobs
   * that use them.
   */
  {
    label: 'Daily work',
    items: [
      {
        label: 'Work Orders',
        href: '/job-cards',
        icon: ClipboardList,
        permission: 'job_card.view',
      },
      { label: 'Quotations', href: '/quotations', icon: FileText, permission: 'job_card.view' },
      { label: 'Invoices', href: '/finance/invoices', icon: Receipt, permission: 'invoice.view' },
      { label: 'Payments', href: '/finance/payments', icon: Wallet, permission: 'invoice.view' },
    ],
  },
  {
    label: 'Customers',
    items: [
      { label: 'Customers', href: '/customers', icon: Users, permission: 'customer.view' },
      { label: 'Vehicles', href: '/vehicles', icon: Car, permission: 'vehicle.view' },
    ],
  },
  {
    label: 'Workshop',
    items: [
      { label: 'New work order', href: '/check-in', icon: LogIn, permission: 'job_card.create' },
      {
        label: 'Appointments',
        href: '/appointments',
        icon: CalendarDays,
        permission: 'job_card.view',
      },
      {
        label: 'Inspections',
        href: '/inspections',
        icon: ClipboardCheck,
        permission: 'job_card.view',
      },
      { label: 'Approvals', href: '/approvals', icon: BadgeCheck, permission: 'job_card.view' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Parts', href: '/inventory/parts', icon: Cog, permission: 'inventory.view' },
      {
        label: 'Purchases',
        href: '/inventory/purchases',
        icon: ShoppingCart,
        permission: 'inventory.view',
      },
      {
        label: 'Suppliers',
        href: '/inventory/suppliers',
        icon: Truck,
        permission: 'inventory.view',
      },
      {
        label: 'Stock movements',
        href: '/inventory/movements',
        icon: History,
        permission: 'inventory.view',
      },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Overview', href: '/finance', icon: ChartPie, permission: 'invoice.view' },
      {
        label: 'Outstanding',
        href: '/finance/outstanding',
        icon: HandCoins,
        permission: 'invoice.view',
      },
      {
        label: 'Payables',
        href: '/finance/payables',
        icon: Banknote,
        permission: 'inventory.view',
      },
      {
        label: 'Expenses',
        href: '/finance/expenses',
        icon: ReceiptText,
        permission: 'accounting.view',
      },
      {
        label: 'Accounting',
        href: '/finance/accounting',
        icon: Calculator,
        permission: 'accounting.view',
        soon: true,
      },
      {
        label: 'VAT',
        href: '/finance/vat',
        icon: Percent,
        permission: 'accounting.view',
        soon: true,
      },
    ],
  },
  {
    label: 'Team',
    items: [
      {
        label: 'Employees',
        href: '/hr/employees',
        icon: IdCard,
        permission: 'payroll.view',
      },
      {
        label: 'Attendance',
        href: '/hr/attendance',
        icon: CalendarCheck,
        permission: 'payroll.view',
      },
      {
        label: 'Leave',
        href: '/hr/leave',
        icon: CalendarOff,
        permission: 'payroll.view',
        soon: true,
      },
      {
        label: 'Payroll',
        href: '/hr/payroll',
        icon: Banknote,
        permission: 'payroll.view',
        soon: true,
      },
    ],
  },
  {
    label: 'More',
    items: [
      { label: 'Reports', href: '/reports', icon: BarChart3, soon: true },
      { label: 'Settings', href: '/settings', icon: Settings, permission: 'accounting.view' },
      {
        label: 'Users & roles',
        href: '/settings/users',
        icon: ShieldCheck,
        permission: 'user.view',
      },
    ],
  },
];

/*
 * Menus the workshop can switch off in Settings. Hiding is display only:
 * a hidden page still opens from a link, and permissions still decide who
 * may use it.
 */

/** Always shown, so the workshop can never hide its way out of the app. */
export const ALWAYS_SHOWN_MENUS = ['/', '/job-cards', '/settings'];

/** Menus that only serve the standard job card's steps — hidden with the minimal one. */
export const STANDARD_JOB_CARD_MENUS = ['/inspections', '/approvals'];

export function isMenuShown(
  href: string,
  preferences: { hiddenMenus: string[]; detailedJobCards: boolean },
): boolean {
  if (ALWAYS_SHOWN_MENUS.includes(href)) return true;
  if (!preferences.detailedJobCards && STANDARD_JOB_CARD_MENUS.includes(href)) return false;
  return !preferences.hiddenMenus.includes(href);
}

/** Every menu a workshop may hide. */
export function hideableMenuHrefs(): string[] {
  return NAV_GROUPS.flatMap((group) => group.items)
    .map((item) => item.href)
    .filter((href) => !ALWAYS_SHOWN_MENUS.includes(href));
}
