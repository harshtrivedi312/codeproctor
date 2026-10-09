// The practice question (FR-406): fixed content served from code, never from a test. Nothing the
// candidate does with it is stored, timed or graded. The samples here are public by design.
import type { CodeLanguage } from '@codeproctor/shared';

export interface PracticeSampleTest {
  readonly id: string;
  readonly name: string;
  readonly input: string;
  readonly expectedOutput: string;
}

export interface PracticeQuestionContent {
  readonly title: string;
  readonly statementMarkdown: string;
  readonly languages: readonly CodeLanguage[];
  readonly starterCode: Readonly<Record<CodeLanguage, string>>;
  readonly sampleTests: readonly PracticeSampleTest[];
}

/** Longest source accepted by the practice run (characters). A practice constant, not a test limit. */
export const PRACTICE_MAX_CODE_CHARS = 20_000;

export const PRACTICE_QUESTION: PracticeQuestionContent = {
  title: 'Add two numbers',
  statementMarkdown: [
    'Read two integers, one per line, from standard input and print their sum.',
    '',
    'This is a practice question. It is not part of your test, it is not timed and nothing you do here is saved or graded.',
  ].join('\n'),
  languages: ['python', 'javascript', 'java'],
  starterCode: {
    python: 'a = int(input())\nb = int(input())\nprint(a + b)\n',
    javascript:
      "const lines = require('fs').readFileSync(0, 'utf8').split('\\n');\nconst a = Number(lines[0]);\nconst b = Number(lines[1]);\nconsole.log(a + b);\n",
    java: 'import java.util.Scanner;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        long a = in.nextLong();\n        long b = in.nextLong();\n        System.out.println(a + b);\n    }\n}\n',
  },
  sampleTests: [
    { id: 'sample-1', name: 'Sample 1', input: '2\n3\n', expectedOutput: '5' },
    { id: 'sample-2', name: 'Sample 2', input: '-4\n10\n', expectedOutput: '6' },
  ],
};
