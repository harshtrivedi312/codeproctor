import {
  aiPolicyFromSettings,
  aiReferenceProblems,
  DEFAULT_MIN_ASSISTANTS,
  minAssistantsFromSettings,
} from './ai-reference-rules';

const rows = (...r: [string, string][]): { language: string; assistant: string }[] =>
  r.map(([language, assistant]) => ({ language, assistant }));

describe('FR-202 AI reference publish gate (ADR 0005 AI-5)', () => {
  it('reads aiReferences.minAssistants and defaults to 2, also for malformed values (fail closed)', () => {
    expect(minAssistantsFromSettings({})).toBe(DEFAULT_MIN_ASSISTANTS);
    expect(minAssistantsFromSettings(null)).toBe(2);
    expect(minAssistantsFromSettings({ aiReferences: { minAssistants: 0 } })).toBe(0);
    expect(minAssistantsFromSettings({ aiReferences: { minAssistants: 3 } })).toBe(3);
    for (const bad of [-1, 1.5, '2', 6, 10, 11, 1e21, '3', [], true, null, {}]) {
      expect(minAssistantsFromSettings({ aiReferences: { minAssistants: bad } })).toBe(2);
    }
  });

  it('needs distinct assistants per allowed language (case and spacing do not make two)', () => {
    const problems = aiReferenceProblems(
      ['python', 'javascript'],
      rows(
        ['python', 'ChatGPT'],
        ['python', ' chatgpt '],
        ['javascript', 'ChatGPT'],
        ['javascript', 'Claude'],
      ),
      2,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(
      /^aiReferences\.python: .*at least 2 distinct assistants \(has 1\)/,
    );
  });

  it('ignores languages the question does not allow, and min 0 turns the gate off', () => {
    expect(aiReferenceProblems(['java'], rows(['python', 'A'], ['python', 'B']), 2)).toHaveLength(
      1,
    );
    expect(aiReferenceProblems(['java'], [], 0)).toEqual([]);
    expect(aiReferenceProblems(['python'], rows(['python', 'A'], ['python', 'B']), 2)).toEqual([]);
  });
});

describe('aiPolicyFromSettings (FR-203, ADR 0005 AI-5)', () => {
  it('marks the fallback as default and a stored value, even 2, as configured', () => {
    expect(aiPolicyFromSettings({})).toEqual({ minAssistants: 2, isDefault: true });
    expect(aiPolicyFromSettings({ aiReferences: { minAssistants: 99 } }).isDefault).toBe(true);
    expect(aiPolicyFromSettings({ aiReferences: { minAssistants: 2 } }).isDefault).toBe(false);
    expect(aiPolicyFromSettings({ aiReferences: { minAssistants: 0 } })).toEqual({
      minAssistants: 0,
      isDefault: false,
    });
  });
});
