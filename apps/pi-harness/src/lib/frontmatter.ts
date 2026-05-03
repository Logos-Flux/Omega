// Tiny YAML-frontmatter splitter — extracted from the original
// skills.ts so every Registry parser uses the same rules. Intentionally
// minimal: scalars only, optional single/double quote stripping, no
// nested objects, no arrays. A frontmatter block is exactly:
//
//   ---
//   key: value
//   another-key: "quoted value"
//   ---
//
// Anything richer — lists, nested mappings — should use a real YAML
// parser (the `yaml` package) at the call site.

export interface FrontMatter {
  [key: string]: string
}

export interface FrontMatterParse {
  fm: FrontMatter
  body: string
}

export function parseFrontMatter(text: string): FrontMatterParse {
  if (!text.startsWith('---\n')) return { fm: {}, body: text }
  const end = text.indexOf('\n---', 4)
  if (end === -1) return { fm: {}, body: text }
  const block = text.slice(4, end)
  const body = text.slice(end + 4).replace(/^\n+/, '')
  const fm: FrontMatter = {}
  for (const line of block.split('\n')) {
    const m = line.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/)
    if (!m) continue
    let v = m[2]!.trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    fm[m[1]!] = v
  }
  return { fm, body }
}
