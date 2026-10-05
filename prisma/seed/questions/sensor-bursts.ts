// EASY, strings. Original problem: count maximal runs of one repeated reading in a sensor log.
// Params change the minimum run length, so the expected output differs per variant.
import { mulberry32, randomInts } from '../rng';
import {
  type CodingQuestionSpec,
  type Params,
  SYNTHETIC_CODE_NOTE,
  hiddenSlots,
  sampleSlot,
} from '../types';

function solve(params: Params, input: string): string {
  const minRun = Number(params.minRun);
  const text = input.split('\n')[0] ?? '';
  let count = 0;
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && text[j] === text[i]) j++;
    if (j - i >= minRun) count++;
    i = j;
  }
  return String(count);
}

const EXAMPLE_INPUT = 'aaabccccdd\n';

function params(noun: string, minRun: number): Params {
  return { noun, minRun, exampleCount: solve({ minRun }, EXAMPLE_INPUT) };
}

/** Runs of letters a, b, c, ... with the given lengths, repeated until `length` characters. */
function cycledRuns(runLengths: readonly number[], length: number): string {
  const letters = 'abcdefghij';
  let text = '';
  let step = 0;
  while (text.length < length) {
    const run = runLengths[step % runLengths.length] as number;
    text += letters[step % letters.length]?.repeat(run) ?? '';
    step++;
  }
  return `${text.slice(0, length)}\n`;
}

function randomLetters(seed: number, length: number, alphabet: number): string {
  const codes = randomInts(mulberry32(seed), length, 0, alphabet - 1);
  return `${codes.map((code) => String.fromCharCode(97 + code)).join('')}\n`;
}

const statementTemplate = `# Sensor {{noun}} Count

A sensor reports one lowercase letter per reading. A **{{noun}}** is a maximal run of identical letters that is at least {{minRun}} readings long. Maximal means the run cannot be extended to the left or to the right.

For example, the log \`aaabccccdd\` contains the runs \`aaa\`, \`b\`, \`cccc\` and \`dd\`, which gives {{exampleCount}} {{noun}}(s).

Count the {{noun}}s in a log.

## Input

One line with the log \`S\`.

## Output

One integer: the number of {{noun}}s.

## Constraints

- 1 <= |S| <= 200000
- \`S\` has only lowercase letters a to z.
`;

const starterTemplates = {
  python: String.raw`import sys


def main():
    s = sys.stdin.readline().strip()
    # A {{noun}} is a maximal run of at least {{minRun}} identical letters.
    count = 0
    # TODO: count the {{noun}}s in s.
    print(count)


main()
`,
  javascript: String.raw`const s = require('fs').readFileSync(0, 'utf8').split('\n')[0].trim();
// A {{noun}} is a maximal run of at least {{minRun}} identical letters.
let count = 0;
// TODO: count the {{noun}}s in s.
console.log(String(count));
`,
  java: String.raw`import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        String s = reader.readLine().trim();
        // A {{noun}} is a maximal run of at least {{minRun}} identical letters.
        int count = 0;
        // TODO: count the {{noun}}s in s.
        System.out.println(count);
    }
}
`,
} as const;

const referenceTemplates = {
  python: String.raw`import sys


def main():
    s = sys.stdin.readline().strip()
    count = 0
    i = 0
    while i < len(s):
        j = i
        while j < len(s) and s[j] == s[i]:
            j += 1
        if j - i >= {{minRun}}:
            count += 1
        i = j
    print(count)


main()
`,
  javascript: String.raw`const s = require('fs').readFileSync(0, 'utf8').split('\n')[0].trim();
let count = 0;
let i = 0;
while (i < s.length) {
  let j = i;
  while (j < s.length && s[j] === s[i]) {
    j++;
  }
  if (j - i >= {{minRun}}) {
    count++;
  }
  i = j;
}
console.log(String(count));
`,
  java: String.raw`import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        String s = reader.readLine().trim();
        int count = 0;
        int i = 0;
        while (i < s.length()) {
            int j = i;
            while (j < s.length() && s.charAt(j) == s.charAt(i)) {
                j++;
            }
            if (j - i >= {{minRun}}) {
                count++;
            }
            i = j;
        }
        System.out.println(count);
    }
}
`,
} as const;

const aiSolutions = {
  assistantA: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys
from itertools import groupby

s = sys.stdin.readline().strip()
print(sum(1 for _, group in groupby(s) if len(list(group)) >= 3))
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const s = require('fs').readFileSync(0, 'utf8').split('\n')[0].trim();
const runs = s.match(/(.)\1*/g) || [];
console.log(runs.filter((run) => run.length >= 3).length);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        String s = sc.next();
        int count = 0;
        int run = 1;
        for (int i = 1; i <= s.length(); i++) {
            if (i < s.length() && s.charAt(i) == s.charAt(i - 1)) {
                run++;
            } else {
                if (run >= 3) count++;
                run = 1;
            }
        }
        System.out.println(count);
    }
}
`,
  },
  assistantB: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys


def count_bursts(s, min_run=3):
    if not s:
        return 0
    bursts = 0
    run_length = 1
    for prev, cur in zip(s, s[1:]):
        if cur == prev:
            run_length += 1
        else:
            if run_length >= min_run:
                bursts += 1
            run_length = 1
    if run_length >= min_run:
        bursts += 1
    return bursts


print(count_bursts(sys.stdin.readline().strip()))
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const input = require('fs').readFileSync(0, 'utf8').split('\n')[0].trim();
let bursts = 0;
let start = 0;
for (let i = 1; i <= input.length; i++) {
  if (i === input.length || input[i] !== input[start]) {
    if (i - start >= 3) bursts += 1;
    start = i;
  }
}
console.log(bursts);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        String s = new BufferedReader(new InputStreamReader(System.in)).readLine().trim();
        int bursts = 0;
        int start = 0;
        for (int i = 1; i <= s.length(); i++) {
            if (i == s.length() || s.charAt(i) != s.charAt(start)) {
                if (i - start >= 3) {
                    bursts++;
                }
                start = i;
            }
        }
        System.out.println(bursts);
    }
}
`,
  },
} as const;

export const sensorBursts: CodingQuestionSpec = {
  slug: 'sensor-bursts',
  title: 'Sensor Burst Count',
  difficulty: 'EASY',
  tags: ['strings', 'simulation'],
  statementTemplate,
  starterTemplates,
  referenceTemplates,
  slots: [
    sampleSlot(EXAMPLE_INPUT),
    sampleSlot('abcabc\n'),
    sampleSlot('zzzzzzzz\n'),
    ...hiddenSlots([
      'a\n',
      'aabbccdd\n',
      'aaabbbcccdddeee\n',
      'abababababab\n',
      'xxxxyyyyxxxxyyyy\n',
      'ppqqqrrrrsssss\n',
      cycledRuns([1, 2, 3, 4, 5, 6], 200000),
      randomLetters(1201, 100000, 3),
    ]),
  ],
  variants: [
    { params: params('burst', 3) },
    { params: params('streak', 2), inputOverrides: { 7: 'xxyyxxyyxxyyxx\n' } },
    { params: params('cluster', 4), inputOverrides: { 10: randomLetters(1221, 150000, 2) } },
  ],
  solve,
  aiSolutions,
};
