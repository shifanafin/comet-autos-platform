import {
  Clock3,
  ArrowRightLeft,
  PiggyBank,
  LayoutDashboard,
  LayoutGrid,
  CalendarDays,
  ClipboardList,
  ClipboardCheck,
  FileText,
  BadgeCheck,
  BriefcaseBusiness,
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
  FileSignature,
  Percent,
  IdCard,
  CalendarCheck,
  CalendarOff,
  Banknote,
  BarChart3,
  Settings,
  ShieldCheck,
  ScrollText,
  FileMinus,
  FileSpreadsheet,
  Landmark,
  Building2,
  BookOpen,
  CreditCard,
  Tags,
  BookText,
  CalendarCheck2,
  CalendarClock,
  FolderOpen,
  NotebookPen,
  Scale,
  Sheet,
  TrendingUp,
  WalletCards,
  UserRoundCheck,
  ListTodo,
  ListChecks,
  Gauge,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Permission needed to see the item (the page itself still checks on the server). */
  permission?: string;
  /**
   * A self-service page (an employee's own attendance and to-dos): shown to a
   * login linked to an employee record instead of by permission.
   */
  forEmployees?: boolean;
  /** Module not built yet: shown muted with a "Soon" tag; the route shows a placeholder. */
  soon?: boolean;
}

export interface NavGroup {
  label: string | null;
  /**
   * A section this group sits inside in the sidebar — Finance holds Sales &
   * receivables, VAT, Reports… Everything else reads groups flat, so a group
   * with a parent is still just a group of links to them.
   */
  parent?: string;
  items: NavItem[];
}

