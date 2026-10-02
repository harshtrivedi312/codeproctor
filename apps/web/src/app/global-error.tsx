'use client';

// Last-resort boundary when the root layout itself fails. Plain markup: no providers available.
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <html lang="en">
      <body
        style={{ fontFamily: 'system-ui, sans-serif', padding: '4rem 1rem', textAlign: 'center' }}
      >
        <main id="main">
          <h1>Something went wrong</h1>
          <p>Reload the page. If it keeps happening, contact the person who invited you.</p>
          <button onClick={reset}>Try again</button>
        </main>
      </body>
    </html>
  );
}
