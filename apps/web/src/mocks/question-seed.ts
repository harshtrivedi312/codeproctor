import type { Schemas } from '@/lib/api/client';
import { mockRevision } from './question-revision';

/*
 * Seed data of the mock question bank (FE-04). Fake questions only. The reference solutions, hidden
 * tests and answer keys here stand for what the real API keeps away from candidates (TC-011).
 */

type Language = Schemas['Language'];
type Variant = Schemas['Variant'];
export type ValidationReport = Schemas['ValidationReport'];
export type AnswerSpec = Schemas['AnswerSpec'];

export interface MockTestCase {
  id: string;
  position: number;
  isHidden: boolean;
  weight: number;
  input: string;
  expectedOutput: string;
}

/** One version as the mock stores it (the API's question_versions row plus its test cases). */
export interface MockVersion {
  id: string;
  version: number;
  isPublished: boolean;
  title: string;
  difficulty: Schemas['Difficulty'];
  validatedAt: string | null;
  createdAt: string;
  createdByName: string;
  statementMd: string;
  allowedLanguages: Language[];
  limits: Schemas['Limits'];
  starterCode: Record<string, string>;
  referenceSolution: Record<string, string>;
  answerSpec: AnswerSpec | null;
  validationReport: ValidationReport | null;
  testCases: MockTestCase[];
  /** WEB-ONLY placeholder [BE-04b]: the API has no variants yet. */
  variants: Variant[];
}

export interface MockQuestion {
  id: string;
  slug: string;
  type: Schemas['QuestionType'];
  tags: string[];
  isArchived: boolean;
  createdAt: string;
  versions: MockVersion[];
  /** WEB-ONLY placeholder [BE-04c]. */
  aiRefs: Schemas['AiReference'][];
}

/** The shape the seed data below is written in; `convert` turns it into the API shape. */
interface SeedContent {
  title: string;
  statementMd: string;
  difficulty: Schemas['Difficulty'];
  tags: string[];
  allowedLanguages: Language[];
  limits: Schemas['Limits'];
  starterCode: Record<string, string>;
  referenceSolution: Record<string, string>;
  testCases: {
    id: string;
    input: string;
    expectedOutput: string;
    isHidden: boolean;
    weight: number;
  }[];
  variants: Variant[];
  answerSpec:
    | ({ type: 'MCQ' } & Schemas['McqAnswerSpec'])
    | ({ type: 'SHORT_ANSWER' } & Schemas['ShortAnswerSpec'])
    | null;
}
type Content = SeedContent;
interface SeedVersion extends SeedContent {
  version: number;
  isPublished: boolean;
  createdAt: string;
  createdByName: string;
  validatedAt: string | null;
  validationReport: { passed: boolean; finishedAt: string; results: [] } | null;
}
interface SeedQuestion {
  id: string;
  slug: string;
  type: Schemas['QuestionType'];
  archived: boolean;
  versions: SeedVersion[];
  aiRefs: Schemas['AiReference'][];
}

const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const LIMITS = { cpuMs: 2000, wallMs: 5000, memoryKb: 262_144 };

function passing(): { passed: true; finishedAt: string; results: [] } {
  return { passed: true, finishedAt: daysAgo(2), results: [] };
}

