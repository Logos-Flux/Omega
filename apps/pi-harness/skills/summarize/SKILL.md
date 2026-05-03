---
name: summarize
description: Produce a tight bullet-point summary of a long block of text. Activate when the user pastes an article, transcript, doc, or asks "tl;dr / summarize this".
---

# Summarize skill

Produce a summary the reader can act on, not a précis.

## Output protocol

```
**TL;DR.** One sentence — the single most important takeaway.

**Key points.**
- 3 to 7 bullets, each one *thing the reader needs to know*, not "the article discusses..."
- Each bullet is a complete claim with whatever number/name/quote makes it concrete.
- Drop bullets that are just transitions or scaffolding.

**Watch for.** (optional, max 2 bullets)
- Things that look load-bearing but might be wrong, biased, or out of date.
- Quietly hedged claims worth verifying.
```

## Voice

- The reader skimmed past the original. You're telling them what they
  missed, not summarizing the structure of the source.
- Names, numbers, dates beat adjectives. "$2.3B Series C in March" beats
  "a major funding round earlier this year".
- If the source is itself a summary or has nothing surprising, just say so
  in the TL;DR and stop. Don't pad.

## What to skip

- "The author argues…" / "The piece explores…" framing.
- Restating section headings.
- Anything not present in the source — no inference, no extrapolation.
