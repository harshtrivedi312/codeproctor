import { TestRoute } from '@/features/tests/test-pages';

export const metadata = { title: 'Test' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TestRoute id={id} />;
}
