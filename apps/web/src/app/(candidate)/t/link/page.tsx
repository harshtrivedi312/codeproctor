import { CandidateFlow } from '@/features/candidate-flow/candidate-flow';

/**
 * The stepper lives on a static path with no token in the route. The token reaches it in memory,
 * handed over by /t/[token] or /t/start#<token>. It never takes a token or a fragment itself.
 */
export default function CandidateStepperPage() {
  return <CandidateFlow />;
}
