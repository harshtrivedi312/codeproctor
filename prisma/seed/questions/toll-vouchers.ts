// HARD, graphs and shortest paths. Original problem: cheapest route when a few road fees can be
// waived. The state of the search is (depot, vouchers used).
// Params change the number of vouchers, so expected outputs differ per variant.
import { mulberry32, randomInt, tokens } from '../rng';
import {
  type CodingQuestionSpec,
  type Params,
  SYNTHETIC_CODE_NOTE,
  hiddenSlots,
  sampleSlot,
} from '../types';

const UNREACHABLE = Number.POSITIVE_INFINITY;

function solve(params: Params, input: string): string {
  const vouchers = Number(params.vouchers);
  const values = tokens(input).map(Number);
  const n = values[0] as number;
  const m = values[1] as number;
  const roads: [number, number, number][] = [];
  for (let i = 0; i < m; i++) {
    roads.push([
      values[2 + 3 * i] as number,
      values[3 + 3 * i] as number,
      values[4 + 3 * i] as number,
    ]);
  }
  // Independent of the reference solution (Dijkstra with a heap): Bellman-Ford over the layers.
  const dist: number[][] = [];
  for (let layer = 0; layer <= vouchers; layer++)
    dist.push(new Array<number>(n + 1).fill(UNREACHABLE));
  (dist[0] as number[])[1] = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [u, v, w] of roads) {
      for (let layer = 0; layer <= vouchers; layer++) {
        const here = (dist[layer] as number[])[u] as number;
        if (here === UNREACHABLE) continue;
        const same = dist[layer] as number[];
        if (here + w < (same[v] as number)) {
          same[v] = here + w;
          changed = true;
        }
        if (layer < vouchers) {
          const next = dist[layer + 1] as number[];
          if (here < (next[v] as number)) {
            next[v] = here;
            changed = true;
          }
        }
      }
    }
  }
  let best = UNREACHABLE;
  for (let layer = 0; layer <= vouchers; layer++) {
    best = Math.min(best, (dist[layer] as number[])[n] as number);
  }
  return best === UNREACHABLE ? '-1' : String(best);
}

function graphInput(n: number, roads: readonly (readonly [number, number, number])[]): string {
  return `${n} ${roads.length}\n${roads.map((road) => road.join(' ')).join('\n')}\n`;
}

/** A path 1 -> 2 -> ... -> n (so depot n is reachable) plus random one-way roads. */
function randomGraph(seed: number, n: number, extraRoads: number, maxFee: number): string {
  const random = mulberry32(seed);
  const roads: [number, number, number][] = [];
  for (let u = 1; u < n; u++) roads.push([u, u + 1, randomInt(random, 1, maxFee)]);
  for (let i = 0; i < extraRoads; i++) {
    roads.push([randomInt(random, 1, n), randomInt(random, 1, n), randomInt(random, 1, maxFee)]);
  }
  return graphInput(n, roads);
}

const EXAMPLE_INPUT = '5 4\n1 2 7\n2 3 7\n3 4 7\n4 5 7\n';

function params(fee: string, vouchers: number): Params {
  return { fee, vouchers, exampleAnswer: solve({ vouchers }, EXAMPLE_INPUT) };
}

const statementTemplate = `# Toll Vouchers

A courier network has \`N\` depots, numbered 1 to \`N\`, joined by \`M\` one-way roads. Driving along the road from depot \`u\` to depot \`v\` costs a {{fee}} of \`w\` cents. The courier holds {{vouchers}} voucher(s). A voucher waives the {{fee}} of **one** drive along a road. If the route drives the same road twice, each drive needs its own voucher to be free. Vouchers that are not used are worth nothing.

Find the smallest total {{fee}} for a route from depot 1 to depot \`N\`, or -1 if depot \`N\` cannot be reached.

For the network in the first sample the answer is {{exampleAnswer}}.

## Input

- Line 1: two integers \`N\` and \`M\`.
- Next \`M\` lines: three integers \`u v w\`, a one-way road from \`u\` to \`v\` with {{fee}} \`w\`.

## Output

One integer: the smallest total {{fee}} in cents, or -1.

## Constraints

- 2 <= N <= 2000
- 0 <= M <= 10000
- 1 <= w <= 100000
- Roads may form cycles, and several roads may join the same two depots.
`;

