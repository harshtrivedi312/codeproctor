import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-foreground',
        success: 'border-success bg-success-soft text-foreground',
        warning: 'border-warning bg-warning-soft text-foreground',
        error: 'border-destructive bg-destructive-soft text-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

/** Status label. Always carries text, so colour is never the only signal (WCAG 1.4.1). */
export function Badge({ tone, className, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
