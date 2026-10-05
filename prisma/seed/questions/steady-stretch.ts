// MEDIUM, arrays and two pointers. Original problem: the longest run of requests with few slow ones.
// Params change the slow threshold and the number of slow requests allowed.
import { mulberry32, randomInts, tokens } from '../rng';
import {
  type CodingQuestionSpec,
  type Params,
  SYNTHETIC_CODE_NOTE,
  hiddenSlots,
  sampleSlot,
} from '../types';

function solve(params: Params, input: string): string {
  const threshold = Number(params.threshold);
  const maxSlow = Number(params.maxSlow);
  const values = tokens(input).map(Number);
  const n = values[0] as number;
  const times = values.slice(1, 1 + n);
  // Independent of the reference solution's two pointers: try every start, extend while allowed.
  let best = 0;
  for (let start = 0; start < n; start++) {
    let slow = 0;
    let end = start;
    while (end < n) {
      if ((times[end] as number) > threshold) slow++;
      if (slow > maxSlow) break;
      end++;
    }
    best = Math.max(best, end - start);
  }
  return String(best);
}

function listInput(times: readonly number[]): string {
  return `${times.length}\n${times.join(' ')}\n`;
}

const EXAMPLE_INPUT = '8\n120 340 90 80 410 60 70 100\n';

function params(service: string, threshold: number, maxSlow: number): Params {
  return {
    service,
    threshold,
    maxSlow,
    exampleAnswer: solve({ threshold, maxSlow }, EXAMPLE_INPUT),
  };
}

const statementTemplate = `# Steady Stretch

The {{service}} service logs the response time, in milliseconds, of \`N\` consecutive requests. A request is **slow** when its response time is strictly greater than {{threshold}} ms.

Find the length of the longest block of consecutive requests that contains at most {{maxSlow}} slow request(s). A block can be empty, so the answer can be 0.

For the log \`120 340 90 80 410 60 70 100\` the answer is {{exampleAnswer}}.

## Input

- Line 1: an integer \`N\`.
- Line 2: \`N\` integers, the response times in log order.

## Output

One integer: the length of the longest block.

## Constraints

- 1 <= N <= 200000
- 1 <= response time <= 1000000000
`;

const starterTemplates = {
  python: String.raw`import sys


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    times = [int(x) for x in data[1:1 + n]]
    # Slow means more than {{threshold}} ms. At most {{maxSlow}} slow requests per block.
    best = 0
    # TODO: find the longest block with at most {{maxSlow}} slow requests.
    print(best)


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
const times = data.slice(1, 1 + n);
// Slow means more than {{threshold}} ms. At most {{maxSlow}} slow requests per block.
let best = 0;
// TODO: find the longest block with at most {{maxSlow}} slow requests.
console.log(String(best));
`,
  java: String.raw`import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        int[] times = new int[n];
        for (int i = 0; i < n; i++) {
            in.nextToken();
            times[i] = (int) in.nval;
        }
        // Slow means more than {{threshold}} ms. At most {{maxSlow}} slow requests per block.
        int best = 0;
        // TODO: find the longest block with at most {{maxSlow}} slow requests.
        System.out.println(best);
    }
}
`,
} as const;

const referenceTemplates = {
  python: String.raw`import sys


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    times = [int(x) for x in data[1:1 + n]]
    best = 0
    slow = 0
    left = 0
    for right in range(n):
        if times[right] > {{threshold}}:
            slow += 1
        while slow > {{maxSlow}}:
            if times[left] > {{threshold}}:
                slow -= 1
            left += 1
        best = max(best, right - left + 1)
    print(best)


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
const times = data.slice(1, 1 + n);
let best = 0;
let slow = 0;
let left = 0;
for (let right = 0; right < n; right++) {
  if (times[right] > {{threshold}}) {
    slow++;
  }
  while (slow > {{maxSlow}}) {
    if (times[left] > {{threshold}}) {
      slow--;
    }
    left++;
  }
  best = Math.max(best, right - left + 1);
}
console.log(String(best));
`,
  java: String.raw`import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        int[] times = new int[n];
        for (int i = 0; i < n; i++) {
            in.nextToken();
            times[i] = (int) in.nval;
        }
        int best = 0;
        int slow = 0;
        int left = 0;
        for (int right = 0; right < n; right++) {
            if (times[right] > {{threshold}}) {
                slow++;
            }
            while (slow > {{maxSlow}}) {
                if (times[left] > {{threshold}}) {
                    slow--;
                }
                left++;
            }
            best = Math.max(best, right - left + 1);
        }
        System.out.println(best);
    }
}
`,
} as const;

