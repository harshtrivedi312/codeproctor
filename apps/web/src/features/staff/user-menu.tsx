'use client';
import { ChevronDown, LogOut } from 'lucide-react';
import * as React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-provider';
import { ROLE_LABELS } from '@/features/auth/user-badge';

export function UserMenu(): React.JSX.Element | null {
  const { user, role, signOut } = useAuth();
  if (!user || !role) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-9 items-center gap-2 rounded-md border bg-card px-3 text-sm hover:bg-accent"
          data-testid="user-menu"
        >
          <span>{user.name}</span>
          <span className="hidden text-muted-foreground sm:inline">· {ROLE_LABELS[role]}</span>
          <ChevronDown className="size-4" aria-hidden="true" />
          <span className="sr-only">Account menu</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel className="px-2 py-1.5 text-sm">
          <span className="block font-medium">{user.name}</span>
          <span className="block text-muted-foreground">{user.email}</span>
          <span className="block text-muted-foreground">{ROLE_LABELS[role]}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-1 h-px bg-border" />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut className="size-4" aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
