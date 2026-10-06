// Pure host guard: no k6 imports and no __ENV, so k6 (lib/config.js) and node --test
// (lib/guard.test.mjs) use the same code.
//
// The whole URL is validated against a strict pattern before a host is taken from it. Anything k6
// (Go net/url) could read differently from this code is refused: userinfo (@), query (?), fragment
// (#), backslash, percent-escapes, whitespace, brackets (IPv6) and any other character.
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', 'host.docker.internal'];
export const DENY = ['prod', 'production', 'pilot']; // substring match: "product-staging" is refused

const URL_PATTERN = /^https?:\/\/([a-z0-9.-]+)(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/i;

// Returns the lower-case host of a strictly valid URL, or throws.
export function parseHost(url) {
  const m = URL_PATTERN.exec(url);
  if (!m) {
    throw new Error(
      'Refusing to run: API_BASE_URL must look like http(s)://host[:port][/path] with only ' +
        'letters, digits, dot and hyphen in the host and no userinfo, query, fragment or escapes.',
    );
  }
  const host = m[1].toLowerCase();
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..') || host.startsWith('-')) {
    throw new Error('Refusing to run: the host name is malformed (leading or trailing dot).');
  }
  return host;
}

// Throws unless the URL's host is local or in the allowed list (exact, case-insensitive) and does
// not contain a deny-list word. The deny-list cannot be overridden.
export function checkTarget(url, allowedHostsText) {
  const host = parseHost(url);
  for (const bad of DENY) {
    if (host.includes(bad)) {
      throw new Error(
        `Refusing to run: host name contains "${bad}". Load tests run against staging with ` +
          'synthetic data only (DEP-01). This check cannot be overridden.',
      );
    }
  }
  const allowed = (allowedHostsText || '')
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .filter((h) => h !== '');
  if (!LOCAL_HOSTS.includes(host) && !allowed.includes(host)) {
    throw new Error(
      `Refusing to run: host "${host}" is not in ALLOWED_HOSTS (exact names, comma separated). ` +
        'Name the staging host explicitly.',
    );
  }
  return host;
}