const aiSolutions = {
  assistantA: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys

THRESHOLD = 200
MAX_SLOW = 1


def longest_block(times):
    left = 0
    slow = 0
    best = 0
    for right, value in enumerate(times):
        slow += value > THRESHOLD
        while slow > MAX_SLOW:
            slow -= times[left] > THRESHOLD
            left += 1
        best = max(best, right - left + 1)
    return best


data = sys.stdin.read().split()
n = int(data[0])
print(longest_block(list(map(int, data[1:n + 1]))))
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const [n, ...times] = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(Number);
const THRESHOLD = 200;
const MAX_SLOW = 1;
let left = 0;
let slow = 0;
let best = 0;
times.slice(0, n).forEach((value, right) => {
  if (value > THRESHOLD) slow += 1;
  while (slow > MAX_SLOW) {
    if (times[left] > THRESHOLD) slow -= 1;
    left += 1;
  }
  best = Math.max(best, right - left + 1);
});
console.log(best);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        int[] a = new int[n];
        for (int i = 0; i < n; i++) a[i] = sc.nextInt();
        int left = 0, slow = 0, best = 0;
        for (int right = 0; right < n; right++) {
            if (a[right] > 200) slow++;
            while (slow > 1) {
                if (a[left] > 200) slow--;
                left++;
            }
            best = Math.max(best, right - left + 1);
        }
        System.out.println(best);
    }
}
`,
  },
  assistantB: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys


def main():
    tokens = sys.stdin.read().split()
    count = int(tokens[0])
    latencies = [int(t) for t in tokens[1:1 + count]]
    slow_positions = [i for i, v in enumerate(latencies) if v > 200]
    if len(slow_positions) <= 1:
        print(count)
        return
    best = 0
    # window start is just after the slow request that is 2 slow requests back (at most 1 allowed)
    padded = [-1] + slow_positions + [count]
    for k in range(1, len(padded) - 1):
        best = max(best, padded[k + 1] - padded[k - 1] - 1)
    print(best)


main()
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const input = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(Number);
const count = input[0];
const slow = [-1];
for (let i = 0; i < count; i++) {
  if (input[i + 1] > 200) slow.push(i);
}
slow.push(count);
let best = 0;
if (slow.length <= 3) {
  best = count;
} else {
  for (let k = 1; k < slow.length - 1; k++) {
    best = Math.max(best, slow[k + 1] - slow[k - 1] - 1);
  }
}
console.log(best);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int count = (int) in.nval;
        List<Integer> slow = new ArrayList<>();
        slow.add(-1);
        for (int i = 0; i < count; i++) {
            in.nextToken();
            if ((int) in.nval > 200) {
                slow.add(i);
            }
        }
        slow.add(count);
        int best = 0;
        if (slow.size() <= 3) {
            best = count;
        } else {
            for (int k = 1; k < slow.size() - 1; k++) {
                best = Math.max(best, slow.get(k + 1) - slow.get(k - 1) - 1);
            }
        }
        System.out.println(best);
    }
}
`,
  },
} as const;

const rngA = mulberry32(1301);
const rngB = mulberry32(1302);
const rngVariant2 = mulberry32(1321);

export const steadyStretch: CodingQuestionSpec = {
  slug: 'steady-stretch',
  title: 'Steady Stretch',
  difficulty: 'MEDIUM',
  tags: ['arrays', 'two-pointers'],
  statementTemplate,
  starterTemplates,
  referenceTemplates,
  slots: [
    sampleSlot(EXAMPLE_INPUT),
    sampleSlot('5\n10 20 30 40 50\n'),
    sampleSlot('4\n500 600 700 800\n'),
    ...hiddenSlots([
      '1\n1\n',
      '1\n999999999\n',
      '6\n201 201 201 201 201 201\n',
      '10\n150 151 150 151 150 151 150 151 150 151\n',
      '9\n300 301 299 301 300 302 100 400 50\n',
      '12\n200 201 200 201 202 5 5 5 400 400 5 5\n',
      listInput(randomInts(rngA, 3000, 1, 400)),
      listInput(randomInts(rngB, 8000, 1, 1000)),
    ]),
  ],
  variants: [
    { params: params('checkout', 200, 1) },
    {
      params: params('search', 150, 2),
      inputOverrides: { 9: listInput(randomInts(rngVariant2, 3500, 1, 400)) },
    },
    { params: params('login', 300, 0), inputOverrides: { 4: '1\n300\n' } },
  ],
  solve,
  aiSolutions,
};
