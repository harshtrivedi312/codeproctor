import { CODE_LANGUAGES } from '@codeproctor/shared';
import { LANGUAGE_IDS, isExecLanguage, judge0LanguageId } from './language-map';

describe('language map (FR-501, FR-503)', () => {
  it('FR-501: covers CODE_LANGUAGES exactly', () => {
    expect(Object.keys(LANGUAGE_IDS).sort()).toEqual([...CODE_LANGUAGES].sort());
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
