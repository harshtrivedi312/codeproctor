import { CandidateFlow } from '@/features/candidate-flow/candidate-flow';

/**
 * The stepper lives on a static path with no token in the route, so Next's route tree and history
 * state never hold one. The token arrives in memory (handed over by /t/[token]) or in the URL
 * fragment (/t/link#<token>), which never reaches the server.
 */
export default function CandidateStepperPage() {
  return <CandidateFlow />;
}