export function seedQuestions(): MockQuestion[] {
  const mergeBase: Content = {
    title: 'Merge intervals',
    statementMd: `Given **{{count}}** intervals, merge all overlapping ones and print the result.

Intervals that only touch (for example \`[1,3]\` and \`[3,5]\`) **do** overlap.

### Input
The first line is the number of intervals. Each next line holds \`start end\`.

### Output
The merged intervals, one per line, sorted by start.

\`\`\`
3
1 3
2 6
8 10
\`\`\`
prints
\`\`\`
1 6
8 10
\`\`\``,
    difficulty: 'MEDIUM',
    tags: ['arrays', 'sorting'],
    allowedLanguages: ['python', 'javascript', 'java'],
    limits: LIMITS,
    starterCode: {
      python:
        'import sys\n\n\ndef main():\n    data = sys.stdin.read().split()\n    # {{count}} intervals follow\n\n\nmain()\n',
      javascript:
        "const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');\n// {{count}} intervals follow\n",
      java: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        // {{count}} intervals follow\n    }\n}\n',
    },
    referenceSolution: {
      python:
        'import sys\n\ndata = sys.stdin.read().split()\nn = int(data[0])\niv = sorted((int(data[1 + 2 * i]), int(data[2 + 2 * i])) for i in range(n))\nout = []\nfor s, e in iv:\n    if out and s <= out[-1][1]:\n        out[-1][1] = max(out[-1][1], e)\n    else:\n        out.append([s, e])\nfor s, e in out:\n    print(s, e)\n',
      javascript:
        "const t = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconst n = t[0];\nconst iv = [];\nfor (let i = 0; i < n; i++) iv.push([t[1 + 2 * i], t[2 + 2 * i]]);\niv.sort((a, b) => a[0] - b[0]);\nconst out = [];\nfor (const [s, e] of iv) {\n  if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);\n  else out.push([s, e]);\n}\nfor (const [s, e] of out) console.log(s + ' ' + e);\n",
      java: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        int n = in.nextInt();\n        int[][] iv = new int[n][2];\n        for (int i = 0; i < n; i++) { iv[i][0] = in.nextInt(); iv[i][1] = in.nextInt(); }\n        Arrays.sort(iv, (a, b) -> a[0] - b[0]);\n        int[] cur = iv[0];\n        for (int i = 1; i < n; i++) {\n            if (iv[i][0] <= cur[1]) cur[1] = Math.max(cur[1], iv[i][1]);\n            else { System.out.println(cur[0] + " " + cur[1]); cur = iv[i]; }\n        }\n        System.out.println(cur[0] + " " + cur[1]);\n    }\n}\n',
    },
    testCases: [
      {
        id: 'mi-t1',
        input: '3\n1 3\n2 6\n8 10',
        expectedOutput: '1 6\n8 10',
        isHidden: false,
        weight: 1,
      },
      { id: 'mi-t2', input: '2\n1 4\n4 5', expectedOutput: '1 5', isHidden: false, weight: 1 },
      {
        id: 'mi-t3',
        input: '4\n1 2\n3 4\n5 6\n7 8',
        expectedOutput: '1 2\n3 4\n5 6\n7 8',
        isHidden: true,
        weight: 2,
      },
      {
        id: 'mi-t4',
        input: '3\n5 9\n1 3\n2 4',
        expectedOutput: '1 4\n5 9',
        isHidden: true,
        weight: 2,
      },
    ],
    variants: [
      { id: 'mi-v1', label: 'Three intervals', params: { count: 3 }, active: true, overrides: [] },
      {
        id: 'mi-v2',
        label: 'Four intervals',
        params: { count: 4 },
        active: true,
        overrides: [
          {
            testCaseId: 'mi-t1',
            input: '4\n1 3\n2 6\n8 10\n15 18',
            expectedOutput: '1 6\n8 10\n15 18',
          },
        ],
      },
    ],
    answerSpec: null,
  };

  const twoSum: Content = {
    title: 'Two sum',
    statementMd:
      'Read `n` and a list of `n` integers, then a target. Print the **indices** (0-based, ascending) of the two numbers that add up to the target. Exactly one pair exists.',
    difficulty: 'EASY',
    tags: ['arrays', 'hash-map'],
    allowedLanguages: ['python', 'javascript'],
    limits: LIMITS,
    starterCode: {
      python: 'n = int(input())\nnums = list(map(int, input().split()))\ntarget = int(input())\n',
      javascript: '',
    },
    referenceSolution: {
      python:
        'n = int(input())\nnums = list(map(int, input().split()))\ntarget = int(input())\nseen = {}\nfor i, x in enumerate(nums):\n    if target - x in seen:\n        print(seen[target - x], i)\n        break\n    seen[x] = i\n',
      javascript:
        "const [n, a, t] = require('fs').readFileSync(0, 'utf8').trim().split('\\n');\nconst nums = a.split(' ').map(Number);\nconst seen = new Map();\nfor (let i = 0; i < nums.length; i++) {\n  if (seen.has(Number(t) - nums[i])) { console.log(seen.get(Number(t) - nums[i]) + ' ' + i); break; }\n  seen.set(nums[i], i);\n}\n",
    },
    testCases: [
      { id: 'ts-t1', input: '4\n2 7 11 15\n9', expectedOutput: '0 1', isHidden: false, weight: 1 },
      { id: 'ts-t2', input: '3\n3 2 4\n6', expectedOutput: '1 2', isHidden: true, weight: 1 },
    ],
    variants: [],
    answerSpec: null,
  };

  const rotate: Content = {
    title: 'Rotate an array',
    statementMd:
      'Rotate the array of **{{size}}** numbers to the right by **{{steps}}** places and print it.',
    difficulty: 'MEDIUM',
    tags: ['arrays'],
    allowedLanguages: ['python'],
    limits: LIMITS,
    starterCode: { python: '# rotate {{size}} numbers by {{steps}}\n' },
    referenceSolution: {
      python:
        'a = list(map(int, input().split()))\nk = {{steps}} % len(a)\nprint(*(a[-k:] + a[:-k]))\n',
    },
    testCases: [
      { id: 'ro-t1', input: '1 2 3 4 5', expectedOutput: '4 5 1 2 3', isHidden: false, weight: 1 },
      {
        id: 'ro-t2',
        input: '1 2 3 4 5 6',
        expectedOutput: '5 6 1 2 3 4',
        isHidden: true,
        weight: 1,
      },
    ],
    variants: [
      {
        id: 'ro-v1',
        label: 'Rotate by 2',
        params: { size: 5, steps: 2 },
        active: true,
        overrides: [],
      },
      {
        id: 'ro-v2',
        label: 'Rotate by 3',
        params: { size: 6, steps: 3 },
        active: true,
        // The author has not filled the expected output yet: this variant fails validation (TC-012).
        overrides: [{ testCaseId: 'ro-t2', input: '1 2 3 4 5 6', expectedOutput: 'TODO' }],
      },
    ],
    answerSpec: null,
  };

  const running: Content = {
    title: 'Running average',
    statementMd:
      'Print the running average of the numbers on the input, rounded to 2 decimals, one per line.',
    difficulty: 'EASY',
    tags: ['math', 'loops'],
    allowedLanguages: ['python', 'javascript'],
    limits: LIMITS,
    starterCode: { python: '', javascript: '' },
    referenceSolution: {
      python:
        'total = 0\nfor i, x in enumerate(map(float, input().split()), 1):\n    total += x\n    print(f"{total / i:.2f}")\n',
      javascript:
        "const xs = require('fs').readFileSync(0, 'utf8').trim().split(' ').map(Number);\nlet t = 0;\nxs.forEach((x, i) => { t += x; console.log((t / (i + 1)).toFixed(2)); });\n",
    },
    testCases: [
      {
        id: 'ra-t1',
        input: '1 2 3',
        expectedOutput: '1.00\n1.50\n2.00',
        isHidden: false,
        weight: 1,
      },
      { id: 'ra-t2', input: '10 20', expectedOutput: '10.00\n15.00', isHidden: true, weight: 1 },
    ],
    variants: [],
    answerSpec: null,
  };

  const bigO: Content = {
    title: 'Cost of binary search',
    statementMd:
      'What is the worst-case time complexity of binary search on a sorted array of `n` items?',
    difficulty: 'EASY',
    tags: ['complexity'],
    allowedLanguages: [],
    limits: LIMITS,
    starterCode: {},
    referenceSolution: {},
    testCases: [],
    variants: [],
    answerSpec: {
      type: 'MCQ',
      multiple: false,
      options: [
        { id: 'o1', text: 'O(1)' },
        { id: 'o2', text: 'O(log n)' },
        { id: 'o3', text: 'O(n)' },
        { id: 'o4', text: 'O(n log n)' },
      ],
      correctOptionIds: ['o2'],
    },
  };

  const http: Content = {
    title: 'Status code for a created resource',
    statementMd:
      'Which HTTP status code does a server normally return after it **created** a new resource? Answer with the number.',
    difficulty: 'EASY',
    tags: ['http', 'web'],
    allowedLanguages: [],
    limits: LIMITS,
    starterCode: {},
    referenceSolution: {},
    testCases: [],
    variants: [],
    answerSpec: {
      type: 'SHORT_ANSWER',
      canonical: '201',
      acceptedVariants: ['201 created', 'http 201'],
    },
  };

  const old: Content = {
    ...twoSum,
    title: 'Legacy tokenizer (archived)',
    statementMd: 'Retired question kept for past sessions.',
    tags: ['strings'],
  };

  const ver = (
    c: Content,
    version: number,
    o: Partial<SeedVersion> & { by?: string } = {},
  ): SeedVersion => ({
    ...structuredClone(c),
    version,
    isPublished: false,
    createdAt: daysAgo(30 - version),
    createdByName: o.by ?? 'Avery Author',
    validatedAt: null,
    validationReport: null,
    ...o,
  });

  const ref = (
    id: string,
    language: Schemas['AiReference']['language'],
    assistant: string,
    modelLabel: string,
    ageDays: number,
    code: string,
  ): Schemas['AiReference'] => ({
    id,
    assistant,
    modelLabel,
    language,
    solutionCode: code,
    promptText: 'Solve the question as stated. Return only code.',
    collectedAt: daysAgo(ageDays),
    variantId: null,
    collectedByName: 'Avery Author',
    supersededAt: null,
  });

  const legacy: SeedQuestion[] = [
    {
      id: 'q-merge',
      slug: 'merge-intervals',
      type: 'CODING',
      archived: false,
      versions: [
        ver(
          {
            ...mergeBase,
            statementMd: mergeBase.statementMd.replace('{{count}}', 'some'),
            variants: [],
          },
          1,
          {
            isPublished: true,
            validatedAt: daysAgo(28),
            validationReport: passing(),
          },
        ),
        ver(mergeBase, 2, {
          isPublished: true,
          validatedAt: daysAgo(10),
          validationReport: passing(),
        }),
      ],
      aiRefs: [
        ref(
          'ai-1',
          'python',
          'ChatGPT',
          'gpt-5 (business)',
          120,
          'print("python from assistant one")',
        ),
        ref('ai-2', 'python', 'Claude', 'sonnet (team)', 120, 'print("python from assistant two")'),
        ref('ai-3', 'javascript', 'ChatGPT', 'gpt-5 (business)', 120, 'console.log("js one")'),
        ref('ai-4', 'javascript', 'Claude', 'sonnet (team)', 120, 'console.log("js two")'),
        ref('ai-5', 'java', 'ChatGPT', 'gpt-5 (business)', 120, '// java one'),
        ref('ai-6', 'java', 'Claude', 'sonnet (team)', 120, '// java two'),
      ],
    },
    {
      id: 'q-twosum',
      slug: 'two-sum',
      type: 'CODING',
      archived: false,
      versions: [
        ver(twoSum, 1, {
          isPublished: true,
          validatedAt: daysAgo(40),
          validationReport: passing(),
        }),
      ],
      aiRefs: [],
    },
    {
      id: 'q-rotate',
      slug: 'rotate-an-array',
      type: 'CODING',
      archived: false,
      versions: [ver(rotate, 1)],
      aiRefs: [],
    },
    {
      id: 'q-running',
      slug: 'running-average',
      type: 'CODING',
      archived: false,
      versions: [ver(running, 1, { validatedAt: daysAgo(1), validationReport: passing() })],
      aiRefs: [
        ref('ai-r1', 'python', 'ChatGPT', 'gpt-5 (business)', 1, 'print("python one")'),
        ref('ai-r2', 'javascript', 'ChatGPT', 'gpt-5 (business)', 1, 'console.log("js one")'),
      ],
    },
    {
      id: 'q-bigo',
      slug: 'cost-of-binary-search',
      type: 'MCQ',
      archived: false,
      versions: [
        ver(bigO, 1, { isPublished: true, validatedAt: daysAgo(15), validationReport: passing() }),
      ],
      aiRefs: [],
    },
    {
      // A complete multiple-choice draft: the real API publishes it (coding questions fail closed).
      id: 'q-mcq-draft',
      slug: 'hash-lookup-cost',
      type: 'MCQ',
      archived: false,
      versions: [
        ver(
          {
            ...bigO,
            answerSpec: {
              type: 'MCQ',
              multiple: false,
              options: [
                { id: 'o1', text: 'O(1)' },
                { id: 'o2', text: 'O(log n)' },
                { id: 'o3', text: 'O(n)' },
              ],
              correctOptionIds: ['o1'],
            },
            title: 'Cost of a hash lookup (draft)',
            statementMd: 'What is the average-case time complexity of a lookup in a hash table?',
          },
          1,
          { validatedAt: daysAgo(1), validationReport: passing() },
        ),
      ],
      aiRefs: [],
    },
    {
      id: 'q-http',
      slug: 'status-code-created',
      type: 'SHORT_ANSWER',
      archived: false,
      versions: [ver(http, 1)],
      aiRefs: [],
    },
    {
      id: 'q-old',
      slug: 'legacy-tokenizer',
      type: 'CODING',
      archived: true,
      versions: [
        ver(old, 1, { isPublished: true, validatedAt: daysAgo(200), validationReport: passing() }),
      ],
      aiRefs: [],
    },
  ];
  return legacy.map(convert);
}

