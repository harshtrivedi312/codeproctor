// Runs the seeded reference solutions and AI reference solutions (DB-04, ADR 0005 section 4, ADR 0007
// V-3) against the expected outputs, for every variant and every test slot, in Python, JavaScript
// and Java. This is what keeps bad seed data out until BE-05 validates through Judge0 (build plan,
// DB-04 note and BE-05 done-when). It needs python3, node and a JDK on the PATH; a language whose
// tool is missing is skipped with a message. Jobs start when the file loads and share a small pool
// of child processes, because each Java run needs a JVM.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const { codingQuestions } = await tsImport('../../prisma/seed/questions/index.ts', import.meta.url);
const { renderSources, resolveSlots } = await tsImport(
  '../../prisma/seed/variants.ts',
  import.meta.url,
);
const { renderTemplate } = await tsImport('../../prisma/seed/mustache.ts', import.meta.url);

const LANGUAGES = ['python', 'javascript', 'java'];
const RUN_TIMEOUT_MS = 60_000;
const POOL_SIZE = Math.max(2, Math.min(6, availableParallelism()));

const toolAvailable = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'ignore' });
  return result.error === undefined && result.status === 0;
};
const AVAILABLE = {
  python: toolAvailable('python3', ['--version']),
  javascript: true,
  java: toolAvailable('javac', ['-version']) && toolAvailable('java', ['-version']),
};
const MISSING_TOOL = {
  python: 'python3 is not on the PATH',
  java: 'javac and java are not on the PATH',
};

