export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** FULLSCREEN_EXIT becomes "Fullscreen exit". */
export function humanizeEventType(type: string): string {
  const words = type.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Locked until 14:05": the clock time, in the admin's own time zone. */
export function lockedUntilText(iso: string | null): string {
  if (!iso) return 'Locked';
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // A lock is 15 minutes, but around midnight it ends on another day: say which.
  return at.toDateString() === new Date().toDateString()
    ? `Locked until ${time}`
    : `Locked until ${at.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}
