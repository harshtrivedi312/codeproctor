// MEDIUM, arrays and prefix sums. Original problem: move stock between neighbouring sites in a row.
// Params change the cost of one move and the name of the site, so expected outputs differ per variant.
import { mulberry32, randomInts, shuffled, tokens } from '../rng';
import {
  type CodingQuestionSpec,
  type Params,
  SYNTHETIC_CODE_NOTE,
  hiddenSlots,
  sampleSlot,
} from '../types';

function solve(params: Params, input: string): string {
  const cost = Number(params.cost);
  const values = tokens(input).map(Number);
  const n = values[0] as number;
  const have = values.slice(1, 1 + n);
  const need = values.slice(1 + n, 1 + 2 * n);
  // Every unit that has to cross the boundary after site i is counted once per boundary.
  let flow = 0;
  let moved = 0;
  for (let i = 0; i < n; i++) {
    flow += (have[i] as number) - (need[i] as number);
    moved += Math.abs(flow);
  }
  return String(moved * cost);
}

function twoLists(have: readonly number[], need: readonly number[]): string {
  return `${have.length}\n${have.join(' ')}\n${need.join(' ')}\n`;
}

const EXAMPLE_INPUT = '3\n5 0 1\n2 2 2\n';

function params(site: string, cost: number): Params {
  return { site, cost, exampleAnswer: solve({ cost }, EXAMPLE_INPUT) };
}

function shuffledPair(seed: number, n: number): string {
  const random = mulberry32(seed);
  const have = randomInts(random, n, 0, 1000);
  return twoLists(have, shuffled(random, have));
}

function halves(n: number, amount: number): string {
  const half = n / 2;
  const have = [...new Array<number>(half).fill(amount), ...new Array<number>(half).fill(0)];
  const need = [...new Array<number>(half).fill(0), ...new Array<number>(half).fill(amount)];
  return twoLists(have, need);
}

const statementTemplate = `# Stock Rebalancing

\`N\` {{site}}s stand in a row. The {{site}} at position \`i\` holds \`have[i]\` units of stock and needs \`need[i]\` units. The total stock equals the total need. A truck can carry one unit between two neighbouring {{site}}s for {{cost}} cents, and it can make as many trips as it likes. Moving a unit across several {{site}}s costs {{cost}} cents for each step.

Find the minimum total cost, in cents, to give every {{site}} exactly the stock it needs.

For \`have = 5 0 1\` and \`need = 2 2 2\` the answer is {{exampleAnswer}}.

## Input

- Line 1: an integer \`N\`.
- Line 2: \`N\` integers, \`have[1..N]\`.
- Line 3: \`N\` integers, \`need[1..N]\`.

## Output

One integer: the minimum total cost in cents.

## Constraints

- 1 <= N <= 100000
- 0 <= have[i], need[i] <= 1000
- The sum of \`have\` equals the sum of \`need\`.
- The answer can be larger than 32 bits.
`;

const starterTemplates = {
  python: String.raw`import sys


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    have = [int(x) for x in data[1:1 + n]]
    need = [int(x) for x in data[1 + n:1 + 2 * n]]
    # One unit moved one step costs {{cost}} cents.
    cost = 0
    # TODO: compute the minimum total cost.
    print(cost)


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
const have = data.slice(1, 1 + n);
const need = data.slice(1 + n, 1 + 2 * n);
// One unit moved one step costs {{cost}} cents.
let cost = 0;
// TODO: compute the minimum total cost.
console.log(String(cost));
`,
  java: String.raw`import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        int[] have = new int[n];
        int[] need = new int[n];
        for (int i = 0; i < n; i++) {
            in.nextToken();
            have[i] = (int) in.nval;
        }
        for (int i = 0; i < n; i++) {
            in.nextToken();
            need[i] = (int) in.nval;
        }
        // One unit moved one step costs {{cost}} cents.
        long cost = 0;
        // TODO: compute the minimum total cost.
        System.out.println(cost);
    }
}
`,
} as const;

