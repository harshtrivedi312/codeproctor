// EASY, arrays and math. Original problem: a courier's per-parcel weight surcharge.
// Params change the free limit and the rate, so every slot's expected output differs per variant.
import { mulberry32, randomInts, tokens } from '../rng';
import {
  type CodingQuestionSpec,
  type Params,
  SYNTHETIC_CODE_NOTE,
  hiddenSlots,
  sampleSlot,
} from '../types';

const STEP_GRAMS = 100;

function solve(params: Params, input: string): string {
  const limit = Number(params.limit);
  const rate = Number(params.rate);
  const values = tokens(input).map(Number);
  const n = values[0] as number;
  let total = 0;
  for (let i = 1; i <= n; i++) {
    const weight = values[i] as number;
    if (weight > limit) total += rate * Math.ceil((weight - limit) / STEP_GRAMS);
  }
  return String(total);
}

function listInput(weights: readonly number[]): string {
  return `${weights.length}\n${weights.join(' ')}\n`;
}

const EXAMPLE_INPUT = '5\n100 500 501 600 1000\n';

function params(item: string, limit: number, rate: number): Params {
  return { item, limit, rate, exampleWeight: limit + 250, exampleCost: rate * 3 };
}

const statementTemplate = `# Parcel Surcharge

A courier ships every {{item}} up to {{limit}} grams for free. A {{item}} heavier than {{limit}} grams pays a surcharge of {{rate}} cents for every **started** 100 grams above {{limit}} grams. A started block counts in full, so a {{item}} of {{exampleWeight}} grams pays {{exampleCost}} cents.

Given the weights of all {{item}}s in one day's batch, compute the total surcharge in cents.

## Input

- Line 1: an integer \`N\`, the number of {{item}}s.
- Line 2: \`N\` integers, the weight of each {{item}} in grams.

## Output

One integer: the total surcharge in cents.

## Constraints

- 1 <= N <= 100000
- 1 <= weight <= 1000000
- The total can be larger than 32 bits.
`;

const starterTemplates = {
  python: String.raw`import sys


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    weights = [int(x) for x in data[1:1 + n]]
    # Free limit: {{limit}} g. Surcharge: {{rate}} cents per started 100 g above it.
    total = 0
    # TODO: add the surcharge of every {{item}} to total.
    print(total)


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
const weights = data.slice(1, 1 + n);
// Free limit: {{limit}} g. Surcharge: {{rate}} cents per started 100 g above it.
let total = 0;
// TODO: add the surcharge of every {{item}} to total.
console.log(String(total));
`,
  java: String.raw`import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        long total = 0;
        // Free limit: {{limit}} g. Surcharge: {{rate}} cents per started 100 g above it.
        for (int i = 0; i < n; i++) {
            in.nextToken();
            long weight = (long) in.nval;
            // TODO: add the surcharge of this {{item}} to total.
        }
        System.out.println(total);
    }
}
`,
} as const;

const referenceTemplates = {
  python: String.raw`import sys


def main():
    data = sys.stdin.read().split()
    n = int(data[0])
    total = 0
    for token in data[1:1 + n]:
        weight = int(token)
        if weight > {{limit}}:
            total += {{rate}} * ((weight - {{limit}} + 99) // 100)
    print(total)


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
let total = 0;
for (let i = 1; i <= n; i++) {
  const weight = data[i];
  if (weight > {{limit}}) {
    total += {{rate}} * Math.ceil((weight - {{limit}}) / 100);
  }
}
console.log(String(total));
`,
  java: String.raw`import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        long total = 0;
        for (int i = 0; i < n; i++) {
            in.nextToken();
            long weight = (long) in.nval;
            if (weight > {{limit}}) {
                total += {{rate}}L * ((weight - {{limit}} + 99) / 100);
            }
        }
        System.out.println(total);
    }
}
`,
} as const;

const aiSolutions = {
  assistantA: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys


def surcharge(weight):
    if weight <= 500:
        return 0
    return 25 * (-(-(weight - 500) // 100))


tokens = sys.stdin.read().split()
n = int(tokens[0])
print(sum(surcharge(int(t)) for t in tokens[1:n + 1]))
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const tokens = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(Number);
const n = tokens[0];
const surcharge = (w) => (w <= 500 ? 0 : 25 * Math.ceil((w - 500) / 100));
let total = 0;
for (const w of tokens.slice(1, n + 1)) total += surcharge(w);
console.log(total);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.util.*;

public class Main {
    static long surcharge(long w) {
        if (w <= 500) return 0;
        return 25L * ((w - 500 + 99) / 100);
    }

    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        int n = sc.nextInt();
        long total = 0;
        for (int i = 0; i < n; i++) total += surcharge(sc.nextLong());
        System.out.println(total);
    }
}
`,
  },
  assistantB: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import math
import sys


def main():
    lines = sys.stdin.read().strip().split("\n")
    weights = list(map(int, lines[1].split()))
    total = 0
    for w in weights:
        extra = w - 500
        if extra > 0:
            total += math.ceil(extra / 100) * 25
    print(total)


if __name__ == "__main__":
    main()
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const lines = require('fs').readFileSync(0, 'utf8').split('\n');
const weights = lines[1].trim().split(' ').map(Number);
const total = weights.reduce((sum, w) => {
  const extra = w - 500;
  return extra > 0 ? sum + Math.ceil(extra / 100) * 25 : sum;
}, 0);
console.log(total);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        BufferedReader reader = new BufferedReader(new InputStreamReader(System.in));
        reader.readLine();
        StringTokenizer st = new StringTokenizer(reader.readLine());
        long total = 0;
        while (st.hasMoreTokens()) {
            long extra = Long.parseLong(st.nextToken()) - 500;
            if (extra > 0) {
                total += ((extra + 99) / 100) * 25;
            }
        }
        System.out.println(total);
    }
}
`,
  },
} as const;

const rngA = mulberry32(1101);
const rngB = mulberry32(1102);
const rngC = mulberry32(1103);
const rngVariant3 = mulberry32(1121);

export const parcelSurcharge: CodingQuestionSpec = {
  slug: 'parcel-surcharge',
  title: 'Parcel Surcharge',
  difficulty: 'EASY',
  tags: ['arrays', 'math'],
  statementTemplate,
  starterTemplates,
  referenceTemplates,
  slots: [
    sampleSlot(EXAMPLE_INPUT),
    sampleSlot('3\n1 2 3\n'),
    sampleSlot('4\n750 750 751 900\n'),
    ...hiddenSlots([
      '1\n1000000\n',
      '2\n300 500\n',
      '12\n300 301 400 401 500 501 600 601 750 751 850 851\n',
      '7\n299 300 301 499 500 751 1000\n',
      listInput(randomInts(rngA, 2000, 1, 2000)),
      listInput(randomInts(rngB, 3000, 1, 1500)),
      listInput(randomInts(rngC, 5000, 1, 1000000)),
      listInput(new Array<number>(9000).fill(1000000)),
    ]),
  ],
  variants: [
    { params: params('parcel', 500, 25) },
    { params: params('package', 750, 40), inputOverrides: { 3: '1\n999999\n' } },
    {
      params: params('crate', 300, 15),
      inputOverrides: { 8: listInput(randomInts(rngVariant3, 2500, 1, 2000)) },
    },
  ],
  solve,
  aiSolutions,
};
