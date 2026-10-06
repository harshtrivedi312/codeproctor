// CandidateScope (ADR 0013 CS-4, DL-31): the facts are set before ANY other query in a candidate
// scope, the facts are read in a plain org scope that is left first, and nothing is nested.
import { randomUUID } from 'node:crypto';
import { OrgContextService } from '../database/org-context';
import type { PrismaService } from '../database/prisma.service';
import { CandidateScope } from './candidate-scope';

const ORG = randomUUID();
const SID = randomUUID();
const IDS = { candidateId: randomUUID(), invitationId: randomUUID(), testId: randomUUID() };

interface Seen {
  readonly call: string;
  readonly actor: string;
  readonly facts: boolean;
}

function setup(session: { invitationId: string } | null = { invitationId: IDS.invitationId }) {
  const orgContext = new OrgContextService();
  const seen: Seen[] = [];
  const note = (call: string): void => {
    const scope = orgContext.current()?.scope;
    seen.push({
      call,
      actor: scope?.kind === 'org' ? (scope.session?.actor ?? 'ORG') : 'NONE',
      facts: orgContext.candidateFacts() !== undefined,
    });
  };
  const prisma = {
    client: {
      session: {
        findUnique: jest.fn((args: { select: object }) => {
          note(`session ${JSON.stringify(args.select)}`);
          return Promise.resolve(
            'invitationId' in args.select
              ? session
              : { id: SID, status: 'OPENED', authEpoch: 3, pauseReasons: [] },
          );
        }),
      },
      invitation: {
        findUnique: jest.fn((args: { select: object }) => {
          note(`invitation ${JSON.stringify(args.select)}`);
          return Promise.resolve({
            id: IDS.invitationId,
            candidateId: IDS.candidateId,
            testId: IDS.testId,
          });
        }),
      },
    },
  } as unknown as PrismaService;
  return { scope: new CandidateScope(orgContext, prisma), orgContext, prisma, seen };
}

describe('CandidateScope (ADR 0013 CS-4, DL-31, FR-106)', () => {
  it('CS-4 interim: the guard reads the facts in a plain org scope, leaves it, then sets the facts before the first candidate-scope query', async () => {
    const { scope, seen } = setup();
    const session = await scope.authenticate(ORG, SID);
    expect(session).toMatchObject({ status: 'OPENED', authEpoch: 3, ...IDS });
    expect(seen.map((s) => [s.actor, s.facts])).toEqual([
      ['ORG', false],
      ['ORG', false],
      ['CANDIDATE', true],
    ]);
    // Column-only selects: the invitation read never asks for accommodations.
    expect(seen[0]?.call).toBe('session {"invitationId":true}');
    expect(seen[1]?.call).toBe('invitation {"id":true,"candidateId":true,"testId":true}');
    expect(seen[2]?.call).not.toMatch(/invitationId|hmacKeyEnc|deviceInfo/);
  });

  it('CS-4 interim: a session that is not found in the token org is null (401), and no candidate scope is entered', async () => {
    const { scope, seen } = setup(null);
    expect(await scope.authenticate(ORG, SID)).toBeNull();
    expect(seen.map((s) => s.actor)).toEqual(['ORG']);
  });

  it('CS-4 interim: every asCandidate entry sets the facts first, so a second entry in the same request does too', async () => {
    const { scope, prisma, seen } = setup();
    const ids = { orgId: ORG, sessionId: SID, ...IDS };
    for (let i = 0; i < 2; i++) {
      await scope.asCandidate(ids, () =>
        prisma.client.session.findUnique({ where: { id: SID }, select: { id: true } }),
      );
    }
    expect(seen.map((s) => [s.actor, s.facts])).toEqual([
      ['CANDIDATE', true],
      ['CANDIDATE', true],
    ]);
  });

  it('CS-4 interim: asOrg is a plain org scope, and a candidate scope cannot be entered inside it or inside another', async () => {
    const { scope, orgContext } = setup();
    const ids = { orgId: ORG, sessionId: SID, ...IDS };
    await scope.asOrg(ids, () => {
      expect(orgContext.current()?.scope).toMatchObject({ kind: 'org' });
      expect(() => scope.asCandidate(ids, () => 1)).toThrow();
      return Promise.resolve();
    });
    await scope.asCandidate(ids, () => {
      expect(() => scope.asCandidate(ids, () => 1)).toThrow();
      return Promise.resolve();
    });
  });

  it('CS-4 interim: outside a scope a handler can query nothing (fails closed)', () => {
    const { orgContext } = setup();
    expect(orgContext.current()?.scope).toBeUndefined();
  });
});
