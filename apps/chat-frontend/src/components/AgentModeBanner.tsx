// Top-of-thread banner shown when Agent Mode is on. Lives at this layer
// (above <Thread />) so the same assistant-ui surface serves both modes
// — the only mode-specific visual today is this banner.

import { brand } from '../lib/brand'

export function AgentModeBanner() {
  return (
    <div
      className="border-b border-t-accent-alt/30 bg-t-accent-alt/5 px-4 py-2 text-center text-[14px] italic tracking-normal text-t-accent-alt"
      style={{ fontFamily: '"Playfair Display", Georgia, serif' }}
    >
      Agent Mode {brand.glyph} ~~ backed by π
    </div>
  )
}
