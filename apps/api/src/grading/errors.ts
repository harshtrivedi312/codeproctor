/** A state that grading must not paper over (a missing snapshot, no hidden tests, bad data). */
export class GradingInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GradingInvariantError';
  }
}

/**
 * The code runner was unreachable or failed while grading. A platform outage, not a data error:
 * the job is retried and does not count toward the per-session give-up budget (a runbook item).
 */
export class RunnerUnavailableError extends Error {
  constructor() {
    super('The code runner failed while grading');
    this.name = 'RunnerUnavailableError';
  }
}
