// Run with: node --test packages/qa/k6/lib/guard.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTarget } from './guard.js';

const ALLOWED = 'staging.example.com,api.staging.example.com';

const bad = [
  ['userinfo', 'https://user@staging.example.com/api/v1'],
  ['userinfo hiding prod', 'https://staging.example.com@api.prod.example.com/api/v1'],
  ['question mark then @', 'https://api.prod.example.com?@staging.example.com/api/v1'],
  ['hash then @', 'https://api.prod.example.com#@staging.example.com/api/v1'],
  ['backslash', 'https://staging.example.com\\@api.prod.example.com/api/v1'],
  ['percent-encoded @', 'https://staging.example.com%40api.prod.example.com/api/v1'],
  ['percent in path', 'https://staging.example.com/api%2fv1'],
  ['trailing dot', 'https://staging.example.com./api/v1'],
  ['leading dot', 'https://.staging.example.com/api/v1'],
  ['double dot', 'https://staging..example.com/api/v1'],
  ['IPv6', 'http://[::1]:4000/api/v1'],
  ['whitespace', 'https://staging.example.com /api/v1'],
  ['query string', 'https://staging.example.com/api/v1?x=1'],
  ['fragment', 'https://staging.example.com/api/v1#x'],
  ['other scheme', 'ftp://staging.example.com/api/v1'],
  ['no scheme', 'staging.example.com/api/v1'],
  ['empty', ''],
  ['prod substring', 'https://api.prod.example.com/api/v1'],
  ['prod substring even if allowed', 'https://prod.example.com/api/v1', 'prod.example.com'],
  ['production substring', 'https://production.example.com/api/v1', 'production.example.com'],
  ['pilot substring', 'https://pilot.example.com/api/v1', 'pilot.example.com'],
  [
    'product-staging (substring match)',
    'https://product-staging.example.com/api/v1',
    'product-staging.example.com',
  ],
  ['unlisted host', 'https://other.example.com/api/v1'],
  ['subdomain of an allowed host', 'https://x.staging.example.com/api/v1'],
  ['no ALLOWED_HOSTS', 'https://staging.example.com/api/v1', ''],
];

const good = [
  ['allowed host', 'https://staging.example.com/api/v1', 'staging.example.com'],
  ['allowed with port', 'https://staging.example.com:8443/api/v1', 'staging.example.com'],
  ['uppercase URL and list', 'HTTPS://Staging.Example.COM/api/v1', 'STAGING.example.com'],
  [
    'second list entry with spaces',
    'https://api.staging.example.com/api/v1',
    'staging.example.com, api.staging.example.com',
  ],
  ['localhost without a list', 'http://localhost:4000/api/v1', ''],
  ['127.0.0.1 without a list', 'http://127.0.0.1:4010/api/v1', ''],
  ['host.docker.internal without a list', 'http://host.docker.internal:4010/api/v1', ''],
  ['no path', 'https://staging.example.com', 'staging.example.com'],
];

for (const [name, url, list = ALLOWED] of bad) {
  test(`refuses: ${name}`, () => {
    assert.throws(() => checkTarget(url, list), /Refusing to run/);
  });
}
for (const [name, url, list] of good) {
  test(`accepts: ${name}`, () => {
    assert.equal(typeof checkTarget(url, list), 'string');
  });
}
