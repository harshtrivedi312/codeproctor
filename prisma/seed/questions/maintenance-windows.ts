// MEDIUM, arrays, intervals and dynamic programming. Original problem: pick the most valuable
// maintenance windows when chosen windows must be a minimum gap apart.
// Params change the gap and the name of the thing scheduled.
import { mulberry32, randomInt, tokens } from '../rng';
import {
  type CodingQuestionSpec,
  type Params,
  SYNTHETIC_CODE_NOTE,
  hiddenSlots,
  sampleSlot,
} from '../types';

function solve(params: Params, input: string): string {
  const gap = Number(params.gap);
  const values = tokens(input).map(Number);
  const n = values[0] as number;
  const items: { start: number; end: number; value: number }[] = [];
  for (let i = 0; i < n; i++) {
    items.push({
      start: values[1 + 3 * i] as number,
      end: values[2 + 3 * i] as number,
      value: values[3 + 3 * i] as number,
    });
  }
  // Independent of the reference solution: sort by start and take the best chain that ends at
  // each item, checking every earlier item (O(n^2)).
  items.sort((a, b) => a.start - b.start || a.end - b.end);
  const bestEndingHere: number[] = [];
  let best = 0;
  for (let i = 0; i < n; i++) {
    const item = items[i] as { start: number; end: number; value: number };
    let chain = 0;
    for (let j = 0; j < i; j++) {
      const earlier = items[j] as { start: number; end: number; value: number };
      if (earlier.end + gap <= item.start) chain = Math.max(chain, bestEndingHere[j] as number);
    }
    bestEndingHere.push(chain + item.value);
    best = Math.max(best, chain + item.value);
  }
  return String(best);
}

function windowsInput(rows: readonly (readonly [number, number, number])[]): string {
  return `${rows.length}\n${rows.map((row) => row.join(' ')).join('\n')}\n`;
}

function randomWindows(seed: number, n: number, horizon: number): string {
  const random = mulberry32(seed);
  const rows: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const start = randomInt(random, 0, horizon - 2);
    const end = start + randomInt(random, 1, Math.max(1, Math.floor(horizon / 40)));
    rows.push([start, end, randomInt(random, 1, 1000)]);
  }
  return windowsInput(rows);
}

const EXAMPLE_INPUT = '3\n1 4 5\n3 6 6\n6 9 4\n';

function params(thing: string, gap: number): Params {
  return { thing, gap, exampleAnswer: solve({ gap }, EXAMPLE_INPUT) };
}

const statementTemplate = `# Maintenance Windows

A data centre can schedule maintenance {{thing}}s. Each {{thing}} starts at time \`s\`, ends at time \`e\` and is worth \`v\` points. The end is exclusive, so a {{thing}} occupies the times from \`s\` up to but not including \`e\`.

Two chosen {{thing}}s must be at least {{gap}} time units apart: if one ends at time \`t\`, the next one may start at \`t + {{gap}}\` or later. The {{thing}}s can be listed in any order, and a {{thing}} cannot be split.

Choose a set of {{thing}}s that respects this rule and has the largest total value.

For the three {{thing}}s \`1 4 5\`, \`3 6 6\` and \`6 9 4\` the answer is {{exampleAnswer}}.

## Input

- Line 1: an integer \`N\`.
- Next \`N\` lines: three integers \`s e v\`.

## Output

One integer: the largest total value.

## Constraints

- 1 <= N <= 100000
- 0 <= s < e <= 1000000000
- 1 <= v <= 1000000000
- The answer can be larger than 32 bits.
`;

const starterTemplates = {
  python: String.raw`import sys


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    windows = []
    for i in range(n):
        s = int(data[1 + 3 * i])
        e = int(data[2 + 3 * i])
        v = int(data[3 + 3 * i])
        windows.append((s, e, v))
    # Chosen {{thing}}s must be at least {{gap}} time units apart.
    best = 0
    # TODO: find the largest total value.
    print(best)


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
const windows = [];
for (let i = 0; i < n; i++) {
  windows.push({ s: data[1 + 3 * i], e: data[2 + 3 * i], v: data[3 + 3 * i] });
}
// Chosen {{thing}}s must be at least {{gap}} time units apart.
let best = 0;
// TODO: find the largest total value.
console.log(String(best));
`,
  java: String.raw`import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        long[][] windows = new long[n][3];
        for (int i = 0; i < n; i++) {
            for (int k = 0; k < 3; k++) {
                in.nextToken();
                windows[i][k] = (long) in.nval;
            }
        }
        // Chosen {{thing}}s must be at least {{gap}} time units apart.
        long best = 0;
        // TODO: find the largest total value.
        System.out.println(best);
    }
}
`,
} as const;