// A counting semaphore for child processes.
let running = 0;
const waiting = [];
async function withSlot(work) {
  if (running >= POOL_SIZE) await new Promise((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function runProcess(command, args, { cwd, input }) {
  return withSlot(
    () =>
      new Promise((resolve) => {
        const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', (error) => {
          clearTimeout(timer);
          resolve({ status: -1, stdout, stderr: String(error) });
        });
        child.on('close', (status) => {
          clearTimeout(timer);
          resolve({ status, stdout, stderr });
        });
        child.stdin.on('error', () => undefined);
        child.stdin.end(input ?? '');
      }),
  );
}

/** Writes one solution to its own directory. Java is compiled once; every other run reuses it. */
async function prepare(language, source) {
  const dir = mkdtempSync(join(tmpdir(), 'codeproctor-seed-solution-'));
  if (language === 'python') {
    writeFileSync(join(dir, 'Main.py'), source);
    return { dir, command: 'python3', args: ['Main.py'] };
  }
  if (language === 'javascript') {
    writeFileSync(join(dir, 'main.js'), source);
    return { dir, command: process.execPath, args: ['main.js'] };
  }
  writeFileSync(join(dir, 'Main.java'), source);
  mkdirSync(join(dir, 'out'));
  const compiled = await runProcess('javac', ['-d', 'out', 'Main.java'], { cwd: dir });
  if (compiled.status !== 0) {
    return { dir, failure: `javac failed: ${compiled.stderr.trim().slice(0, 400)}` };
  }
  return { dir, command: 'java', args: [...JAVA_RUN_FLAGS, '-cp', 'out', 'Main'] };
}

// The JVM's own diagnostics must never be read as the program's answer. HotSpot unified logging
// (-Xlog) writes warnings to stdout by default, so a hsperfdata warning ("Cannot use file
// /tmp/hsperfdata_...") once landed in the compared output. -XX:-UsePerfData stops the hsperfdata
// file altogether, and -Xlog:all=warning:stderr sends any remaining JVM warning to stderr.
const JAVA_RUN_FLAGS = Object.freeze(['-XX:-UsePerfData', '-Xlog:all=warning:stderr', '-Xss64m']);

/** @returns {Promise<string[]>} one message per wrong answer; empty when every slot passes */
async function check(label, language, source, slots) {
  const prepared = await prepare(language, source);
  try {
    if (prepared.failure !== undefined) return [`${label}: ${prepared.failure}`];
    const results = await Promise.all(
      slots.map((slot) =>
        runProcess(prepared.command, prepared.args, { cwd: prepared.dir, input: slot.input }),
      ),
    );
    const problems = [];
    results.forEach((result, i) => {
      const slot = slots[i];
      const got = result.stdout.trim();
      if (result.status !== 0) {
        problems.push(
          `${label} slot ${slot.index}: exit ${result.status}: ${result.stderr.trim().slice(0, 300)}`,
        );
      } else if (got !== slot.expectedOutput.trim()) {
        problems.push(
          `${label} slot ${slot.index}: expected "${slot.expectedOutput}", got "${got.slice(0, 60)}"`,
        );
      }
    });
    return problems;
  } finally {
    rmSync(prepared.dir, { recursive: true, force: true });
  }
}

function referenceJobs(spec, language) {
  return spec.variants.map((variant, variantIndex) => {
    const source = renderSources(spec.referenceTemplates, variant.params)[language];
    return check(
      `${spec.slug} reference ${language} variant ${variantIndex}`,
      language,
      source,
      resolveSlots(spec, variantIndex),
    );
  });
}

// AI reference solutions answer the base statement, so they are checked against variant 0.
function aiJobs(spec, language) {
  return ['assistantA', 'assistantB'].map((assistant) =>
    check(
      `${spec.slug} AI ${assistant} ${language}`,
      language,
      spec.aiSolutions[assistant][language],
      resolveSlots(spec, 0),
    ),
  );
}

for (const language of LANGUAGES) {
  const skip = AVAILABLE[language] ? false : MISSING_TOOL[language];
  for (const spec of codingQuestions) {
    // Start the work now so the files' tests overlap; each test only awaits its own jobs.
    const referenceResults = skip ? [] : referenceJobs(spec, language);
    const aiResults = skip ? [] : aiJobs(spec, language);

    test(
      `FR-203 / ADR-0007 V-3: ${spec.slug}: the ${language} reference solution passes every slot of every variant`,
      { skip },
      async () => {
        const problems = (await Promise.all(referenceResults)).flat();
        assert.deepEqual(problems, []);
      },
    );

    test(
      `ADR-0005 section 4: ${spec.slug}: the synthetic ${language} AI reference solutions pass the base statement's tests`,
      { skip },
      async () => {
        const problems = (await Promise.all(aiResults)).flat();
        assert.deepEqual(problems, []);
      },
    );
  }
}

test('ADR-0007 V-2: every placeholder in a template has a value in every variant, and none is left after rendering', () => {
  for (const spec of codingQuestions) {
    spec.variants.forEach((variant, variantIndex) => {
      const texts = [
        spec.statementTemplate,
        ...LANGUAGES.map((language) => spec.starterTemplates[language]),
        ...LANGUAGES.map((language) => spec.referenceTemplates[language]),
      ];
      for (const text of texts) {
        const rendered = renderTemplate(text, variant.params);
        assert.doesNotMatch(rendered, /\{\{/, `${spec.slug} variant ${variantIndex}`);
      }
    });
  }
});

test('FR-203 / ADR-0007 V-3: the Java runner keeps JVM diagnostics out of the compared stdout', async (t) => {
  // A hsperfdata warning once reached stdout and failed a correct solution (main CI, 9495f05).
  assert.ok(JAVA_RUN_FLAGS.includes('-XX:-UsePerfData'));
  assert.ok(JAVA_RUN_FLAGS.includes('-Xlog:all=warning:stderr'));
  if (!AVAILABLE.java) return t.skip(MISSING_TOOL.java);
  // With the flags, a program's stdout is exactly what it prints, with no JVM output mixed in.
  const dir = mkdtempSync(join(tmpdir(), 'codeproctor-seed-jvm-'));
  try {
    writeFileSync(
      join(dir, 'Main.java'),
      'public class Main { public static void main(String[] a) { System.out.print("42"); } }',
    );
    mkdirSync(join(dir, 'out'));
    assert.equal((await runProcess('javac', ['-d', 'out', 'Main.java'], { cwd: dir })).status, 0);
    const run = await runProcess('java', [...JAVA_RUN_FLAGS, '-cp', 'out', 'Main'], {
      cwd: dir,
      input: '',
    });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, '42');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