const starterTemplates = {
  python: String.raw`import sys


def main():
    data = sys.stdin.read().split()
    n, m = int(data[0]), int(data[1])
    roads = []
    for i in range(m):
        roads.append((int(data[2 + 3 * i]), int(data[3 + 3 * i]), int(data[4 + 3 * i])))
    vouchers = {{vouchers}}
    # TODO: find the smallest total {{fee}} from depot 1 to depot n, or -1.
    print(-1)


main()
`,
  javascript: String.raw`const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
const m = data[1];
const roads = [];
for (let i = 0; i < m; i++) {
  roads.push([data[2 + 3 * i], data[3 + 3 * i], data[4 + 3 * i]]);
}
const vouchers = {{vouchers}};
// TODO: find the smallest total {{fee}} from depot 1 to depot n, or -1.
console.log(String(-1));
`,
  java: String.raw`import java.io.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        in.nextToken();
        int m = (int) in.nval;
        int[][] roads = new int[m][3];
        for (int i = 0; i < m; i++) {
            for (int k = 0; k < 3; k++) {
                in.nextToken();
                roads[i][k] = (int) in.nval;
            }
        }
        int vouchers = {{vouchers}};
        // TODO: find the smallest total {{fee}} from depot 1 to depot n, or -1.
        System.out.println(-1);
    }
}
`,
} as const;

// A small binary min-heap of [distance, depot, vouchersUsed] triples, shared by both JavaScript
// solutions below that need one.
const JS_HEAP = String.raw`class MinHeap {
  constructor() {
    this.items = [];
  }
  push(item) {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent][0] <= items[i][0]) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left][0] < items[smallest][0]) smallest = left;
        if (right < items.length && items[right][0] < items[smallest][0]) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}
`;

const referenceTemplates = {
  python: String.raw`import heapq
import sys


def main():
    data = sys.stdin.read().split()
    n, m = int(data[0]), int(data[1])
    graph = [[] for _ in range(n + 1)]
    for i in range(m):
        u = int(data[2 + 3 * i])
        v = int(data[3 + 3 * i])
        w = int(data[4 + 3 * i])
        graph[u].append((v, w))
    layers = {{vouchers}} + 1
    inf = float('inf')
    dist = [[inf] * layers for _ in range(n + 1)]
    dist[1][0] = 0
    heap = [(0, 1, 0)]
    while heap:
        d, u, used = heapq.heappop(heap)
        if d > dist[u][used]:
            continue
        for v, w in graph[u]:
            if d + w < dist[v][used]:
                dist[v][used] = d + w
                heapq.heappush(heap, (d + w, v, used))
            if used + 1 < layers and d < dist[v][used + 1]:
                dist[v][used + 1] = d
                heapq.heappush(heap, (d, v, used + 1))
    best = min(dist[n])
    print(-1 if best == inf else best)


main()
`,
  javascript: String.raw`${JS_HEAP}
const data = require('fs').readFileSync(0, 'utf8').split(/\s+/).filter(Boolean).map(Number);
const n = data[0];
const m = data[1];
const graph = Array.from({ length: n + 1 }, () => []);
for (let i = 0; i < m; i++) {
  graph[data[2 + 3 * i]].push([data[3 + 3 * i], data[4 + 3 * i]]);
}
const layers = {{vouchers}} + 1;
const dist = Array.from({ length: n + 1 }, () => new Array(layers).fill(Infinity));
dist[1][0] = 0;
const heap = new MinHeap();
heap.push([0, 1, 0]);
while (heap.size > 0) {
  const [d, u, used] = heap.pop();
  if (d > dist[u][used]) continue;
  for (const [v, w] of graph[u]) {
    if (d + w < dist[v][used]) {
      dist[v][used] = d + w;
      heap.push([d + w, v, used]);
    }
    if (used + 1 < layers && d < dist[v][used + 1]) {
      dist[v][used + 1] = d;
      heap.push([d, v, used + 1]);
    }
  }
}
const best = Math.min(...dist[n]);
console.log(String(best === Infinity ? -1 : best));
`,
  java: String.raw`import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        in.nextToken();
        int m = (int) in.nval;
        List<List<int[]>> graph = new ArrayList<>();
        for (int i = 0; i <= n; i++) {
            graph.add(new ArrayList<>());
        }
        for (int i = 0; i < m; i++) {
            in.nextToken();
            int u = (int) in.nval;
            in.nextToken();
            int v = (int) in.nval;
            in.nextToken();
            int w = (int) in.nval;
            graph.get(u).add(new int[] {v, w});
        }
        int layers = {{vouchers}} + 1;
        long inf = Long.MAX_VALUE / 4;
        long[][] dist = new long[n + 1][layers];
        for (long[] row : dist) {
            Arrays.fill(row, inf);
        }
        dist[1][0] = 0;
        PriorityQueue<long[]> heap = new PriorityQueue<>((a, b) -> Long.compare(a[0], b[0]));
        heap.add(new long[] {0, 1, 0});
        while (!heap.isEmpty()) {
            long[] top = heap.poll();
            long d = top[0];
            int u = (int) top[1];
            int used = (int) top[2];
            if (d > dist[u][used]) {
                continue;
            }
            for (int[] road : graph.get(u)) {
                int v = road[0];
                if (d + road[1] < dist[v][used]) {
                    dist[v][used] = d + road[1];
                    heap.add(new long[] {d + road[1], v, used});
                }
                if (used + 1 < layers && d < dist[v][used + 1]) {
                    dist[v][used + 1] = d;
                    heap.add(new long[] {d, v, used + 1});
                }
            }
        }
        long best = inf;
        for (long value : dist[n]) {
            best = Math.min(best, value);
        }
        System.out.println(best >= inf ? -1 : best);
    }
}
`,
} as const;

