import { StaffShell } from '@/features/staff/staff-shell';

// Staff shell behind sign-in: sidebar, top bar and breadcrumbs. Each page also declares which
// roles may open it (RequireRole); the API enforces the same on every route (FR-103).
export default function StaffLayout({ children }: { children: React.ReactNode }) {
  return <StaffShell>{children}</StaffShell>;
}
