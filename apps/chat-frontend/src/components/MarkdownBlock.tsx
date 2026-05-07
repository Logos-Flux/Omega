import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// Renders the harness's plain-markdown response with the project's design
// tokens. Used by the DemoPage assistant bubbles. Kept separate from
// `MarkdownText` (which is wired into assistant-ui's Message primitive
// and unavailable outside that context) so the demo runtime can stay
// assistant-ui-free.
export function MarkdownBlock({ children }: { children: string }) {
  return (
    <div className="markdown-block text-sm text-t-bright">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="my-2 leading-relaxed first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => (
            <h1 className="mb-2 mt-4 font-display text-lg font-semibold text-t-bright first:mt-0">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-4 font-display text-base font-semibold text-t-bright first:mt-0">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-1 mt-3 font-display text-sm font-semibold uppercase tracking-wide text-t-accent first:mt-0">
              {children}
            </h3>
          ),
          h4: ({ children }) => (
            <h4 className="mb-1 mt-2 font-display text-xs font-semibold uppercase tracking-wide text-t-muted first:mt-0">
              {children}
            </h4>
          ),
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-t-accent underline decoration-t-accent/40 underline-offset-2 hover:decoration-t-accent"
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-semibold text-t-bright">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-t-accent-alt/50 pl-3 italic text-t-muted">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-3 border-t-border" />,
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? '')
            if (isBlock) {
              return (
                <code className={`block whitespace-pre overflow-x-auto rounded bg-t-bright px-3 py-2 font-mono text-[12px] leading-relaxed text-white ${className ?? ''}`}>
                  {children}
                </code>
              )
            }
            return (
              <code className="rounded bg-t-hover px-1 py-0.5 font-mono text-[12px] text-t-bright">
                {children}
              </code>
            )
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded bg-t-bright p-3 font-mono text-[12px] text-white">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-t-hover">{children}</thead>,
          th: ({ children, style }) => (
            <th
              style={style}
              className="border border-t-border px-2 py-1 text-left font-display text-[11px] uppercase tracking-wide text-t-accent"
            >
              {children}
            </th>
          ),
          td: ({ children, style }) => (
            <td style={style} className="border border-t-border px-2 py-1 align-top">
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
