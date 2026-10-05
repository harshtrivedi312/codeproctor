// Canonical JSON (RFC 8785, JCS) for the signed proctor batches, as ADR 0013 section 2 defines it:
// object keys sorted by UTF-16 code units, no whitespace, ECMAScript number and string
// serialisation, undefined members dropped, non-finite numbers refused.
export function canonicalJson(value) {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('canonicalJson: non-finite number');
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return (
          '[' + value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',') + ']'
        );
      }
      const keys = Object.keys(value)
        .filter((k) => value[k] !== undefined)
        .sort();
      return (
        '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
      );
    }
    default:
      throw new Error('canonicalJson: unsupported value');
  }
}
