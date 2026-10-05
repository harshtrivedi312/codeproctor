// Foundation and content rows of the seed (DB-04): organization, staff, refresh tokens, the
// placeholder consent text, 6 coding questions, 1 MCQ, 1 short-answer question, and 2 tests.
// A pure function of `now`; every row has a stable id from ids.ts. Staff password hashes are added
// by the applier, because hashing is asynchronous and salted.
import type { Prisma } from '../../apps/api/src/generated/prisma/client';
import { ID, unusableTokenHash } from './ids';
import { CONSENT_BODY_MD, mcqQuestion, shortAnswerQuestion } from './non-coding';
import { codingQuestions } from './questions';
import { renderTemplate } from './mustache';
import { defaultSlots, resolveSlots } from './variants';
import { LANGUAGES } from './types';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type StaffRole = 'SUPER_ADMIN' | 'RECRUITER' | 'AUTHOR' | 'REVIEWER';

export interface StaffSeed {
  readonly id: string;
  readonly role: StaffRole;
  readonly email: string;
  readonly fullName: string;
}

/** One per role, in role order. The applier gives each the development password (Q-28). */
export const STAFF: readonly StaffSeed[] = [
  {
    id: ID.user('super-admin'),
    role: 'SUPER_ADMIN',
    email: 'admin@demo-corp.example',
    fullName: 'Morgan Rivera',
  },
  {
    id: ID.user('recruiter'),
    role: 'RECRUITER',
    email: 'recruiter@demo-corp.example',
    fullName: 'Riley Chen',
  },
  {
    id: ID.user('author'),
    role: 'AUTHOR',
    email: 'author@demo-corp.example',
    fullName: 'Jordan Okafor',
  },
  {
    id: ID.user('reviewer'),
    role: 'REVIEWER',
    email: 'reviewer@demo-corp.example',
    fullName: 'Taylor Novak',
  },
];

const ASSISTANTS = [
  { key: 'assistantA', name: 'Synthetic Assistant A (seed data)', model: 'synthetic-seed-model-a' },
  { key: 'assistantB', name: 'Synthetic Assistant B (seed data)', model: 'synthetic-seed-model-b' },
] as const;

const AI_PROMPT_NOTE =
  'SYNTHETIC SEED DATA: this row was written for the development seed. It was not produced by any AI assistant.';

/** random_rule shape for the senior test. Provisional: BE-06 defines the zod schema. */
export interface RandomRule {
  readonly count: number;
  readonly difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  readonly tags?: readonly string[];
}

export interface TestKeys {
  readonly backend: string;
  readonly senior: string;
}
export const TEST_KEYS: TestKeys = {
  backend: 'backend-engineer-screen',
  senior: 'senior-engineer-screen',
};

/** What the delivery plan needs to know about a seeded question. */
export interface QuestionInfo {
  readonly slug: string;
  readonly type: 'CODING' | 'MCQ' | 'SHORT_ANSWER';
  readonly versionId: string;
  readonly variantIds: readonly string[];
  readonly testCaseIds: readonly string[];
}

export interface ContentPlan {
  readonly organization: Prisma.OrganizationCreateManyInput;
  readonly consentText: Prisma.ConsentTextCreateManyInput;
  readonly staff: readonly StaffSeed[];
  readonly refreshTokens: Prisma.RefreshTokenCreateManyInput[];
  readonly questions: Prisma.QuestionCreateManyInput[];
  readonly questionVersions: Prisma.QuestionVersionCreateManyInput[];
  readonly testCases: Prisma.TestCaseCreateManyInput[];
  readonly questionVariants: Prisma.QuestionVariantCreateManyInput[];
  readonly variantTestCases: Prisma.VariantTestCaseCreateManyInput[];
  readonly aiReferenceSolutions: Prisma.AiReferenceSolutionCreateManyInput[];
  readonly tests: Prisma.TestCreateManyInput[];
  readonly testSections: Prisma.TestSectionCreateManyInput[];
  readonly testQuestions: Prisma.TestQuestionCreateManyInput[];
  readonly questionInfo: ReadonlyMap<string, QuestionInfo>;
}

