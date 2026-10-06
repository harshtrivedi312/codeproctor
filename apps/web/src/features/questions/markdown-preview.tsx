import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Headings inside the statement are shown as bold text, not as heading elements: the preview sits
// inside the editor page, and a statement's own h2/h3 would break the page's heading outline.
const Flat = ({ children }: { children?: React.ReactNode }) => (
  <p className="mt-4 text-base font-semibold">{children}</p>
);
// Remote images are not loaded in the preview: a statement could point at a third-party server and
// this page holds private question content (hidden tests, reference solutions) next to it. The alt
// text is shown instead. Links keep react-markdown's default URL filter, which drops `javascript:`.
const Img = ({ alt }: { alt?: string }) => (
  <span className="rounded border border-dashed px-1 text-sm text-muted-foreground">
    [image{alt ? `: ${alt}` : ''} (not loaded in the preview)]
  </span>
);
const COMPONENTS: Components = {
  h1: Flat,
  h2: Flat,
  h3: Flat,
  h4: Flat,
  h5: Flat,
  h6: Flat,
  img: Img,
};

/**
 * Renders a question statement for the author's live preview. Same rule as the candidate screen:
 * react-markdown does not render raw HTML (no rehype-raw), so `<script>` and event handlers in a
 * statement show as plain text and nothing runs.
 */
export function MarkdownPreview({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="space-y-3 text-[15px] leading-7 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
