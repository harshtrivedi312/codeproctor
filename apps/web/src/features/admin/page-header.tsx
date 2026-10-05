import * as React from 'react';

export function PageHeader({
  title,
  description,
}: {
  title: string;
  description?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="mb-4">
      <h1 className="text-xl font-semibold">{title}</h1>
      {description ? (
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

/** Stand-in for a section that a later build step fills in. */
export function SectionPlaceholder({
  title,
  step,
  children,
}: {
  title: string;
  step: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <PageHeader title={title} />
      <div
        className="rounded-md border border-dashed bg-card p-6 text-sm"
        data-testid="section-placeholder"
      >
        <p className="font-medium">Coming in {step}</p>
        <p className="mt-1 text-muted-foreground">{children}</p>
      </div>
    </>
  );
}
