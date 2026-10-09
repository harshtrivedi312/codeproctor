// Test double for VerifyConditionsPort: the evidence is whatever the test sets.
import {
  VerifyConditionsPort,
  type VerifyCondition,
  type VerifyEvidence,
} from '../verify-conditions.port';

export class InMemoryVerifyConditions extends VerifyConditionsPort {
  unmet: VerifyCondition[] = [];
  /** Optional hook run at the start of every evaluation (to hold a job active in a test). */
  gate: (() => Promise<void>) | undefined;
  calls = 0;

  async evaluate(): Promise<VerifyEvidence> {
    this.calls += 1;
    if (this.gate) await this.gate();
    return { met: this.unmet.length === 0, unmet: [...this.unmet] };
  }
}
