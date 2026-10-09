import { EmailLinkEntry } from '@/features/candidate-flow/token-handoff';

/**
 * Entry for the link in the invitation email: `${WEB_ORIGIN}/t#<token>` (FR-407). The token is in
 * the fragment, so it never reaches the server, a log or a Referer. The page forwards to
 * /t/start#<token> with a full document load (see EmailLinkEntry for why).
 */
export default function CandidateEmailLinkEntry() {
  return <EmailLinkEntry />;
}