const aiSolutions = {
  assistantA: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import sys

VOUCHERS = 1
INF = float("inf")

data = sys.stdin.read().split()
n, m = int(data[0]), int(data[1])
roads = [(int(data[2 + 3 * i]), int(data[3 + 3 * i]), int(data[4 + 3 * i])) for i in range(m)]
dist = [[INF] * (n + 1) for _ in range(VOUCHERS + 1)]
dist[0][1] = 0
changed = True
while changed:
    changed = False
    for u, v, w in roads:
        for k in range(VOUCHERS + 1):
            if dist[k][u] == INF:
                continue
            if dist[k][u] + w < dist[k][v]:
                dist[k][v] = dist[k][u] + w
                changed = True
            if k < VOUCHERS and dist[k][u] < dist[k + 1][v]:
                dist[k + 1][v] = dist[k][u]
                changed = True
answer = min(dist[k][n] for k in range(VOUCHERS + 1))
print(-1 if answer == INF else answer)
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const nums = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(Number);
const VOUCHERS = 1;
const [n, m] = nums;
const dist = Array.from({ length: VOUCHERS + 1 }, () => new Array(n + 1).fill(Infinity));
dist[0][1] = 0;
let changed = true;
while (changed) {
  changed = false;
  for (let i = 0; i < m; i++) {
    const u = nums[2 + 3 * i];
    const v = nums[3 + 3 * i];
    const w = nums[4 + 3 * i];
    for (let k = 0; k <= VOUCHERS; k++) {
      if (dist[k][u] === Infinity) continue;
      if (dist[k][u] + w < dist[k][v]) {
        dist[k][v] = dist[k][u] + w;
        changed = true;
      }
      if (k < VOUCHERS && dist[k][u] < dist[k + 1][v]) {
        dist[k + 1][v] = dist[k][u];
        changed = true;
      }
    }
  }
}
let answer = Infinity;
for (let k = 0; k <= VOUCHERS; k++) answer = Math.min(answer, dist[k][n]);
console.log(answer === Infinity ? -1 : answer);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);
        final int vouchers = 1;
        final long INF = Long.MAX_VALUE / 4;
        int n = sc.nextInt();
        int m = sc.nextInt();
        int[] from = new int[m];
        int[] to = new int[m];
        long[] fee = new long[m];
        for (int i = 0; i < m; i++) {
            from[i] = sc.nextInt();
            to[i] = sc.nextInt();
            fee[i] = sc.nextLong();
        }
        long[][] dist = new long[vouchers + 1][n + 1];
        for (long[] row : dist) Arrays.fill(row, INF);
        dist[0][1] = 0;
        boolean changed = true;
        while (changed) {
            changed = false;
            for (int i = 0; i < m; i++) {
                for (int k = 0; k <= vouchers; k++) {
                    if (dist[k][from[i]] >= INF) continue;
                    if (dist[k][from[i]] + fee[i] < dist[k][to[i]]) {
                        dist[k][to[i]] = dist[k][from[i]] + fee[i];
                        changed = true;
                    }
                    if (k < vouchers && dist[k][from[i]] < dist[k + 1][to[i]]) {
                        dist[k + 1][to[i]] = dist[k][from[i]];
                        changed = true;
                    }
                }
            }
        }
        long answer = INF;
        for (int k = 0; k <= vouchers; k++) answer = Math.min(answer, dist[k][n]);
        System.out.println(answer >= INF ? -1 : answer);
    }
}
`,
  },
  assistantB: {
    python: String.raw`# ${SYNTHETIC_CODE_NOTE}
import heapq
import sys


def cheapest(n, adjacency, vouchers):
    best = {}
    queue = [(0, 1, vouchers)]
    while queue:
        cost, node, left = heapq.heappop(queue)
        if (node, left) in best:
            continue
        best[(node, left)] = cost
        if node == n:
            return cost
        for nxt, fee in adjacency[node]:
            heapq.heappush(queue, (cost + fee, nxt, left))
            if left > 0:
                heapq.heappush(queue, (cost, nxt, left - 1))
    return -1


def main():
    tokens = sys.stdin.read().split()
    n, m = int(tokens[0]), int(tokens[1])
    adjacency = [[] for _ in range(n + 1)]
    for i in range(m):
        a, b, c = (int(x) for x in tokens[2 + 3 * i:5 + 3 * i])
        adjacency[a].append((b, c))
    print(cheapest(n, adjacency, 1))


