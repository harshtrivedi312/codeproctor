'use client';
import { useAuth } from './auth-provider';

export const ROLE_LABELS = {
  SUPER_ADMIN: 'Super Admin',
  RECRUITER: 'Recruiter',
  AUTHOR: 'Author',
  REVIEWER: 'Reviewer',
} as const;

export function UserBadge(): React.JSX.Element | null {
  const { user, role } = useAuth();
  if (!user || !role) return null;
  return (
    <span className="hidden text-sm text-muted-foreground sm:inline" data-testid="user-badge">
      {user.name} · {ROLE_LABELS[role]}
    </span>
  );
}
