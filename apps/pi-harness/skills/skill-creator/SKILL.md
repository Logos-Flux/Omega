---
name: skill-creator
description: Author a new reusable skill and save it to the user's library. Activate when the user asks you to "make a skill", "remember how to do this", "automate this", or when you notice a task pattern they repeat that would be worth packaging for next time.
---

# Skill creator

A skill is a packaged set of instructions for one recurring kind of task.
Good skills turn a thing the user explains once into something you just do
the same way every time. You create one with the `write_skill` tool; this
skill is the guide for writing a *good* one.

## When to create a skill

- The user explicitly asks ("make a skill for X", "remember how to do this").
- You notice the user has now asked for the same shape of task 2–3 times.
- A task had a fiddly, get-it-right protocol (specific tool flags, a
  required output format) worth capturing so you don't re-derive it.

Don't create a skill for a one-off, or for something a built-in skill
already covers (read `<available_skills>` first — if one fits, use it).

## The three fields

`write_skill(name, description, body)`:

1. **name** — lowercase kebab-case, 1–64 chars (`weekly-report`,
   `invoice-parse`). It's the directory + the handle the model loads.
2. **description** — ONE line, and the most important field: it's all the
   future model sees in `<available_skills>` when deciding whether to load
   the skill. Write it as a MANDATORY trigger, not a title. Lead with a
   binding "ALWAYS load before responding to/when …" clause and name the exact
   phrase(s) the user is likely to type verbatim — the global loading rule
   matches those against the user's message, so the closer the trigger is to
   the user's actual words, the more reliably the skill fires.
   - Good: "Draft the Monday status email from the week's notes. ALWAYS load
     before responding when the user says 'weekly update' or pastes standup
     notes."
   - Weak: "Weekly report skill." (no trigger → never gets selected)
   - Weak: "Activate when the user wants a status email." (soft + vague → the
     model may skip it) — prefer the binding "ALWAYS load before responding
     to …" form with the literal trigger phrase.
3. **body** — the SKILL.md instructions in markdown. No frontmatter (it's
   generated). Structure it like the built-in skills:
   - A one-line statement of what the skill produces.
   - A **Protocol** — numbered, concrete steps. Name exact tools/flags
     (`exec`, `read_upload`, specific args). Reference uploads by filename.
   - **Limits** — what it can't do, when to bail instead of guessing.
   - **Voice** — how the output should read.

## Protocol

1. **Confirm the pattern.** Restate, in one sentence, the repeatable task
   you're about to package. If it's genuinely one-off, say so and skip.
2. **Draft the three fields.** Keep the body tight — instructions the
   future model follows, not prose about the task.
3. **Write it:** `write_skill(name=…, description=…, body=…)`.
4. **Verify:** call `read_skill(name)` and check it reads back as intended.
   If the body needs fixing, call `write_skill` again with the same name to
   overwrite.
5. **Tell the user** plainly: "Saved a `weekly-report` skill — next time
   just say 'weekly update' and I'll follow it." Don't over-explain.

## Limits

- Names must be unique and can't shadow a built-in skill — `write_skill`
  will reject a clash; pick another name.
- You're writing instructions for a model, not running them now. Don't
  perform the task inside the body; describe how to perform it.
- One skill = one task shape. If you're tempted to write "and also…",
  that's a second skill.

## Voice

Brisk. Create the skill, verify it, confirm in a sentence. Don't narrate
the authoring ("Now I'll write the description…") — just do it.