const referenceTemplates = {
  python: String.raw`import sys
from bisect import bisect_right


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    windows = []
    for i in range(n):
        s = int(data[1 + 3 * i])
        e = int(data[2 + 3 * i])
        v = int(data[3 + 3 * i])
        windows.append((e, s, v))
    windows.sort()
    ends = [w[0] for w in windows]
    best = [0] * (n + 1)
    for i in range(n):
        e, s, v = windows[i]
        k = bisect_right(ends, s - {{gap}}, 0, i)
        best[i + 1] = max(best[i], best[k] + v)
    print(best[n])


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
const windows = [];
for (let i = 0; i < n; i++) {
  windows.push([data[2 + 3 * i], data[1 + 3 * i], data[3 + 3 * i]]);
}
windows.sort((a, b) => a[0] - b[0]);
const best = new Array(n + 1).fill(0);
for (let i = 0; i < n; i++) {
  const start = windows[i][1];
  const value = windows[i][2];
  let lo = 0;
  let hi = i;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (windows[mid][0] <= start - {{gap}}) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  best[i + 1] = Math.max(best[i], best[lo] + value);
}
console.log(String(best[n]));
`,
  java: String.raw`import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        long[][] windows = new long[n][3];
        for (int i = 0; i < n; i++) {
            in.nextToken();
            long s = (long) in.nval;
            in.nextToken();
            long e = (long) in.nval;
            in.nextToken();
            long v = (long) in.nval;
            windows[i][0] = e;
            windows[i][1] = s;
            windows[i][2] = v;
        }
        Arrays.sort(windows, (a, b) -> Long.compare(a[0], b[0]));
        long[] best = new long[n + 1];
        for (int i = 0; i < n; i++) {
            long start = windows[i][1];
            int lo = 0;
            int hi = i;
            while (lo < hi) {
                int mid = (lo + hi) >>> 1;
                if (windows[mid][0] <= start - {{gap}}) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            best[i + 1] = Math.max(best[i], best[lo] + windows[i][2]);
        }
        System.out.println(best[n]);
    }
}
`,
} as const;

