// The scanner behind retention-markers.spec.ts, as a function so it can be tested on synthetic
// offenders. A file is an offender if it contains any marker, reserved action or constant name, OR a
// fragment that could be assembled into one ('RETENTION_' + 'FACE_DONE', `RETENTION_${tier}_DONE`,
// 'ERASURE_' + 'COMPLETED'). Test only.
export const RESERVED_NAMES = [
  'RETENTION_FACE_DONE',
  'RETENTION_MEDIA_DONE',
  'RETENTION_RESULTS_DONE',
  'ERASURE_EMAIL_SENT',
  'ERASURE_EMAIL_FAILED',
  'ERASURE_COMPLETED',
  'ERASURE_NOTICE_RECORDED',
  'ERASURE_SESSION_FENCED',
  'ERASURE_SESSION_PURGED',
  'ERASURE_LIST_COMPLETED',
  'RETENTION_MARKER_ACTIONS',
  'ERASURE_RESERVED_ACTIONS',
];

/** Pieces from which a reserved name could be built at runtime. */
export const RESERVED_FRAGMENTS = [
  '_FACE_DONE',
  '_MEDIA_DONE',
  '_RESULTS_DONE',
  'ERASURE_EMAIL',
  'ERASURE_NOTICE',
  'ERASURE_SESSION_FENCED',
  'ERASURE_COMPLETED',
  'FACE_DONE',
  'MEDIA_DONE',
  'RESULTS_DONE',
];

/** What is wrong with `text`, or an empty list. `RETENTION_` next to a template placeholder counts. */
export function reservedActionHits(text: string): string[] {
  const hits: string[] = [];
  for (const name of [...RESERVED_NAMES, ...RESERVED_FRAGMENTS])
    if (text.includes(name)) hits.push(name);
  if (
    /RETENTION_\$\{/.test(text) ||
    /['"`]RETENTION_['"`]/.test(text) ||
    /['"`]ERASURE_['"`]/.test(text)
  ) {
    hits.push('built RETENTION_ or ERASURE_ name');
  }
  return hits;
}
