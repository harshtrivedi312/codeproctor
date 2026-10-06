import { notFound } from 'next/navigation';
import { QuestionVersionRoute } from '@/features/questions/question-pages';

export const metadata = { title: 'Question version' };

export default async function Page({
  params,
}: {
  params: Promise<{ id: string; version: string }>;
}) {
  const { id, version } = await params;
  const n = Number(version);
  if (!Number.isInteger(n) || n < 1) notFound();
  return <QuestionVersionRoute id={id} version={n} />;
}
