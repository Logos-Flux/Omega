# Skills attribution

The skills shipped in this directory are original work unless explicitly
noted below.

## Vendored from upstream

### `gccli`, `gdcli`, `gmcli` — from `badlogic/pi-skills`

Vendored 2026-04-30 from
https://github.com/badlogic/pi-skills (commit at vendor time:
master @ checkout date). Each skill folder contains the upstream
`SKILL.md` unchanged plus a copy of the upstream `LICENSE` (MIT,
copyright 2024 Mario Zechner). The CLIs themselves
(`@mariozechner/{gccli,gdcli,gmcli}`) are installed in the sprite via
`npm install -g`, also MIT.

When updating these skills:
1. Pull the latest from upstream.
2. Copy `<skill>/SKILL.md` and (if changed) `LICENSE` into our
   `skills/<skill>/`.
3. Bump the npm packages on the sprite (`npm update -g
   @mariozechner/gccli @mariozechner/gdcli @mariozechner/gmcli`).
4. Note the new upstream commit in this file.

## License audit of upstream `anthropics/skills` repo

Audited 2026-04-30 against
https://github.com/anthropics/skills

| Upstream skill | License | Vendorable here? |
|---|---|---|
| `pdf` | Proprietary (Anthropic, source-available) | **No** — license forbids extraction outside Services + derivative works |
| `docx` | Proprietary | **No** |
| `xlsx` | Proprietary | **No** |
| `pptx` | Proprietary | **No** |
| `doc-coauthoring` | Proprietary (root LICENSE applies) | **No** |
| `algorithmic-art`, `brand-guidelines`, `canvas-design`, `claude-api`, `frontend-design`, `internal-comms`, `mcp-builder`, `skill-creator`, `slack-gif-creator`, `theme-factory`, `webapp-testing`, `web-artifacts-builder` | Apache-2.0 | **Yes** (with notice) |

If we vendor an Apache-2.0 skill in the future, copy the upstream
`LICENSE.txt` into the skill directory unchanged and prepend a NOTICE
section to the SKILL.md identifying the source commit.

## Original skills in this repo

- `code-review`, `summarize`, `note-taking`, `pdf-extract`,
  `pdf-create` — written for this project, no upstream attribution
  required.