const referenceTemplates = {
  python: String.raw`import sys


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    have = data[1:1 + n]
    need = data[1 + n:1 + 2 * n]
    flow = 0
    moved = 0
    for i in range(n):
        flow += int(have[i]) - int(need[i])
        moved += abs(flow)
    print(moved * {{cost}})


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
let flow = 0;
let moved = 0;
for (let i = 0; i < n; i++) {
  flow += data[1 + i] - data[1 + n + i];
  moved += Math.abs(flow);
}
console.log(String(moved * {{cost}}));
`,
  java: String.raw`import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        int[] have = new int[n];
        for (int i = 0; i < n; i++) {
            in.nextToken();
            have[i] = (int) in.nval;
        }
        long flow = 0;
        long moved = 0;
        for (int i = 0; i < n; i++) {
            in.nextToken();
            flow += have[i] - (int) in.nval;
            moved += Math.abs(flow);
        }
        System.out.println(moved * {{cost}}L);
    }
}
`,
} as const;

const aiSolutions = {
  assistantA: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys
from itertools import accumulate

tokens = sys.stdin.read().split()
n = int(tokens[0])
have = list(map(int, tokens[1:1 + n]))
need = list(map(int, tokens[1 + n:1 + 2 * n]))
diff = [h - d for h, d in zip(have, need)]
print(3 * sum(abs(p) for p in accumulate(diff)))
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const nums = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(Number);
const n = nums[0];
const have = nums.slice(1, 1 + n);
const need = nums.slice(1 + n, 1 + 2 * n);
let prefix = 0;
let total = 0;
for (let i = 0; i < n; i++) {
  prefix += have[i] - need[i];
  total += Math.abs(prefix);
}
console.log(total * 3);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        long[] diff = new long[n];
        for (int i = 0; i < n; i++) diff[i] = sc.nextLong();
        for (int i = 0; i < n; i++) diff[i] -= sc.nextLong();
        long prefix = 0;
        long total = 0;
        for (long d : diff) {
            prefix += d;
            total += Math.abs(prefix);
        }
        System.out.println(total * 3);
    }
}
`,
  },
  assistantB: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys


def min_cost(have, need, unit_cost):
    balance = 0
    steps = 0
    for h, d in zip(have, need):
        balance += h - d
        steps += balance if balance >= 0 else -balance
    return steps * unit_cost


def main():
    lines = sys.stdin.read().strip().split("\n")
    have = [int(x) for x in lines[1].split()]
    need = [int(x) for x in lines[2].split()]
    print(min_cost(have, need, 3))


main()
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const lines = require('fs').readFileSync(0, 'utf8').trim().split('\n');
const have = lines[1].split(' ').map(Number);
const need = lines[2].split(' ').map(Number);
const UNIT_COST = 3;
let balance = 0;
let steps = 0;
for (let i = 0; i < have.length; i++) {
  balance = balance + have[i] - need[i];
  steps += balance < 0 ? -balance : balance;
}
console.log(steps * UNIT_COST);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        int n = Integer.parseInt(reader.readLine().trim());
        StringTokenizer haveTokens = new StringTokenizer(reader.readLine());
        StringTokenizer needTokens = new StringTokenizer(reader.readLine());
        long balance = 0;
        long steps = 0;
        for (int i = 0; i < n; i++) {
            balance += Long.parseLong(haveTokens.nextToken()) - Long.parseLong(needTokens.nextToken());
            steps += Math.abs(balance);
        }
        System.out.println(steps * 3L);
    }
}
`,
  },
} as const;

export const stockRebalance: CodingQuestionSpec = {
  slug: 'stock-rebalance',
  title: 'Stock Rebalancing',
  difficulty: 'MEDIUM',
  tags: ['arrays', 'prefix-sums'],
  statementTemplate,
  starterTemplates,
  referenceTemplates,
  slots: [
    sampleSlot(EXAMPLE_INPUT),
    sampleSlot('1\n7\n7\n'),
    sampleSlot('4\n0 0 0 6\n3 0 3 0\n'),
    ...hiddenSlots([
      '2\n0 10\n10 0\n',
      '5\n1 1 1 1 1\n1 1 1 1 1\n',
      '6\n9 0 0 0 0 9\n3 3 3 3 3 3\n',
      '7\n0 0 0 0 0 0 21\n3 3 3 3 3 3 3\n',
      '8\n8 7 6 5 4 3 2 1\n1 2 3 4 5 6 7 8\n',
      shuffledPair(1401, 4000),
      shuffledPair(1402, 8000),
      halves(3000, 1000),
    ]),
  ],
  variants: [
    { params: params('warehouse', 3) },
    { params: params('depot', 5), inputOverrides: { 4: '4\n2 2 2 2\n2 2 2 2\n' } },
    { params: params('clinic', 2), inputOverrides: { 8: shuffledPair(1421, 3000) } },
  ],
  solve,
  aiSolutions,
};
