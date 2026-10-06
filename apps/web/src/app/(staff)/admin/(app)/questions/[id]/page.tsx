import { QuestionEditorRoute } from '@/features/questions/question-pages';

export const metadata = { title: 'Edit question' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <QuestionEditorRoute id={id} />;
}
