// Test case data of one question for one session: the base case, overridden by the variant's own
// row when there is one (variant_test_cases, ADR 0007). Runs inside an org scope the caller opened.
// Sample cases (is_hidden = false) go to Run; hidden cases only to grading, and never leave the API.
import type { PrismaService } from '../database/prisma.service';
import { toHundredths } from './scoring';

export interface CaseData {
  readonly id: string;
  readonly input: string;
  readonly expectedOutput: string;
  /** Weight in hundredths. */
  readonly weight: bigint;
}

type Db = PrismaService['client'];

export async function loadCases(
  db: Db,
  questionVersionId: string,
  variantId: string | null,
  hidden: boolean,
): Promise<CaseData[]> {
  const cases = await db.testCase.findMany({
    where: { questionVersionId, isHidden: hidden },
    orderBy: { position: 'asc' },
    select: { id: true, input: true, expectedOutput: true, weight: true },
  });
  if (cases.length === 0) return [];
  const overrides =
    variantId === null
      ? []
      : await db.variantTestCase.findMany({
          where: { variantId, testCaseId: { in: cases.map((c) => c.id) } },
          select: { testCaseId: true, input: true, expectedOutput: true },
        });
  const byCase = new Map(overrides.map((o) => [o.testCaseId, o]));
  return cases.map((c) => {
    const o = byCase.get(c.id);
    return {
      id: c.id,
      input: o?.input ?? c.input,
      expectedOutput: o?.expectedOutput ?? c.expectedOutput,
      weight: toHundredths(c.weight.toFixed(2)),
    };
  });
}
