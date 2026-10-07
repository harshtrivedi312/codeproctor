import { ReviewSessionPage } from '@/features/review/review-session-page';

export const metadata = { title: 'Review session' };

export default async function Page({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <ReviewSessionPage sessionId={sessionId} />;
}
