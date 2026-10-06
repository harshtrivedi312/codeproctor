import { TokenHandoff } from '@/features/candidate-flow/token-handoff';

/**
 * Thin entry for links shaped /t/<token>. It renders no props from the server: the client reads the
 * segment, moves the token into memory and replaces the URL with /t/link (see TokenHandoff).
 */
export default function CandidateTokenEntry() {
  return <TokenHandoff />;
}
