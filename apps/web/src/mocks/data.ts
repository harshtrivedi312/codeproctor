import type { Schemas } from '@/lib/api/client';

// Fake data for the /t/demo/test preview. Nothing here comes from the real API.

const intervalsStatement = `## Merge overlapping intervals

You are given a list of **meeting time ranges**. Merge every group of ranges that overlap and print the
result.

### Input

- The first line contains an integer \`n\` (1 ≤ n ≤ 10 000).
- Each of the next \`n\` lines contains two integers \`start end\` with \`start < end\`.

### Output

Print the merged ranges in ascending order, one per line, as \`start end\`.
Ranges that only **touch** (for example \`1 3\` and \`3 5\`) count as overlapping and must be merged.

### Examples

**Example 1**

\`\`\`text
3
1 3
2 6
8 10
\`\`\`

Output:

\`\`\`text
1 6
8 10
\`\`\`

**Example 2 (touching ranges)**

\`\`\`text
2
1 3
3 5
\`\`\`

Output:

\`\`\`text
1 5
\`\`\`

### Notes

- Your code runs with a time limit of 2 seconds per test.
- The visible sample tests are only a part of the checks. Hidden tests are run when you submit.
`;

const wordsStatement = `## Most frequent words

Read a block of text from standard input and print the **3 most frequent words**, lower-cased.

- Words are made of letters only; ignore punctuation and case.
- If two words have the same count, print the one that comes first alphabetically.
- Print one word per line.

**Example**

\`\`\`text
the cat and the hat and the bat
\`\`\`

Output:

\`\`\`text
the
and
bat
\`\`\`
`;

const mcqStatement = `## Choose the best answer

A function is called with the same input many times and always needs the same result, but computing it is slow.
Which technique is **most appropriate**?`;

export const mockSession: Omit<Schemas['CandidateSession'], 'testDeadlineAt'> & {
  testDurationMs: number;
  sectionDurationMs: number;
} = {
  testTitle: 'Backend Engineer Screening (demo)',
  testDurationMs: 60 * 60 * 1000,
  sectionDurationMs: 25 * 60 * 1000,
  section: {
    id: 'sec-1',
    position: 1,
    totalSections: 2,
    title: 'Coding',
    deadlineAt: null,
  },
  questions: [
    {
      id: 'q-intervals',
      type: 'coding',
      title: 'Merge overlapping intervals',
      points: 40,
      statementMarkdown: intervalsStatement,
      languages: ['python', 'javascript', 'java'],
      starterCode: {
        python: `import sys


def merge(ranges):
    # TODO: return the merged list of (start, end) pairs
    return ranges


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    ranges = [(int(data[1 + 2 * i]), int(data[2 + 2 * i])) for i in range(n)]
    for start, end in merge(ranges):
        print(start, end)


main()
`,
        javascript: `const lines = require('fs').readFileSync(0, 'utf8').trim().split('\\n');
const n = parseInt(lines[0], 10);
const ranges = lines.slice(1, 1 + n).map((line) => line.split(' ').map(Number));

function merge(ranges) {
  // TODO: return the merged array of [start, end] pairs
  return ranges;
}

for (const [start, end] of merge(ranges)) {
  console.log(start + ' ' + end);
}
`,
        java: `import java.util.*;

public class Main {
    static List<int[]> merge(List<int[]> ranges) {
        // TODO: return the merged list of {start, end} pairs
        return ranges;
    }

    public static void main(String[] args) {
        Scanner in = new Scanner(System.in);
        int n = in.nextInt();
        List<int[]> ranges = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            ranges.add(new int[] {in.nextInt(), in.nextInt()});
        }
        for (int[] r : merge(ranges)) {
            System.out.println(r[0] + " " + r[1]);
        }
    }
}
`,
      },
      sampleTests: [
        {
          id: 'st-1',
          name: 'Sample 1: overlapping and separate',
          input: '3\n1 3\n2 6\n8 10',
          expectedOutput: '1 6\n8 10',
        },
        {
          id: 'st-2',
          name: 'Sample 2: unsorted input',
          input: '3\n8 10\n1 2\n2 4',
          expectedOutput: '1 4\n8 10',
        },
        {
          id: 'st-3',
          name: 'Sample 3: touching ranges',
          input: '2\n1 3\n3 5',
          expectedOutput: '1 5',
        },
      ],
    },
    {
      id: 'q-words',
      type: 'coding',
      title: 'Most frequent words',
      points: 30,
      statementMarkdown: wordsStatement,
      languages: ['python', 'javascript', 'java'],
      starterCode: {
        python:
          '# Read stdin, print the 3 most frequent words\nimport sys\n\ntext = sys.stdin.read()\n',
        javascript:
          "// Read stdin, print the 3 most frequent words\nconst text = require('fs').readFileSync(0, 'utf8');\n",
        java: 'import java.util.*;\n\npublic class Main {\n    public static void main(String[] args) {\n        // Read stdin, print the 3 most frequent words\n    }\n}\n',
      },
      sampleTests: [
        {
          id: 'st-1',
          name: 'Sample 1',
          input: 'the cat and the hat and the bat',
          expectedOutput: 'the\nand\nbat',
        },
      ],
    },
    {
      id: 'q-mcq',
      type: 'mcq',
      title: 'Caching a slow pure function',
      points: 10,
      statementMarkdown: mcqStatement,
      options: [
        { id: 'a', label: 'Memoization' },
        { id: 'b', label: 'Recursion' },
        { id: 'c', label: 'Lazy loading of the module' },
        { id: 'd', label: 'Increasing the thread pool size' },
      ],
    },
  ],
};