/*
 * The sidebar, grouped by how the workshop works. Items a user has no
 * permission for are not shown (hiding is convenience only — every page and
 * action enforces permissions on the server). Modules not built yet stay
 * listed, marked "Soon", so nothing silently disappears.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: null,
    // Everyone's home page: each panel on it checks its own permission.
    items: [{ label: 'Dashboard', href: '/', icon: LayoutDashboard }],
  },
  {
    label: 'Workshop',
    items: [
      { label: 'Overview', href: '/workshop', icon: LayoutGrid, permission: 'job_card.view' },
      { label: 'Workshop today', href: '/live', icon: Gauge, permission: 'job_card.view' },
      {
        label: 'Appointments',
        href: '/appointments',
        icon: CalendarDays,
        permission: 'appointment.view',
      },

      { label: 'Job Cards', href: '/job-cards', icon: ClipboardList, permission: 'job_card.view' },


      {
        label: 'Inspections',
        href: '/inspections',
        icon: ClipboardCheck,
        permission: 'job_card.view',
      },
      { label: 'Approvals', href: '/approvals', icon: BadgeCheck, permission: 'quotation.view' },
    ],
  },

  {
    label: 'Sales and Customers',
    items: [
      { label: 'Overview', href: '/sales', icon: LayoutGrid, permission: 'invoice.view' },
      { label: 'Customers', href: '/customers', icon: Users, permission: 'customer.view' },
      { label: 'Vehicles', href: '/vehicles', icon: Car, permission: 'vehicle.view' },
      { label: 'Quotations', href: '/quotations', icon: FileText, permission: 'quotation.view' },
      {
        label: 'Sales invoices',
        href: '/finance/invoices',
        icon: Receipt,
        permission: 'invoice.view',
      },
      { label: 'Receipts', href: '/finance/payments', icon: Wallet, permission: 'payment.view' },
      {
        label: 'Credit notes',
        href: '/finance/credit-notes',
        icon: FileMinus,
        permission: 'credit_note.view',
      },
    ],
  },
  {
    label: 'Bills and Suppliers',
    items: [
      {
        label: 'Suppliers',
        href: '/inventory/suppliers',
        icon: Truck,
        permission: 'inventory.view',
      },
    ],
  },

  {
    label: 'Inventory',
    items: [
      { label: 'Overview', href: '/inventory', icon: LayoutGrid, permission: 'inventory.view' },
      { label: 'Parts', href: '/inventory/parts', icon: Cog, permission: 'inventory.view' },
      {
        label: 'Purchases',
        href: '/inventory/purchases',
        icon: ShoppingCart,
        permission: 'purchase.view',
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
    label: 'Overview',
    parent: 'Finance',
    items: [
      { label: 'Financial overview', href: '/finance', icon: ChartPie, permission: 'invoice.view' },
      {
        label: 'Tax & accounting calendar',
        href: '/finance/calendar',
        icon: CalendarClock,
        permission: 'accounting.view',
      },
    ],
  },
  {
    label: 'Money',
    parent: 'Finance',
    items: [
      { label: 'Money', href: '/finance/money', icon: PiggyBank, permission: 'money.view' },
      {
        label: 'Money transfers',
        href: '/finance/money/transfers',
        icon: ArrowRightLeft,
        permission: 'money.view',
      },
    ],
  },
  {
    label: 'Sales & receivables',
    parent: 'Finance',
    items: [
      {
        label: 'Customers owing',
        href: '/finance/outstanding',
        icon: HandCoins,
        permission: 'invoice.view',
      },
      {
        label: 'Statements of account',
        href: '/finance/statements',
        icon: FileSpreadsheet,
        permission: 'invoice.view',
      },
    ],
  },
  {
    label: 'Purchases & payables',
    parent: 'Finance',
    items: [
      {
        label: 'Expenses & bills',
        href: '/finance/expenses',
        icon: ReceiptText,
        permission: 'expense.view',
      },
      {
        label: 'Payment vouchers',
        href: '/finance/payment-vouchers',
        icon: FileSignature,
        permission: 'payment_voucher.view',
      },
      {
        label: 'Suppliers owed',
        href: '/finance/payables',
        icon: Banknote,
        permission: 'supplier_payment.view',
      },
      {
        label: 'Owed to owner',
        href: '/finance/owner-advances',
        icon: UserRoundCheck,
        permission: 'accounting.view',
      },
    ],
  },

  {
    label: 'Reports',
    parent: 'Finance',
    items: [
      {
        label: 'Profit & loss',
        href: '/finance/accounting?view=profit',
        icon: TrendingUp,
        permission: 'reports.view',
      },
      {
        label: 'Balance sheet',
        href: '/finance/accounting?view=balance',
        icon: Scale,
        permission: 'reports.view',
      },
      {
        label: 'Cash flow',
        href: '/finance/accounting?view=cash',
        icon: WalletCards,
        permission: 'reports.view',
      },
      {
        label: 'Trial balance',
        href: '/finance/accounting?view=trial',
        icon: Sheet,
        permission: 'reports.view',
      },
      { label: 'Reports', href: '/reports', icon: BarChart3, permission: 'reports.view' },
    ],
  },
  {
    label: 'Accounting',
    parent: 'Finance',
    items: [
      {
        label: 'Chart of accounts',
        href: '/finance/accounting?view=accounts',
        icon: BookOpen,
        permission: 'accounting.view',
      },
      {
        label: 'Journal entries',
        href: '/finance/accounting?view=journal',
        icon: NotebookPen,
        permission: 'accounting.view',
      },
      {
        label: 'General ledger',
        href: '/finance/accounting?view=ledger',
        icon: BookText,
        permission: 'accounting.view',
      },
      {
        label: 'Opening balances',
        href: '/finance/accounting/opening-balances',
        icon: FolderOpen,
        permission: 'accounting.view',
      },
      {
        label: 'Months before the books',
        href: '/finance/accounting/prior-periods',
        icon: History,
        permission: 'accounting.view',
      },
      {
        label: 'Bank reconciliation',
        href: '/finance/bank-reconciliation',
        icon: Landmark,
        permission: 'accounting.view',
      },
      {
        label: 'Fixed assets',
        href: '/finance/fixed-assets',
        icon: Building2,
        permission: 'accounting.view',
      },
      {
        label: 'Year-end closing',
        href: '/finance/accounting/year-end',
        icon: CalendarCheck2,
        permission: 'accounting.view',
      },
      {
        label: 'Tax codes',
        href: '/finance/accounting/tax-codes',
        icon: Tags,
        permission: 'settings.view',
      },
      {
        label: 'Payment modes',
        href: '/finance/accounting/payment-modes',
        icon: CreditCard,
        permission: 'settings.view',
      },
    ],
  },

  {
    label: 'My Team',
    items: [
      { label: 'My work', href: '/my-work', icon: ListTodo, forEmployees: true },
      { label: 'Team tasks', href: '/team', icon: ListChecks, permission: 'task.view' },
    ],
  },

  {
    label: 'VAT',
    items: [{ label: 'VAT returns', href: '/finance/vat', icon: Percent, permission: 'vat.view' }],
  },
  {
    label: 'HR',
    items: [
      { label: 'Overview', href: '/hr', icon: LayoutGrid, permission: 'employee.view' },
      { label: 'Employees', href: '/hr/employees', icon: IdCard, permission: 'employee.view' },
      {
        label: 'Designations',
        href: '/hr/designations',
        icon: BriefcaseBusiness,
        permission: 'employee.view',
      },
      {
        label: 'Attendance',
        href: '/hr/attendance',
        icon: CalendarCheck,
        permission: 'attendance.view',
      },
      { label: 'Leave', href: '/hr/leave', icon: CalendarOff, permission: 'leave.view' },
      { label: 'Payroll', href: '/hr/payroll', icon: Banknote, permission: 'payroll.view' },
      { label: 'Overtime', href: '/hr/overtime', icon: Clock3, permission: 'payroll.view' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { label: 'Settings', href: '/settings', icon: Settings, permission: 'settings.view' },
      {
        label: 'Users & roles',
        href: '/settings/users',
        icon: ShieldCheck,
        permission: 'user.view',
      },
      { label: 'Audit log', href: '/settings/audit', icon: History, permission: 'audit.view' },
      { label: 'Letterhead', href: '/letterhead', icon: ScrollText, permission: 'settings.view' },
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

/**
 * The menu item for the page being shown: the most specific match. A link
 * with a query (a tab of the accounting page) matches only on that tab; a
 * plain link matches its path and everything under it, and the longest
 * wins — so "Opening balances" is current on its page, not "Financial
 * overview" at /finance.
 */
export function activeNavHref(
  pathname: string,
  searchParams: { get(name: string): string | null },
  hrefs: string[],
): string | null {
  let best: string | null = null;
  let bestScore = -1;
  for (const href of hrefs) {
    const [path, query] = href.split('?');
    let score = -1;
    if (query) {
      const wanted = new URLSearchParams(query);
      const matches =
        pathname === path &&
        [...wanted.entries()].every(([key, value]) => searchParams.get(key) === value);
      if (matches) score = path.length + 1000;
    } else if (
      path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`)
    ) {
      score = path.length;
    }
    if (score > bestScore) {
      best = href;
      bestScore = score;
    }
  }
  return best;
}