export function buildContent(now: Date): ContentPlan {
  const at = (offsetMs: number): Date => new Date(now.getTime() + offsetMs);

  const organization: Prisma.OrganizationCreateManyInput = {
    id: ID.org,
    name: 'Demo Corp',
    retentionDays: 90,
    // Keys named in ADR 0007 section 6; everything else takes its default.
    settings: {
      erasure: { holdWhileReviewOrAppealOpen: true },
      maxProctorPauseMinutes: 30,
      aiReferences: { refreshDays: 90, minAssistants: 2 },
      consentDeclineContact: 'talent@demo-corp.example',
    },
  };

  const consentText: Prisma.ConsentTextCreateManyInput = {
    id: ID.consentText,
    orgId: ID.org,
    version: '0.1-placeholder',
    bodyMd: CONSENT_BODY_MD,
    legalApprovedAt: null,
    legalApprovedBy: null,
    createdById: ID.user('super-admin'),
  };

  // Refresh tokens: two families. The recruiter's first token was rotated (revoked, replaced by the
  // second); the reviewer has one live token. No raw token exists for any of them.
  const recruiterFamily = ID.refreshFamily('recruiter-login-1');
  const reviewerFamily = ID.refreshFamily('reviewer-login-1');
  const refreshTokens: Prisma.RefreshTokenCreateManyInput[] = [
    {
      id: ID.refreshToken('recruiter-2'),
      userId: ID.user('recruiter'),
      familyId: recruiterFamily,
      tokenHash: unusableTokenHash('refresh-token:recruiter-2'),
      expiresAt: at(7 * DAY_MS - HOUR_MS),
      createdAt: at(-HOUR_MS),
    },
    {
      id: ID.refreshToken('recruiter-1'),
      userId: ID.user('recruiter'),
      familyId: recruiterFamily,
      tokenHash: unusableTokenHash('refresh-token:recruiter-1'),
      expiresAt: at(7 * DAY_MS - 2 * HOUR_MS),
      revokedAt: at(-HOUR_MS),
      replacedById: ID.refreshToken('recruiter-2'),
      createdAt: at(-2 * HOUR_MS),
    },
    {
      id: ID.refreshToken('reviewer-1'),
      userId: ID.user('reviewer'),
      familyId: reviewerFamily,
      tokenHash: unusableTokenHash('refresh-token:reviewer-1'),
      expiresAt: at(7 * DAY_MS - HOUR_MS / 2),
      createdAt: at(-HOUR_MS / 2),
    },
  ];

  const questions: Prisma.QuestionCreateManyInput[] = [];
  const questionVersions: Prisma.QuestionVersionCreateManyInput[] = [];
  const testCases: Prisma.TestCaseCreateManyInput[] = [];
  const questionVariants: Prisma.QuestionVariantCreateManyInput[] = [];
  const variantTestCases: Prisma.VariantTestCaseCreateManyInput[] = [];
  const aiReferenceSolutions: Prisma.AiReferenceSolutionCreateManyInput[] = [];
  const questionInfo = new Map<string, QuestionInfo>();
  const author = ID.user('author');

  for (const spec of codingQuestions) {
    const questionId = ID.question(spec.slug);
    const versionId = ID.questionVersion(spec.slug);
    questions.push({
      id: questionId,
      orgId: ID.org,
      slug: spec.slug,
      type: 'CODING',
      tags: [...spec.tags],
      createdById: author,
    });

    // Published but not yet validated: validated_at stays NULL until BE-05 runs the validation
    // over these reference solutions (build plan, DB-04 note).
    questionVersions.push({
      id: versionId,
      questionId,
      version: 1,
      title: spec.title,
      statementMd: spec.statementTemplate,
      difficulty: spec.difficulty,
      allowedLanguages: [...LANGUAGES],
      limits: { cpu_ms: 2000, wall_ms: 5000, memory_kb: 262144 },
      starterCode: { ...spec.starterTemplates },
      referenceSolution: { ...spec.referenceTemplates },
      isPublished: true,
    });

    const defaults = defaultSlots(spec);
    const testCaseIds = defaults.map((slot) => ID.testCase(spec.slug, slot.index));
    for (const slot of defaults) {
      testCases.push({
        id: ID.testCase(spec.slug, slot.index),
        questionVersionId: versionId,
        input: slot.input,
        expectedOutput: slot.expectedOutput,
        isHidden: slot.hidden,
        weight: slot.weight.toFixed(2),
        position: slot.index + 1,
      });
    }

    const variantIds = spec.variants.map((_, index) => ID.variant(spec.slug, index));
    spec.variants.forEach((variant, variantIndex) => {
      const variantId = variantIds[variantIndex] as string;
      questionVariants.push({
        id: variantId,
        questionVersionId: versionId,
        params: { ...variant.params },
        renderedStatement: renderTemplate(spec.statementTemplate, variant.params),
      });
      // Per-variant test data (ADR 0007 V-1): a row only where the variant's input or expected
      // output differs from the slot's default.
      for (const slot of resolveSlots(spec, variantIndex)) {
        const fallback = defaults[slot.index];
        if (
          fallback !== undefined &&
          (slot.input !== fallback.input || slot.expectedOutput !== fallback.expectedOutput)
        ) {
          variantTestCases.push({
            variantId,
            testCaseId: ID.testCase(spec.slug, slot.index),
            input: slot.input,
            expectedOutput: slot.expectedOutput,
          });
        }
      }
    });

    // Six synthetic AI reference rows for the base statement: 2 assistants x 3 languages.
    for (const assistant of ASSISTANTS) {
      for (const language of LANGUAGES) {
        aiReferenceSolutions.push({
          id: ID.aiReference(spec.slug, assistant.key, language),
          questionVersionId: versionId,
          variantId: null,
          assistant: assistant.name,
          modelLabel: assistant.model,
          language,
          solutionCode: spec.aiSolutions[assistant.key][language],
          promptText: AI_PROMPT_NOTE,
          collectedAt: at(-7 * DAY_MS),
          collectedById: author,
        });
      }
    }

    questionInfo.set(spec.slug, {
      slug: spec.slug,
      type: 'CODING',
      versionId,
      variantIds,
      testCaseIds,
    });
  }

  for (const spec of [mcqQuestion, shortAnswerQuestion]) {
    const versionId = ID.questionVersion(spec.slug);
    questions.push({
      id: ID.question(spec.slug),
      orgId: ID.org,
      slug: spec.slug,
      type: spec.type,
      tags: [...spec.tags],
      createdById: author,
    });
    questionVersions.push({
      id: versionId,
      questionId: ID.question(spec.slug),
      version: 1,
      title: spec.title,
      statementMd: spec.statementMd,
      difficulty: 'EASY',
      allowedLanguages: [],
      answerSpec: spec.answerSpec as Prisma.InputJsonObject,
      isPublished: true,
    });
    questionInfo.set(spec.slug, {
      slug: spec.slug,
      type: spec.type,
      versionId,
      variantIds: [],
      testCaseIds: [],
    });
  }

  const versionOf = (slug: string): string => {
    const info = questionInfo.get(slug);
    if (info === undefined) throw new Error(`Unknown question ${slug}.`);
    return info.versionId;
  };

  const recruiter = ID.user('recruiter');
  const tests: Prisma.TestCreateManyInput[] = [
    {
      id: ID.test(TEST_KEYS.backend),
      orgId: ID.org,
      name: 'Backend Engineer Screen',
      description:
        'Two timed sections: a 20-minute warm-up, then problem solving. STANDARD proctoring.',
      durationMinutes: 60,
      profile: 'STANDARD',
      passScore: '60.00',
      createdById: recruiter,
    },
    {
      id: ID.test(TEST_KEYS.senior),
      orgId: ID.org,
      name: 'Senior Engineer Screen',
      description:
        'Questions are drawn at random by difficulty and tag at the start of each session. STRICT proctoring.',
      durationMinutes: 90,
      profile: 'STRICT',
      passScore: '70.00',
      createdById: recruiter,
    },
  ];

  const section = (
    testKey: string,
    position: number,
    title: string,
    timeLimitMin: number | null,
  ) => ({
    id: ID.testSection(testKey, position),
    testId: ID.test(testKey),
    title,
    position,
    timeLimitMin,
  });
  const testSections: Prisma.TestSectionCreateManyInput[] = [
    section(TEST_KEYS.backend, 1, 'Warm-up', 20),
    section(TEST_KEYS.backend, 2, 'Problem solving', null),
    section(TEST_KEYS.senior, 1, 'Warm-up', 15),
    section(TEST_KEYS.senior, 2, 'Core problem solving', 45),
    section(TEST_KEYS.senior, 3, 'Stretch', null),
  ];

  const fixed = (
    testKey: string,
    sectionPosition: number,
    position: number,
    slug: string,
    points: number,
  ) => ({
    id: ID.testQuestion(testKey, sectionPosition, position),
    sectionId: ID.testSection(testKey, sectionPosition),
    questionVersionId: versionOf(slug),
    points: points.toFixed(2),
    position,
  });
  const random = (testKey: string, sectionPosition: number, rule: RandomRule, points: number) => ({
    id: ID.testQuestion(testKey, sectionPosition, 1),
    sectionId: ID.testSection(testKey, sectionPosition),
    randomRule: { ...rule, ...(rule.tags === undefined ? {} : { tags: [...rule.tags] }) },
    points: points.toFixed(2),
    position: 1,
  });
  const testQuestions: Prisma.TestQuestionCreateManyInput[] = [
    fixed(TEST_KEYS.backend, 1, 1, 'parcel-surcharge', 15),
    fixed(TEST_KEYS.backend, 1, 2, 'sensor-bursts', 15),
    fixed(TEST_KEYS.backend, 1, 3, mcqQuestion.slug, 10),
    fixed(TEST_KEYS.backend, 1, 4, shortAnswerQuestion.slug, 10),
    fixed(TEST_KEYS.backend, 2, 1, 'steady-stretch', 25),
    fixed(TEST_KEYS.backend, 2, 2, 'stock-rebalance', 25),
    random(TEST_KEYS.senior, 1, { count: 1, difficulty: 'EASY' }, 10),
    random(TEST_KEYS.senior, 2, { count: 2, difficulty: 'MEDIUM', tags: ['arrays'] }, 30),
    random(TEST_KEYS.senior, 3, { count: 1, difficulty: 'HARD' }, 30),
  ];

  return {
    organization,
    consentText,
    staff: STAFF,
    refreshTokens,
    questions,
    questionVersions,
    testCases,
    questionVariants,
    variantTestCases,
    aiReferenceSolutions,
    tests,
    testSections,
    testQuestions,
    questionInfo,
  };
}