const aiSolutions = {
  assistantA: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys

GAP = 2

data = sys.stdin.read().split()
n = int(data[0])
items = sorted(
    (int(data[1 + 3 * i]), int(data[2 + 3 * i]), int(data[3 + 3 * i])) for i in range(n)
)
chain = [0] * n
for i, (s, e, v) in enumerate(items):
    best_before = 0
    for j in range(i):
        if items[j][1] + GAP <= s and chain[j] > best_before:
            best_before = chain[j]
    chain[i] = best_before + v
print(max(chain))
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const nums = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(Number);
const GAP = 2;
const n = nums[0];
const items = [];
for (let i = 0; i < n; i++) {
  items.push({ s: nums[1 + 3 * i], e: nums[2 + 3 * i], v: nums[3 + 3 * i] });
}
items.sort((a, b) => a.s - b.s || a.e - b.e);
const chain = new Array(n).fill(0);
let answer = 0;
for (let i = 0; i < n; i++) {
  let bestBefore = 0;
  for (let j = 0; j < i; j++) {
    if (items[j].e + GAP <= items[i].s && chain[j] > bestBefore) bestBefore = chain[j];
  }
  chain[i] = bestBefore + items[i].v;
  answer = Math.max(answer, chain[i]);
}
console.log(answer);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        final long GAP = 2;
        int n = sc.nextInt();
        long[][] items = new long[n][3];
        for (int i = 0; i < n; i++) {
            items[i][0] = sc.nextLong();
            items[i][1] = sc.nextLong();
            items[i][2] = sc.nextLong();
        }
        Arrays.sort(items, (a, b) -> a[0] != b[0] ? Long.compare(a[0], b[0]) : Long.compare(a[1], b[1]));
        long[] chain = new long[n];
        long answer = 0;
        for (int i = 0; i < n; i++) {
            long bestBefore = 0;
            for (int j = 0; j < i; j++) {
                if (items[j][1] + GAP <= items[i][0] && chain[j] > bestBefore) {
                    bestBefore = chain[j];
                }
            }
            chain[i] = bestBefore + items[i][2];
            answer = Math.max(answer, chain[i]);
        }
        System.out.println(answer);
    }
}
`,
  },
  assistantB: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import bisect
import sys


def solve(windows, gap):
    windows.sort(key=lambda w: w[1])
    end_times = [w[1] for w in windows]
    dp = [0]
    for idx, (start, end, value) in enumerate(windows):
        compatible = bisect.bisect_right(end_times, start - gap, 0, idx)
        dp.append(max(dp[-1], dp[compatible] + value))
    return dp[-1]


def main():
    tokens = sys.stdin.read().split()
    n = int(tokens[0])
    windows = [tuple(int(x) for x in tokens[1 + 3 * i:4 + 3 * i]) for i in range(n)]
    print(solve(windows, 2))


main()
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const tokens = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(Number);
const GAP = 2;
const n = tokens[0];
const windows = Array.from({ length: n }, (_, i) => ({
  start: tokens[1 + 3 * i],
  end: tokens[2 + 3 * i],
  value: tokens[3 + 3 * i],
}));
windows.sort((a, b) => a.end - b.end);
const dp = [0];
for (let i = 0; i < n; i++) {
  let lo = 0;
  let hi = i;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (windows[mid].end + GAP <= windows[i].start) lo = mid + 1;
    else hi = mid;
  }
  dp.push(Math.max(dp[i], dp[lo] + windows[i].value));
}
console.log(dp[n]);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        int n = Integer.parseInt(reader.readLine().trim());
        long[][] windows = new long[n][];
        for (int i = 0; i < n; i++) {
            StringTokenizer st = new StringTokenizer(reader.readLine());
            long start = Long.parseLong(st.nextToken());
            long end = Long.parseLong(st.nextToken());
            long value = Long.parseLong(st.nextToken());
            windows[i] = new long[] {end, start, value};
        }
        Arrays.sort(windows, Comparator.comparingLong(w -> w[0]));
        final long gap = 2;
        long[] dp = new long[n + 1];
        for (int i = 0; i < n; i++) {
            int lo = 0;
            int hi = i;
            while (lo < hi) {
                int mid = (lo + hi) / 2;
                if (windows[mid][0] + gap <= windows[i][1]) {
                    lo = mid + 1;
                } else {
                    hi = mid;
                }
            }
            dp[i + 1] = Math.max(dp[i], dp[lo] + windows[i][2]);
        }
        System.out.println(dp[n]);
    }
}
`,
  },
} as const;

export const maintenanceWindows: CodingQuestionSpec = {
  slug: 'maintenance-windows',
  title: 'Maintenance Windows',
  difficulty: 'MEDIUM',
  tags: ['arrays', 'intervals', 'dp'],
  statementTemplate,
  starterTemplates,
  referenceTemplates,
  slots: [
    sampleSlot(EXAMPLE_INPUT),
    sampleSlot('1\n0 10 7\n'),
    sampleSlot('4\n0 2 3\n2 4 3\n4 6 3\n1 5 10\n'),
    ...hiddenSlots([
      '2\n0 5 1\n5 10 1\n',
      '2\n0 5 1\n7 10 1\n',
      '5\n0 100 1\n0 10 1\n10 20 1\n20 30 1\n30 40 1\n',
      '6\n1 3 4\n2 5 6\n4 7 5\n6 9 3\n8 10 8\n9 12 2\n',
      windowsInput([
        [0, 1, 1000000000],
        [1, 2, 1000000000],
        [2, 3, 1000000000],
        [3, 4, 1000000000],
        [4, 5, 1000000000],
        [5, 6, 1000000000],
        [6, 7, 1000000000],
      ]),
      randomWindows(1501, 2000, 100000),
      randomWindows(1502, 4000, 1000000),
      '10\n0 5 3\n0 5 9\n0 5 4\n0 5 9\n0 5 1\n0 5 7\n0 5 2\n0 5 8\n0 5 5\n0 5 6\n',
    ]),
  ],
  variants: [
    { params: params('window', 2) },
    { params: params('slot', 0), inputOverrides: { 8: randomWindows(1521, 2500, 100000) } },
    { params: params('booking', 5), inputOverrides: { 3: '2\n0 5 1\n9 12 4\n' } },
  ],
  solve,
  aiSolutions,
};