/** Seed shape to the API shape: positions, ids, an answer spec without `type`, a revision-bound report. */
function convert(q: SeedQuestion): MockQuestion {
  const last = q.versions[q.versions.length - 1]!;
  const versions = q.versions.map((v): MockVersion => {
    const base = {
      id: `${q.id}-v${v.version}`,
      version: v.version,
      isPublished: v.isPublished,
      title: v.title,
      difficulty: v.difficulty,
      validatedAt: v.validatedAt,
      createdAt: v.createdAt,
      createdByName: v.createdByName,
      statementMd: v.statementMd,
      allowedLanguages: v.allowedLanguages,
      limits: v.limits,
      starterCode: v.starterCode,
      referenceSolution: v.referenceSolution,
      answerSpec: ((): AnswerSpec | null => {
        const a = v.answerSpec;
        if (!a) return null;
        if (a.type === 'MCQ') {
          return { options: a.options, correctOptionIds: a.correctOptionIds, multiple: a.multiple };
        }
        return { canonical: a.canonical, acceptedVariants: a.acceptedVariants };
      })(),
      testCases: v.testCases.map((t, position) => ({ ...t, position })),
      variants: v.variants,
    };
    const report = v.validationReport
      ? { ...v.validationReport, revision: mockRevision(base) }
      : null;
    return { ...base, validationReport: report };
  });
  return {
    id: q.id,
    slug: q.slug,
    type: q.type,
    tags: last.tags,
    isArchived: q.archived,
    createdAt: daysAgo(40),
    versions,
    aiRefs: q.aiRefs,
  };
}
