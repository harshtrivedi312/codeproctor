import { notFound } from 'next/navigation';

const MESSAGES: Record<string, { title: string; body: string }> = {
  expired: {
    title: 'This test link has expired',
    body: 'The window for this test has closed. Contact the person who invited you to ask for a new link.',
  },
  used: {
    title: 'This test link was already used',
    body: 'A test can only be taken once. If you think this is a mistake, contact the person who invited you.',
  },
  forbidden: {
    title: 'You do not have access to this page',
    body: 'Ask a Super Admin to give your account the right role, or sign in with a different account.',
  },
};

export default async function ErrorKindPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const message = MESSAGES[kind];
  if (!message) notFound();
  return (
    <main id="main" className="mx-auto my-24 max-w-md px-4 text-center">
      <h1 className="text-2xl font-semibold">{message.title}</h1>
      <p className="mt-2 text-muted-foreground">{message.body}</p>
    </main>
  );
}
