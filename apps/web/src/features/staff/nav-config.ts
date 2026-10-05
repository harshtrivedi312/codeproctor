import {
  BarChart3,
  ClipboardCheck,
  FileQuestion,
  LayoutDashboard,
  ListChecks,
  Radio,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { UserRole } from '@codeproctor/shared';
import { canAny, type StaffPermission } from './permissions';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Any one of these shows the item. Omit for every signed-in staff user. */
  anyOf?: readonly StaffPermission[];
}

/** Order is the order in the sidebar. Hrefs are the routes under (staff)/admin/(app). */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/admin', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/admin/questions', label: 'Questions', icon: FileQuestion, anyOf: ['question:read'] },
  { href: '/admin/tests', label: 'Tests', icon: ListChecks, anyOf: ['test:read'] },
  {
    href: '/admin/candidates',
    label: 'Candidates',
    icon: Users,
    // Recruiters work with candidates through invitations; Super Admin through erasure.
    anyOf: ['invitation:create', 'candidate:erase'],
  },
  {
    href: '/admin/review',
    label: 'Review queue',
    icon: ClipboardCheck,
    anyOf: ['review_queue:read'],
  },
  { href: '/admin/live', label: 'Live', icon: Radio, anyOf: ['live:view'] },
  { href: '/admin/reports', label: 'Reports', icon: BarChart3, anyOf: ['report:read'] },
  {
    href: '/admin/settings',
    label: 'Settings',
    icon: Settings,
    anyOf: ['user:manage', 'org_settings:manage'],
  },
];

export function navItemsFor(role: UserRole | null): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.anyOf || canAny(role, item.anyOf));
}

/** True when the pathname is the item's page or below it. Dashboard matches only itself. */
export function isActive(href: string, pathname: string): boolean {
  return href === '/admin'
    ? pathname === '/admin'
    : pathname === href || pathname.startsWith(`${href}/`);
}
