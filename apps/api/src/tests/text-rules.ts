// Text Postgres cannot store: a NUL byte is refused by text and jsonb columns, and a lone
// surrogate is refused by jsonb. Both would surface as a 500, so they are rejected as a 400 first.
// Same rule as the question bank (TODO(FU-BE-110): share one copy once slice 4a is on main).
// eslint-disable-next-line no-control-regex -- NUL is exactly what this rejects
const BAD_TEXT = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

export function isStorableText(s: string): boolean {
  return !BAD_TEXT.test(s);
}
