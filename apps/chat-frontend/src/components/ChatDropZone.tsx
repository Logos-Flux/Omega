// Drag-and-drop wrapper for the chat surface. Drop files anywhere on
// the chat tab and they upload into the active session — same path as
// the "Add file" button in the drawer's Uploads section.
//
// Two implementation notes worth knowing:
//
//   * Drag events are surprisingly sticky. `dragenter` and `dragleave`
//     fire on every nested child the cursor crosses, so a naive boolean
//     state flickers wildly. We use a `dragenter` counter (the standard
//     pattern) and only consider the cursor "outside" when the counter
//     hits zero.
//
//   * `dragover` MUST `preventDefault` to opt-in to receiving the drop.
//     Without this, the browser opens the file in a new tab. We also
//     prevent default on `drop` itself for the same reason.
//
// The overlay is a single full-bleed div with a dashed border. We
// don't try to highlight the composer specifically — the user
// generally doesn't aim, they just drag a file at the page.

import { useCallback, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Paperclip } from 'lucide-react'
import { useHarnessSession } from '../lib/harness-session'

interface ChatDropZoneProps {
  children: ReactNode
}

export function ChatDropZone({ children }: ChatDropZoneProps) {
  const { uploadFiles, session } = useHarnessSession()
  const [dragActive, setDragActive] = useState(false)
  const dragCounter = useRef(0)

  const onDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounter.current += 1
    if (dragCounter.current === 1) setDragActive(true)
  }, [])

  const onDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounter.current = Math.max(0, dragCounter.current - 1)
    if (dragCounter.current === 0) setDragActive(false)
  }, [])

  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }, [])

  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      dragCounter.current = 0
      setDragActive(false)
      const files = e.dataTransfer.files
      if (!files || files.length === 0) return
      void uploadFiles(files)
    },
    [uploadFiles],
  )

  return (
    <div
      className="relative flex h-full"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {children}
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-t-deep/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-t-accent-alt bg-t-surface/95 px-8 py-6 text-t-bright shadow-xl">
            <Paperclip className="h-6 w-6 text-t-accent-alt" />
            <p className="font-display text-sm">
              {session ? 'Drop to upload to this session' : 'Connect a session before uploading'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
