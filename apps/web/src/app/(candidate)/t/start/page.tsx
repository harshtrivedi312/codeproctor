import { FragmentHandoff } from '@/features/candidate-flow/token-handoff';

/**
 * Entry for links shaped /t/start#<token> (the fragment never reaches the server or its logs).
 * The client moves the token into memory and replaces the route with /t/link.
 */
export default function CandidateFragmentEntry() {
  return <FragmentHandoff />;
}
