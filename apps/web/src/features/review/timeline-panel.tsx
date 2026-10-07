'use client';
import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import {
  DASH,
  eventLabel,
  relativeTime,
  severityLabel,
  severityTone,
  type ReviewEvent,
} from './model';

export function TimelinePanel({
  events,
  startedAt,
}: {
  events: readonly ReviewEvent[];
  startedAt: string | null;
}): React.JSX.Element {
  const [severity, setSeverity] = React.useState('');
  const [type, setType] = React.useState('');
  const sorted = React.useMemo(
    () => [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
    [events],
  );
  const types = React.useMemo(() => [...new Set(events.map((e) => e.type))].sort(), [events]);
  const shown = sorted.filter(
    (e) =>
      (severity === '' || (severity === 'NONE' ? e.severity === null : e.severity === severity)) &&
      (type === '' || e.type === type),
  );
  return (
    <section aria-labelledby="timeline-h" className="space-y-3">
      <h2 id="timeline-h" className="text-lg font-semibold">
        Proctor event timeline
      </h2>
      <div className="flex flex-wrap gap-3 text-sm">
        <div className="flex items-center gap-2">
          <label htmlFor="tl-severity">Severity</label>
          <Select id="tl-severity" value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="">All</option>
            <option value="HIGH">High</option>
            <option value="MEDIUM">Medium</option>
            <option value="LOW">Low</option>
            <option value="NONE">Not rated</option>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="tl-type">Type</label>
          <Select id="tl-type" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">All</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {eventLabel(t)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No proctoring events were recorded.</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No events match these filters. Set both filters to All to see every event.
        </p>
      ) : (
        <ol aria-label="Proctoring events" className="divide-y rounded-md border bg-card">
          {shown.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <time
                dateTime={e.at}
                className="w-16 shrink-0 font-mono text-xs"
                title={new Date(e.at).toLocaleString()}
              >
                {relativeTime(e.at, startedAt)}
              </time>
              <span className="font-medium">{eventLabel(e.type)}</span>
              <Badge tone={severityTone(e.severity)}>
                <span className="sr-only">Severity: </span>
                {severityLabel(e.severity)}
              </Badge>
              <span className="text-muted-foreground">{e.detail ?? DASH}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
