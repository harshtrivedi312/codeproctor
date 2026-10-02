import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto my-24 max-w-md px-4 text-center">
      <h1 className="text-2xl font-semibold">We could not find that page</h1>
      <p className="mt-2 text-muted-foreground">
        Check the address for typos. If you were sent a test link, open it again from your
        invitation email.
      </p>
      <Link href="/" className="mt-6 inline-block text-primary underline underline-offset-4">
        Go to the home page
      </Link>
    </main>
  );
}
