/**
 * Output normalization before comparison (FR-503): CRLF becomes LF, trailing whitespace is trimmed
 * on every line, and trailing blank lines (trailing whitespace overall) are dropped. Leading
 * whitespace and inner blank lines are significant.
 */
// Linear backwards scans: candidate output is attacker-controlled, so no backtracking regexes.
function trimEndChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

export function normalizeOutput(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return trimEndChars(lines.map((line) => trimEndChars(line, ' \t\f\v')).join('\n'), ' \t\f\v\n');
}

export function outputsMatch(actual: string, expected: string): boolean {
  return normalizeOutput(actual) === normalizeOutput(expected);
}

/** Cuts text to at most maxChars and reports whether it did. */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  return text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };
}
