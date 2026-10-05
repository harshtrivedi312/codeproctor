// The seeded multiple-choice question, short-answer question and placeholder consent text.
// `answer_spec` shapes follow ADR 0007 sections 5 and 10 (D-23). packages/shared will hold the zod
// union; until then these shapes are provisional.

export interface NonCodingQuestionSpec {
  readonly slug: string;
  readonly type: 'MCQ' | 'SHORT_ANSWER';
  readonly title: string;
  readonly statementMd: string;
  readonly tags: readonly string[];
  readonly answerSpec: Record<string, unknown>;
}

export const mcqQuestion: NonCodingQuestionSpec = {
  slug: 'mcq-first-step-slow-lookup',
  type: 'MCQ',
  title: 'First Step for a Slow Lookup',
  statementMd: `# First Step for a Slow Lookup

A table holds several million rows. It is read far more often than it is written. A frequent query filters on the \`account_email\` column, whose values are nearly unique. The column has no index and the query is slow.

Which change is the most appropriate **first** step?
`,
  tags: ['databases'],
  answerSpec: {
    options: [
      { id: 'a', text: 'Add a B-tree index on `account_email`.' },
      { id: 'b', text: 'Split the table into one table for each email domain.' },
      { id: 'c', text: 'Load every row into application memory at start-up.' },
      { id: 'd', text: 'Keep a second copy of the table and send half of the queries to it.' },
    ],
    correctOptionIds: ['a'],
    multiple: false,
  },
};

export const shortAnswerQuestion: NonCodingQuestionSpec = {
  slug: 'short-forbidden-status-code',
  type: 'SHORT_ANSWER',
  title: 'Status Code for a Forbidden Request',
  statementMd: `# Status Code for a Forbidden Request

A caller has sent a valid credential, but the server refuses the request because this caller is not allowed to use the resource.

Which HTTP status code does the server normally return? Give the number and its reason phrase.
`,
  tags: ['http'],
  answerSpec: {
    canonical: '403 Forbidden',
    acceptedVariants: ['403', 'HTTP 403', 'HTTP 403 Forbidden', 'Forbidden'],
  },
};

export const CONSENT_PLACEHOLDER_PREFIX = 'PLACEHOLDER - NOT APPROVED BY LEGAL';

// ADR 0007 section 10 (D-17): what is recorded, ID image and selfie, face matching, automated
// detection and human review, use in hiring, retention and deletion, who can access the data,
// appeals, accommodations and how to withdraw. Every section is a stand-in for Legal's text.
export const CONSENT_BODY_MD = `${CONSENT_PLACEHOLDER_PREFIX}

This is a stand-in for the consent document. Legal has not reviewed or approved it. It must never be shown to real candidates. Pilot and production refuse to serve it while REQUIRE_LEGAL_APPROVED_CONSENT is true.

## What is recorded

[Placeholder] Screen, webcam, microphone and keystrokes during the test.

## Identity check

[Placeholder] A photo of an identity document and a live selfie are taken, and a face-match score is stored. No face embedding is kept.

## Automated detection and human review

[Placeholder] Software flags unusual events. A person reviews every flag before a verdict is set. A flag alone never rejects a candidate.

## How results are used in hiring

[Placeholder] Describe how the score and the review outcome inform the hiring decision.

## Retention and deletion

[Placeholder] State the retention period and how a candidate can ask for deletion.

## Who can access the data

[Placeholder] List the roles that can see recordings and results.

## Appeals

[Placeholder] A candidate can appeal a violation verdict within 7 days.

## Accommodations

[Placeholder] How to ask for extra time or to switch off a detector.

## How to withdraw

[Placeholder] Declining before the test starts ends the session and records nothing.
`;
