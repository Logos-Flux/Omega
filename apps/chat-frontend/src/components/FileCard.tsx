// Render card for files the agent generated mid-turn — pandoc PDFs,
// pandoc docx, write_file outputs, generated images, etc. Rendered via
// assistant-ui's data-part renderer (`data: { by_name: { file: FileCard } }`);
// the HarnessTransport emits a `data-file` chunk per new upload it detects
// on a `done` frame (see harness-transport.ts).
//
// Images (generate_image output, uploaded pictures) render as an inline
// preview so the user sees the result in-thread, not just a download link.
// Everything else falls back to the download card: file-icon tile
// (color-coded by ext), filename + meta line, "Download" pill button.

import { FileText, Download } from 'lucide-react'
import type { DataMessagePartProps } from '@assistant-ui/react'
import type { GeneratedFileData } from '../lib/harness-transport'
import { fileTypeMeta, formatBytes } from '../lib/harness-utils'
import { cn } from '../lib/cn'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'svg'])

// Small "Download" pill, shared between the image and non-image layouts.
const DownloadPill = ({ data }: { data: GeneratedFileData }) => (
  <a
    href={data.downloadUrl}
    download={data.filename}
    target="_blank"
    rel="noreferrer"
    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-t-border bg-t-surface px-3 py-1.5 font-display text-[11px] uppercase tracking-wider text-t-bright transition-colors hover:border-t-accent-alt hover:bg-t-accent-alt/5 hover:text-t-accent-alt"
  >
    <Download className="h-3.5 w-3.5" aria-hidden="true" />
    Download
  </a>
)

export const FileCard = ({ data }: DataMessagePartProps<GeneratedFileData>) => {
  const ext = (data.filename.split('.').pop() ?? '').toLowerCase()
  const isImage = IMAGE_EXTS.has(ext) || (data.contentType?.startsWith('image/') ?? false)

  // Inline image preview — the downloadUrl is the harness /files URL with the
  // session token baked in, so an <img> loads it directly. Click opens full
  // size in a new tab; the caption keeps the filename + an explicit download.
  if (isImage) {
    return (
      <figure className="my-2 overflow-hidden rounded-lg border border-t-border bg-t-surface">
        <a href={data.downloadUrl} target="_blank" rel="noreferrer" title="Open full size">
          <img
            src={data.downloadUrl}
            alt={data.filename}
            loading="lazy"
            className="block max-h-[28rem] w-full bg-black/20 object-contain"
          />
        </a>
        <figcaption className="flex items-center gap-3 border-t border-t-border p-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-t-bright" title={data.filename}>
              {data.filename}
            </p>
            <p className="font-mono text-[11px] text-t-muted">Image · {formatBytes(data.size)}</p>
          </div>
          <DownloadPill data={data} />
        </figcaption>
      </figure>
    )
  }

  const meta = fileTypeMeta(ext)
  return (
    <div className="my-2 flex items-center gap-3 rounded-lg border border-t-border bg-t-surface p-3 transition-colors hover:border-t-border-active">
      <div className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded', meta.bg)}>
        <FileText className={cn('h-5 w-5', meta.fg)} aria-hidden="true" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-t-bright" title={data.filename}>
          {data.filename}
        </p>
        <p className="font-mono text-[11px] text-t-muted">
          {meta.label} · {formatBytes(data.size)}
        </p>
      </div>
      <DownloadPill data={data} />
    </div>
  )
}
