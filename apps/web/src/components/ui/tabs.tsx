'use client';
import * as React from 'react';
import { cn } from '@/lib/utils';

export interface TabDef {
  id: string;
  label: string;
  /** Small text after the label, for example a count or a warning mark. Part of the tab's name. */
  badge?: string;
}

interface TabsProps {
  label: string;
  tabs: readonly TabDef[];
  /** Controlled selection. */
  value: string;
  onValueChange: (id: string) => void;
  /** Renders the panel of the selected tab. Only the selected panel is in the DOM. */
  children: (id: string) => React.ReactNode;
}

/**
 * WAI-ARIA tabs with automatic activation: Left and Right move between tabs (wrapping), Home and
 * End jump to the first and last, Tab leaves the list into the panel. Only the selected tab is in
 * the Tab order (roving tabindex).
 */
export function Tabs({
  label,
  tabs,
  value,
  onValueChange,
  children,
}: TabsProps): React.JSX.Element {
  const baseId = React.useId();
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  function onKeyDown(event: React.KeyboardEvent, index: number): void {
    const last = tabs.length - 1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;
    if (next === null) return;
    event.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onValueChange(target.id);
    refs.current[target.id]?.focus();
  }

  return (
    <div>
      <div role="tablist" aria-label={label} className="flex flex-wrap gap-1 border-b">
        {tabs.map((tab, i) => {
          const selected = tab.id === value;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                refs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-selected={selected}
              aria-controls={panelId(tab.id)}
              tabIndex={selected ? 0 : -1}
              onClick={() => onValueChange(tab.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm hover:bg-accent',
                selected ? 'border-primary font-medium' : 'border-transparent',
              )}
            >
              {tab.label}
              {tab.badge ? (
                <span className="ml-1.5 text-xs text-muted-foreground">{tab.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId(value)}
        aria-labelledby={tabId(value)}
        tabIndex={0}
        className="pt-4 focus-visible:outline-2"
      >
        {children(value)}
      </div>
    </div>
  );
}
