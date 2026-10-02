'use client';
import { useAuth } from './auth-provider';
import { ROLE_LABELS } from './user-badge';

/** Placeholder until FE-03 builds the dashboard; proves useAuth exposes user and role. */
export function WelcomePanel(): React.JSX.Element | null {
  const { user, role } = useAuth();
  if (!user || !role) return null;
  return (
    <p className="mt-2 text-sm text-muted-foreground">
      Signed in as {user.email} ({ROLE_LABELS[role]}) at {user.orgName}. The rest of the staff area
      arrives in the next steps.
    </p>
  );
}
