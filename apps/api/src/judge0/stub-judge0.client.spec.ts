import { JUDGE0_STATUS } from './judge0.types';
import type { Judge0Submission } from './judge0.types';
import { STUB_LABEL, StubJudge0Client } from './stub-judge0.client';

const sub = (sourceCode: string): Judge0Submission => ({
  languageId: 71,
  sourceCode,
  stdin: '1 2',
  limits: { cpuMs: 1000, wallMs: 2000, memoryKb: 65536 },
  maxOutputBytes: 1024,
});

describe('DL-56 StubJudge0Client', () => {
  it('DL-56: label is exactly "local stub, not real execution"', () => {
    expect(STUB_LABEL).toBe('local stub, not real execution');
  });

  it('DL-56/FR-503: every result carries the label and never reads as accepted', async () => {
    const results = await new StubJudge0Client().runBatch([
      sub('print(1)'),
      sub('syntax error'),
      sub(''),
    ]);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect(r.message).toBe(STUB_LABEL);
      expect(r.stderr).toBe(STUB_LABEL);
      expect(r.statusId).toBe(JUDGE0_STATUS.INTERNAL_ERROR);
      expect(r.statusId).not.toBe(JUDGE0_STATUS.ACCEPTED);
      expect(r.stdout).toBe('');
    }
  });

  it('DL-56: deterministic and independent of the candidate source', async () => {
    const stub = new StubJudge0Client();
    const [a] = await stub.runBatch([sub('print(1)')]);
    const [b] = await stub.runBatch([sub('something else entirely')]);
    expect(a).toEqual(b);
  });
});
