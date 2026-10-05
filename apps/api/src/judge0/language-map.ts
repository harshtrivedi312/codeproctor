import type { CodeLanguage } from '@codeproctor/shared';

// Our language keys to Judge0 CE language ids: the single table (FR-501, FR-503).
// Ids are for Judge0 CE 1.13.x: 100 = Python 3.12.5, 102 = JavaScript (Node.js 22.08.0),
// 91 = Java (JDK 17.0.6). Java sources must declare `public class Main` (Judge0 saves Main.java).
// Verify against `GET /languages` on the real host when ARC-05 confirms it.
export const LANGUAGE_IDS = {
  python: 100,
  javascript: 102,
  java: 91,
} as const satisfies Record<CodeLanguage, number>;

export type ExecLanguage = CodeLanguage;

export function judge0LanguageId(language: ExecLanguage): number {
  return LANGUAGE_IDS[language];
}

export function isExecLanguage(value: string): value is ExecLanguage {
  return Object.prototype.hasOwnProperty.call(LANGUAGE_IDS, value);
}
