---
name: note-taking
description: Save things the user wants you to remember across sessions. Activate when they say "remember X", "note this", "for next time", or share durable preferences/decisions/facts you'll need later.
---

# Note-taking skill

Use the `write_memory` tool to persist notes to `/workspace/memory.md`.
The file is read on every request and injected as a system message, so
anything you save here shapes future answers.

## When to save

Save when the user:
- explicitly says "remember", "save", "note this", "for next time"
- shares a durable preference (favourite colour, time zone, naming
  convention, code style)
- announces a decision or working agreement that should outlive the
  current thread
- gives you a name, role, or domain context that's clearly long-lived

Do NOT save:
- conversational throwaways
- transient task state ("I'm currently working on…")
- anything sensitive (passwords, API keys, PII) — refuse and explain
- something already in memory; check first

## How to write

Each entry: a dated heading + a tight bullet or two. No prose paragraphs.

```
## 2026-04-30
- User prefers dark mode for code samples.
- Working on the controller repo; primary language Bun + TypeScript.
```

Default to `mode: "append"`. Only use `mode: "replace"` if the user
explicitly says "wipe memory", "start over", or similar — and confirm
with one short sentence first.

## Voice when confirming

After a successful write, one line. No emoji. Examples:
- "Noted."
- "Saved — preferring dark mode for code samples."
- "Replaced memory with the new entries you provided."

Don't quote the entry back at length. The user knows what they asked
you to save.
