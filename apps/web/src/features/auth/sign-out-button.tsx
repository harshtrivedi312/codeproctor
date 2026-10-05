'use client';
import { Button } from '@/components/ui/button';
import { useAuth } from './auth-provider';

export function SignOutButton(): React.JSX.Element | null {
  const { status, signOut } = useAuth();
  if (status !== 'authenticated') return null;
  return (
    <Button variant="outline" size="sm" onClick={() => void signOut()}>
      Sign out
    </Button>
  );
}
