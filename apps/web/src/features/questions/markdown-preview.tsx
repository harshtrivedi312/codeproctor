import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Renders a question statement for the author's live preview. Same rule as the candidate screen:
 * react-markdown does not render raw HTML (no rehype-raw), so `<script>` and event handlers in a
 * statement show as plain text and nothing runs.
 */
export function MarkdownPreview({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="space-y-3 text-[15px] leading-7 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px] [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
