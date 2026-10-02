/**
 * QA-01 contract tests against apps/web/openapi/openapi.yaml and packages/shared.
 * They guard the TC IDs that depend on what the candidate API is allowed to send or accept.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loginRequestSchema, otpCodeSchema } from '@codeproctor/shared';
import { describe, expect, it } from 'vitest';

// Vitest runs with apps/web as the working directory.
const spec = readFileSync(resolve(process.cwd(), 'openapi/openapi.yaml'), 'utf8');

function schemaBlock(name: string): string {
  const start = spec.indexOf(`\n    ${name}:\n`);
  expect(start, `schema ${name} exists`).toBeGreaterThan(-1);
  const rest = spec.slice(start + 1);
  const next = rest.slice(1).search(/\n {4}[A-Za-z]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('TC-011 hidden tests hidden (FR-202), contract side', () => {
  it('TC-011 candidate schemas expose sample tests only, with no hidden or weight fields', () => {
    for (const name of ['SampleTest', 'Question', 'CandidateSession']) {
      expect(schemaBlock(name)).not.toMatch(/hidden|weight|isHidden|reference/i);
    }
  });
});

describe('TC-001 valid staff login (FR-101), validation side', () => {
  it('TC-001 accepts a correct email and password shape', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@example.com', password: 'x' }).success).toBe(
      true,
    );
  });
  it('TC-001 trims the email and rejects an empty password', () => {
    expect(loginRequestSchema.parse({ email: '  a@example.com ', password: 'x' }).email).toBe(
      'a@example.com',
    );
    expect(loginRequestSchema.safeParse({ email: 'a@example.com', password: '' }).success).toBe(
      false,
    );
  });
});

describe('TC-007 and TC-097 candidate OTP (FR-106), format side', () => {
  it('TC-007 rejects codes that are not exactly six digits', () => {
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 456', '12345a']) {
      expect(otpCodeSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
  it('TC-097 accepts a six digit code with surrounding spaces trimmed', () => {
    expect(otpCodeSchema.safeParse(' 123456 ').success).toBe(true);
  });
});
