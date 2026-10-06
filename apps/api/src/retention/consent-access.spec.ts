// Consent records are read and deleted only through ConsentRetentionRepository (ADR 0004 9.5 "System
// carve-out"; FR-105, NFR-05, C-17). SERVICE scope has no column limits, and Prisma returns every
// scalar column by default, so the rule is enforced in the service layer: any other file under
// apps/api/src that touches the consent model, includes or selects it, names `signedName`, or runs
// raw SQL on `consents` fails here. The SUPER_ADMIN legal-claim path, when it exists, is added to
// the allowlist in the PR that builds it (which is the review point).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { consentAccessHits } from '../test/retention/consent-access-scan';

const SRC = resolve(__dirname, '..');

const ALLOWED: Record<string, string> = {
  'retention/consent-retention.repository.ts': 'the one repository, with a fixed select',
  'test/retention/retention-harness.ts': 'test helper: sets up fixtures with the owner role',
  'test/retention/consent-access-scan.ts': 'the scanner names what it looks for',
  // BE-07 candidate consent flow (FR-106, C-07): sign and decline run in the org scope, keyed by
  // the token's sessionId (the row create is not allowed in candidate scope, CS-4.4), and the
  // signed PDF is rendered from what was typed. Nothing here lists or reads other candidates'
  // consents. The exact hits of each file are pinned in the test below.
  'candidate/consent.service.ts': 'sign and decline of the session own consent (C-07)',
  'candidate/consent-pdf.service.ts': 'renders the signed PDF for the session own consent',
  'candidate/consent-pdf.renderer.ts': 'pure renderer of the typed legal name',
  'candidate/dto/candidate.dto.ts': 'request DTO carries the typed signedName',
  'candidate/session-jobs.service.ts': 'sweep re-queues signed consents that have no PDF yet',
  // ADR 0013 CS-4.4 (#126). The CANDIDATE scope names the column to ALLOW the candidate to write its own
  // consent (signing) and to REFUSE any read of it; neither reads the column, and neither can see
  // another candidate's consent (the session filter). One reviewed place each.
  'database/session-scope-map.ts':
    'names the column in the candidate write allowlist; never reads it',
  'database/candidate-interim.ts':
    'names the column in the read deny list (hides it from candidate reads); never reads it',
};

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'generated' || entry === 'node_modules') continue;
    if (statSync(path).isDirectory()) out.push(...files(path));
    else if (
      path.endsWith('.ts') &&
      !/\.(spec|test|e2e-spec)\.ts$/.test(path) &&
      !path.includes('/database/testing/')
    ) {
      out.push(path);
    }
  }
  return out;
}

describe('consent access (FR-105, NFR-05, C-17)', () => {
  it('only ConsentRetentionRepository touches the consent model, a consent include, signedName or consents SQL', () => {
    const offenders: string[] = [];
    for (const file of files(SRC)) {
      const rel = relative(SRC, file);
      if (Object.hasOwn(ALLOWED, rel)) continue;
      for (const hit of consentAccessHits(readFileSync(file, 'utf8')))
        offenders.push(`${rel}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  it('the scanner catches each way in (guard the guard)', () => {
    const offenders = [
      'await prisma.client.consent.findMany({})',
      'await tx.consent.delete({ where: { id } })',
      'session.findFirst({ include: { consent: true } })',
      'select: { consent: { select: { ip: true } } }',
      'const name = row.signedName;',
      'await prisma.client.session.findUnique({ where: { id } }).consent()',
      'SELECT * FROM consents WHERE id = $1',
      'DELETE FROM public.consents',
      'UPDATE "consents" SET ip = NULL',
      "await client['consent'].findMany()",
      'await tx.consent?.findMany()',
      'const { consent } = tx; consent.findMany()',
      'include: { consent: withConsent }',
    ];
    for (const sample of offenders) expect(consentAccessHits(sample)).not.toEqual([]);
    expect(consentAccessHits("const consentText = 'x'; consentTexts.findMany()")).toEqual([]);
    expect(consentAccessHits('SELECT * FROM consent_texts')).toEqual([]);
  });

  it('the allowlisted repository really uses the consent model (it cannot go stale), and never names signedName', () => {
    const text = readFileSync(join(SRC, 'retention/consent-retention.repository.ts'), 'utf8');
    expect(consentAccessHits(text)).toEqual(
      expect.arrayContaining(['client access to the consent model']),
    );
    // It may mention the column only in comments that say it is never read; no code reads it.
    expect(text.replace(/\/\/.*|\/\*[\s\S]*?\*\//g, '')).not.toMatch(
      /signedName|userAgent|\bip\b\s*:/,
    );
  });

  it('the two candidate-scope files name signedName and nothing else of the consent data (a later read there fails)', () => {
    for (const rel of ['database/session-scope-map.ts', 'database/candidate-interim.ts']) {
      expect({ rel, hits: consentAccessHits(readFileSync(join(SRC, rel), 'utf8')) }).toEqual({
        rel,
        hits: ['signedName'],
      });
    }
  });

  it('the BE-07 candidate files are pinned to their exact consent hits (a new read or a new column fails)', () => {
    const MODEL = 'client access to the consent model';
    const pinned: Record<string, string[]> = {
      'candidate/consent.service.ts': [MODEL, 'signedName'],
      'candidate/consent-pdf.service.ts': [MODEL, 'signedName'],
      'candidate/consent-pdf.renderer.ts': ['signedName'],
      'candidate/dto/candidate.dto.ts': ['signedName'],
      // The sweep only lists signed consents by id and date: model access, never the name.
      'candidate/session-jobs.service.ts': [MODEL],
    };
    for (const [rel, hits] of Object.entries(pinned)) {
      expect({ rel, hits: consentAccessHits(readFileSync(join(SRC, rel), 'utf8')) }).toEqual({
        rel,
        hits,
      });
    }
  });
});
