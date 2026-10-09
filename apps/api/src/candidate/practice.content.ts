// FR-406: the practice question. Fixed content in code, never read from the test or the question
// bank; nothing the candidate does with it is stored, timed or graded. Hidden tests do not exist
// here: every test is a sample the candidate may see.
import type { CodeLanguage } from '@codeproctor/shared';

export const PRACTICE_TITLE = 'Practice: add two numbers';

export const PRACTICE_STATEMENT = [
  'Try the editor before the timed test. Nothing you do here is saved, timed or graded.',
  '',
  'Read two integers `a` and `b` from standard input, separated by a space, and print their sum.',
  '',
  '**Example**',
  '',
  'Input: `3 4`  Output: `7`',
].join('\n');

export const PRACTICE_LANGUAGES: readonly CodeLanguage[] = ['python', 'javascript', 'java'];

export const PRACTICE_STARTER_CODE: Readonly<Record<CodeLanguage, string>> = {
  python: 'a, b = map(int, input().split())\nprint(a + b)\n',
  javascript:
    "const [a, b] = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(a + b);\n",
  java: 'import java.util.Scanner;\n\npublic class Main {\n  public static void main(String[] args) {\n    Scanner in = new Scanner(System.in);\n    long a = in.nextLong();\n    long b = in.nextLong();\n    System.out.println(a + b);\n  }\n}\n',
};

export interface PracticeSample {
  readonly id: string;
  readonly name: string;
  readonly input: string;
  readonly expectedOutput: string;
}

export const PRACTICE_SAMPLES: readonly PracticeSample[] = [
  { id: 'practice-1', name: 'Small numbers', input: '3 4\n', expectedOutput: '7\n' },
  { id: 'practice-2', name: 'Negative number', input: '-5 12\n', expectedOutput: '7\n' },
  {
    id: 'practice-3',
    name: 'Large numbers',
    input: '1000000000 2000000000\n',
    expectedOutput: '3000000000\n',
  },
];

/** The runner limits for the practice run: small and fixed. */
export const PRACTICE_LIMITS = { cpu_ms: 2000, wall_ms: 5000, memory_kb: 262_144 } as const;

/** Source size cap; the editor never sends more (FR-504 uses the same order of size). */
export const MAX_PRACTICE_CODE_CHARS = 50_000;
