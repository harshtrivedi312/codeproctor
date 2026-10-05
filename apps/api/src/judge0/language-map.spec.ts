import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LANGUAGE_IDS, isExecLanguage, judge0LanguageId } from './language-map';

// packages/shared is outside this app's rootDir and not yet a workspace dependency of apps/api
// (follow-up FU-BE-05-2), so the list is read from its source instead of imported.
function sharedCodeLanguages(): string[] {
  const src = readFileSync(join(__dirname, '../../../../packages/shared/src/code-run.ts'), 'utf8');
  const match = /CODE_LANGUAGES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!match?.[1]) throw new Error('CODE_LANGUAGES not found in packages/shared');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
}

describe('language map (FR-501, FR-503)', () => {
  it('FR-501: covers CODE_LANGUAGES exactly', () => {
    expect(Object.keys(LANGUAGE_IDS).sort()).toEqual([...sharedCodeLanguages()].sort());
  });

  it('FR-503: ids are distinct positive integers', () => {
    const ids = Object.values(LANGUAGE_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach((id) => expect(Number.isInteger(id) && id > 0).toBe(true));
    expect(judge0LanguageId('python')).toBe(LANGUAGE_IDS.python);
  });

  it('FR-503: unknown keys are rejected', () => {
    expect(isExecLanguage('java')).toBe(true);
    expect(isExecLanguage('toString')).toBe(false);
    expect(isExecLanguage('ruby')).toBe(false);
  });
});
