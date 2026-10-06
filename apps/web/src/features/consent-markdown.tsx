import * as React from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders the consent document from API-provided markdown, safely:
 * - react-markdown never renders raw HTML, and `skipHtml` drops it instead of echoing it;
 * - images are not rendered (no remote requests from a legal text);
 * - links are limited to http, https and mailto, open without a Referer and without opener access;
 * - headings are demoted one level, because the step title is the page's h1.
 */
const SAFE_URL = /^(https?:|mailto:|\/(?!\/))/i;

export function safeUrl(url: string): string {
  return SAFE_URL.test(url.trim()) ? url : '';
}

const components: Components = {
  h1: (p) => <h2 className="mt-6 text-xl font-semibold">{p.children}</h2>,
  h2: (p) => <h3 className="mt-6 text-lg font-semibold">{p.children}</h3>,
  h3: (p) => <h4 className="mt-4 text-base font-semibold">{p.children}</h4>,
  h4: (p) => <h5 className="mt-3 text-base font-semibold">{p.children}</h5>,
  p: (p) => <p className="mt-3">{p.children}</p>,
  ul: (p) => <ul className="mt-3 list-disc space-y-1 pl-6">{p.children}</ul>,
  ol: (p) => <ol className="mt-3 list-decimal space-y-1 pl-6">{p.children}</ol>,
  a: ({ href, children }) =>
    href ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow"
        referrerPolicy="no-referrer"
        className="underline underline-offset-4"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: () => null,
};

export function ConsentMarkdown({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="text-[15px] leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={safeUrl}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
