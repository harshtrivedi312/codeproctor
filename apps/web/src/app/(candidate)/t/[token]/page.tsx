import { CandidateFlow } from '@/features/candidate-flow/candidate-flow';

export const metadata = { title: 'Your test' };

/**
 * FR-401 to FR-403 pre-test stepper. The token in the path is read once on the client and then
 * removed from the address bar (see CandidateFlow); it is never logged here.
 */
export default async function CandidatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <CandidateFlow token={token} />;
}
