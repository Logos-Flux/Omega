---
name: code-review
description: Review a code snippet for correctness, readability, performance, and security. Activate when the user pastes code or explicitly asks for a review.
---

# Code review skill

When the user has pasted code (or attached it via a paste-style block) and
the request is "review", "look at this", "what's wrong with this", or any
synonym, follow the protocol below. If they pasted code without asking
explicitly, ask once whether they want a review before launching into one
— don't review uninvited.

## Output protocol

Reply with these sections in order. Skip a section entirely if there's
nothing to say there. Don't pad.

1. **One-line verdict.** Three words max. e.g. "Looks fine.", "Has a bug.",
   "Needs a rewrite."
2. **Bugs (if any).** Numbered list. Each bug: file:line (if available),
   what's wrong, what to do instead. Be concrete — no "consider X" hedge.
3. **Readability.** Only call out things that *actually* hurt comprehension.
   Don't suggest renames just because *you'd* name it differently.
4. **Performance.** Only if there's a real hotspot or a known antipattern
   (N+1, sync I/O in a loop, etc.). Skip the section if nothing's
   load-bearing.
5. **Security.** Only if there's an actual vulnerability or unsafe pattern
   (SQL injection, XSS, missing auth, secrets in code). Skip otherwise.

## Voice

- Direct. The user is a peer reviewing with you, not a student.
- No "great code overall!" preambles. No emoji.
- If the code is good, say so in the verdict and stop. A short answer is
  the highest compliment.
- Quote the exact line you're talking about when calling out a bug.

## What to skip

- Style debates that don't affect bugs or comprehension (tabs vs spaces,
  brace placement, etc.).
- Suggestions to add comments that just restate what the code does.
- Any sentence that begins with "Consider…".
