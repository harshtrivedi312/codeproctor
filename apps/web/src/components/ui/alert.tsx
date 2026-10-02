import { cva, type VariantProps } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '@/lib/utils';

const alertVariants = cva('rounded-md border p-3 text-sm', {
  variants: {
    tone: {
      error: 'border-destructive bg-destructive-soft text-foreground',
      warning: 'border-warning bg-warning-soft text-foreground',
      success: 'border-success bg-success-soft text-foreground',
      info: 'border-border bg-muted text-foreground',
    },
  },
  defaultVariants: { tone: 'info' },
});

interface AlertProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof alertVariants> {
  title?: string;
}

export function Alert({
  tone,
  title,
  className,
  children,
  ...props
}: AlertProps): React.JSX.Element {
  return (
    <div className={cn(alertVariants({ tone }), className)} {...props}>
      {title ? <p className="font-medium">{title}</p> : null}
      <div className={title ? 'mt-1' : undefined}>{children}</div>
    </div>
  );
}
