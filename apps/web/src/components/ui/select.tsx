import * as React from 'react';
import { cn } from '@/lib/utils';

/** Native select styled like Input. Native keeps keyboard and screen reader behaviour for free. */
export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, ...props }, ref) => (
  <select
    ref={ref}
    className={cn(
      'h-10 rounded-md border border-input bg-card px-2 text-sm disabled:opacity-60 aria-[invalid=true]:border-destructive',
      className,
    )}
    {...props}
  />
));
Select.displayName = 'Select';
