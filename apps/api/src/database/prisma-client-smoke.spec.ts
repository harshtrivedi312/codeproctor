// Smoke test (ADR 0009 P14, DB-05): the generated Prisma client loads, constructs and queries under
// the real Nest build on this Node, not only under Jest. It compiles apps/api with
// tsconfig.build.json into a scratch folder, then runs the compiled JavaScript in a plain Node
// process: the factory builds a client, and a Nest application context starts DatabaseModule, runs
// a query as app_user and shuts down. Docker is required (the query needs a migrated Postgres).
// It also checks the conventions this relies on: only the factory constructs a PrismaClient
// (ADR 0009 section 4.2), and the build leaves the database test helpers out.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { startMigratedDatabase } from './testing/migrated-postgres';
import type { MigratedDatabase } from './testing/migrated-postgres';

const API_ROOT = resolve(__dirname, '../..');
const SRC = join(API_ROOT, 'src');

/** Compiled code runs this: the factory, then a Nest application context with DatabaseModule. */
const SMOKE_SCRIPT = `
require('reflect-metadata');
const { Module } = require('@nestjs/common');
const { ConfigModule } = require('@nestjs/config');
const { NestFactory } = require('@nestjs/core');
const { Prisma } = require('./generated/prisma/client.js');
const { createPrismaClient } = require('./database/create-prisma-client.js');
const { DatabaseModule, OrgContextService, PrismaService } = require('./database/index.js');

async function main() {
  const url = process.env.SMOKE_DATABASE_URL;

  // 1. The factory alone: the generated client loads and constructs, and a raw query runs.
  const plain = createPrismaClient(url);
  const rows = await plain.$queryRaw\`SELECT current_user AS role\`;
  await plain.$disconnect();

  // 2. The Nest module: DI resolves under the compiled decorators, lifecycle connects, a scoped
  //    query runs, and shutdown disconnects.
  class Root {}
  Module({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ DATABASE_URL: url })] }),
      DatabaseModule,
    ],
  })(Root);
  const app = await NestFactory.createApplicationContext(Root, { logger: false });
  const prisma = app.get(PrismaService);
  const orgContext = app.get(OrgContextService);
  const orgs = await orgContext.runSystem('BACKGROUND_JOB', () => prisma.client.organization.count());
  let refused = false;
  try {
    await prisma.client.organization.count();
  } catch (error) {
    refused = error instanceof Error && error.name === 'OrgContextMissingError';
  }
  await app.close();

  console.log(JSON.stringify({
    models: Object.keys(Prisma.ModelName).length,
    role: rows[0].role,
    orgs,
    refusedWithoutContext: refused,
  }));
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
`;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (path.includes(`${join('src', 'generated')}`)) return [];
    return statSync(path).isDirectory() ? sourceFiles(path) : [path];
  });
}

describe('generated Prisma client under the Nest build (ADR 0009 P14)', () => {
  let db: MigratedDatabase;
  let outDir: string;

  beforeAll(async () => {
    db = await startMigratedDatabase();
    const cache = join(API_ROOT, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    // Inside apps/api, so the compiled files resolve their packages from apps/api/node_modules.
    outDir = mkdtempSync(join(cache, 'db-smoke-'));
  });

  afterAll(async () => {
    if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
    await db?.stop();
  });

  it('NFR-04 builds with tsconfig.build.json and the compiled client, factory and DatabaseModule run on Node', () => {
    const tsc = createRequire(join(API_ROOT, 'package.json')).resolve('typescript/bin/tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json', '--outDir', outDir], {
      cwd: API_ROOT,
      stdio: 'pipe',
    });
    expect(existsSync(join(outDir, 'generated', 'prisma', 'client.js'))).toBe(true);
    // The test helpers (Testcontainers and the like) are not part of the build.
    expect(existsSync(join(outDir, 'database', 'testing'))).toBe(false);
    expect(existsSync(join(outDir, 'database', 'tc-008-org-isolation.spec.js'))).toBe(false);

    const script = join(outDir, 'smoke.js');
    writeFileSync(script, SMOKE_SCRIPT);
    const output = execFileSync(process.execPath, [script], {
      cwd: outDir,
      env: { ...process.env, SMOKE_DATABASE_URL: db.appUserUrl },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(JSON.parse(output.trim().split('\n').pop() ?? '{}')).toEqual({
      models: 32,
      role: 'app_user',
      orgs: 0,
      refusedWithoutContext: true,
    });
  });

  it('NFR-04 only the client factory constructs a PrismaClient (ADR 0009 section 4.2)', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .filter((file) => /new\s+PrismaClient\s*[(<]/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file));
    expect(offenders).toEqual(['database/create-prisma-client.ts']);
  });
});
