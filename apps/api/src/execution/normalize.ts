/**
 * Output normalization before comparison (FR-503): CRLF becomes LF, trailing whitespace is trimmed
 * on every line, and trailing blank lines (trailing whitespace overall) are dropped. Leading
 * whitespace and inner blank lines are significant.
 */
export function normalizeOutput(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+$/, ''))
    .join('\n')
    .replace(/\s+$/, '');
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
