import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown'
import remarkGfm from 'remark-gfm'

export function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      className="aui-md leading-relaxed text-t-bright"
      components={{
        h1: ({ className, ...props }) => (
          <h1
            className={`mt-6 mb-3 text-2xl font-display font-semibold text-t-bright ${className ?? ''}`}
            {...props}
          />
        ),
        h2: ({ className, ...props }) => (
          <h2
            className={`mt-5 mb-2 text-xl font-display font-semibold text-t-bright border-b border-t-border pb-1 ${className ?? ''}`}
            {...props}
          />
        ),
        h3: ({ className, ...props }) => (
          <h3
            className={`mt-4 mb-2 text-base font-display font-semibold text-t-bright ${className ?? ''}`}
            {...props}
          />
        ),
        p: ({ className, ...props }) => (
          <p className={`my-3 ${className ?? ''}`} {...props} />
        ),
        a: ({ className, ...props }) => (
          <a
            className={`text-t-accent underline underline-offset-2 hover:text-t-accent-alt transition-colors ${className ?? ''}`}
            {...props}
          />
        ),
        ul: ({ className, ...props }) => (
          <ul className={`my-3 list-disc pl-6 space-y-1 ${className ?? ''}`} {...props} />
        ),
        ol: ({ className, ...props }) => (
          <ol className={`my-3 list-decimal pl-6 space-y-1 ${className ?? ''}`} {...props} />
        ),
        blockquote: ({ className, ...props }) => (
          <blockquote
            className={`my-3 border-l-2 border-t-accent pl-4 text-t-muted italic ${className ?? ''}`}
            {...props}
          />
        ),
        code: ({ className, ...props }) => (
          <code
            className={`rounded bg-t-hover px-1.5 py-0.5 font-mono text-[0.85em] text-t-bright ${className ?? ''}`}
            {...props}
          />
        ),
        pre: ({ className, ...props }) => (
          <pre
            className={`my-3 overflow-x-auto rounded border border-t-border bg-t-deep p-3 font-mono text-sm ${className ?? ''}`}
            {...props}
          />
        ),
        table: ({ className, ...props }) => (
          <div className="my-3 overflow-x-auto">
            <table
              className={`w-full border-collapse text-sm ${className ?? ''}`}
              {...props}
            />
          </div>
        ),
        th: ({ className, ...props }) => (
          <th
            className={`border border-t-border bg-t-hover px-3 py-1.5 text-left font-semibold text-t-bright ${className ?? ''}`}
            {...props}
          />
        ),
        td: ({ className, ...props }) => (
          <td className={`border border-t-border px-3 py-1.5 ${className ?? ''}`} {...props} />
        ),
        hr: ({ className, ...props }) => (
          <hr className={`my-5 border-t border-t-border ${className ?? ''}`} {...props} />
        ),
      }}
    />
  )
}