main()
`,
    javascript: String.raw`// ${SYNTHETIC_CODE_NOTE}
const numbers = require('fs').readFileSync(0, 'utf8').trim().split(/\s+/).map(Number);
const VOUCHERS = 1;
const n = numbers[0];
const m = numbers[1];
const edges = [];
for (let i = 0; i < m; i++) {
  edges.push({ from: numbers[2 + 3 * i], to: numbers[3 + 3 * i], fee: numbers[4 + 3 * i] });
}
let current = Array.from({ length: VOUCHERS + 1 }, () => new Array(n + 1).fill(Infinity));
current[0][1] = 0;
for (let round = 0; round < n * (VOUCHERS + 1); round++) {
  let improved = false;
  for (const edge of edges) {
    for (let k = 0; k <= VOUCHERS; k++) {
      const base = current[k][edge.from];
      if (base === Infinity) continue;
      if (base + edge.fee < current[k][edge.to]) {
        current[k][edge.to] = base + edge.fee;
        improved = true;
      }
      if (k + 1 <= VOUCHERS && base < current[k + 1][edge.to]) {
        current[k + 1][edge.to] = base;
        improved = true;
      }
    }
  }
  if (!improved) break;
}
const result = Math.min(...current.map((row) => row[n]));
console.log(result === Infinity ? -1 : result);
`,
    java: String.raw`// ${SYNTHETIC_CODE_NOTE}
import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) throws IOException {
        StreamTokenizer in = new StreamTokenizer(new BufferedInputStream(System.in));
        in.nextToken();
        int n = (int) in.nval;
        in.nextToken();
        int m = (int) in.nval;
        int[][] edges = new int[m][3];
        for (int i = 0; i < m; i++) {
            for (int j = 0; j < 3; j++) {
                in.nextToken();
                edges[i][j] = (int) in.nval;
            }
        }
        final int vouchers = 1;
        long inf = Long.MAX_VALUE / 4;
        long[][] d = new long[vouchers + 1][n + 1];
        for (long[] row : d) {
            Arrays.fill(row, inf);
        }
        d[0][1] = 0;
        for (int round = 0; round < n * (vouchers + 1); round++) {
            boolean improved = false;
            for (int[] e : edges) {
                for (int k = 0; k <= vouchers; k++) {
                    long base = d[k][e[0]];
                    if (base >= inf) {
                        continue;
                    }
                    if (base + e[2] < d[k][e[1]]) {
                        d[k][e[1]] = base + e[2];
                        improved = true;
                    }
                    if (k + 1 <= vouchers && base < d[k + 1][e[1]]) {
                        d[k + 1][e[1]] = base;
                        improved = true;
                    }
                }
            }
            if (!improved) {
                break;
            }
        }
        long result = inf;
        for (int k = 0; k <= vouchers; k++) {
            result = Math.min(result, d[k][n]);
        }
        System.out.println(result >= inf ? -1 : result);
    }
}
`,
  },
} as const;

export const tollVouchers: CodingQuestionSpec = {
  slug: 'toll-vouchers',
  title: 'Toll Vouchers',
  difficulty: 'HARD',
  tags: ['graphs', 'shortest-path'],
  statementTemplate,
  starterTemplates,
  referenceTemplates,
  slots: [
    sampleSlot(EXAMPLE_INPUT),
    sampleSlot('3 1\n1 2 5\n'),
    sampleSlot('2 1\n1 2 100\n'),
    ...hiddenSlots([
      '4 5\n1 2 10\n2 4 10\n1 3 3\n3 4 30\n2 3 1\n',
      '4 4\n1 2 1\n2 1 1\n2 3 100\n3 4 100\n',
      '6 7\n1 2 4\n1 3 2\n2 4 5\n3 4 8\n3 5 10\n4 6 3\n5 6 1\n',
      '3 3\n1 3 1000\n1 2 1\n2 3 1\n',
      '7 8\n1 2 50\n2 3 50\n3 7 50\n1 4 20\n4 5 20\n5 6 20\n6 7 20\n1 7 400\n',
      randomGraph(1601, 250, 2000, 10000),
      randomGraph(1602, 400, 3000, 100000),
      randomGraph(1603, 100, 8000, 100000),
    ]),
  ],
  variants: [
    { params: params('toll', 1) },
    { params: params('fee', 2), inputOverrides: { 8: randomGraph(1621, 200, 1800, 10000) } },
    {
      params: params('charge', 3),
      inputOverrides: { 5: '5 5\n1 2 9\n2 3 9\n3 4 9\n4 5 9\n1 5 50\n' },
    },
  ],
  solve,
  aiSolutions,
};
