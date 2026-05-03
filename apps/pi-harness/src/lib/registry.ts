// Generic two-tier Registry — the shape every harness sub-system that
// looks like "scan a baked dir + a user dir, user-wins on collision"
// implements. Lifted from the original `src/skills.ts` dual-path scan
// (commit bf7232c) and made type-parametric so PersonaRegistry,
// SoulRegistry, and QuickActionRegistry share the same wiring.
//
// The generic owns directory traversal, name-collision resolution
// (user wins), alphabetical sort, and graceful absence of either dir.
// It does NOT know how to parse an entry — that lives in a `parse`
// callback supplied by the caller, which receives the absolute path
// to the *entry container* (typically a directory, but a single file
// for the soul registry) and returns the parsed entry or `null` if
// the entry is invalid and should be skipped.
//
// See AGENT_ARCHITECTURE.md L145-170 for the architectural framing.

import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface RegistryEntry {
  /** Canonical, user-facing name. Must be unique across both sources. */
  name: string
}

/**
 * Per-source layout:
 *
 * - `'directory'` (default): each direct child of the source dir is an
 *   entry container; `parse(childPath)` resolves the entry. This is the
 *   pattern skills, personas, and quick actions follow (e.g.
 *   `/home/sprite/skills/<name>/SKILL.md`).
 * - `'file'`: the source dir itself contains entry *files* directly,
 *   one entry per file; `parse(filePath)` resolves the entry. The soul
 *   registry uses this with a degenerate single-file convention (see
 *   `src/souls.ts`).
 */
export type RegistryLayout = 'directory' | 'file'

/**
 * Source directory specifier. Accepts a fixed string for production code
 * where the path is constant, or a getter for code paths whose root
 * depends on `process.env.WORKSPACE_ROOT` (resolved lazily so per-test
 * env mutation propagates correctly).
 */
export type DirSpec = string | (() => string)

function resolveDir(spec: DirSpec): string {
  return typeof spec === 'function' ? spec() : spec
}

export interface RegistryOptions<T extends RegistryEntry> {
  /** Baked, golden-installed source. Read-only at the filesystem level. */
  bakedDir: DirSpec
  /** User-mutable source. Persists across golden bumps. Wins on collision. */
  userDir: DirSpec
  /**
   * Parse a single entry container into a typed entry, or return `null`
   * to skip it (invalid frontmatter, missing required fields, etc.).
   * Frontmatter schema validation is the caller's responsibility — the
   * generic only deals in "valid or not".
   */
  parse: (path: string) => Promise<T | null>
  /**
   * How each source dir is laid out. Defaults to `'directory'` since
   * three of the four registries follow that pattern; the soul registry
   * overrides to `'file'`.
   */
  layout?: RegistryLayout
}

export class Registry<T extends RegistryEntry> {
  private readonly bakedDirSpec: DirSpec
  private readonly userDirSpec: DirSpec
  private readonly parse: (path: string) => Promise<T | null>
  private readonly layout: RegistryLayout
  private cache: T[] | null = null
  private cacheKey: string | null = null

  constructor(opts: RegistryOptions<T>) {
    this.bakedDirSpec = opts.bakedDir
    this.userDirSpec = opts.userDir
    this.parse = opts.parse
    this.layout = opts.layout ?? 'directory'
  }

  /** Return all valid entries in deterministic alphabetical order. */
  async list(): Promise<T[]> {
    const userDir = resolveDir(this.userDirSpec)
    const bakedDir = resolveDir(this.bakedDirSpec)
    const key = userDir + '\0' + bakedDir
    if (this.cache && this.cacheKey === key) return this.cache
    const seen = new Set<string>()
    const entries: T[] = []
    // Order matters: scan the user dir FIRST so that when a baked entry
    // shares a name with a user one, the baked entry is rejected as a
    // duplicate. This is the user-wins-on-name-collision contract.
    await this.scanInto(userDir, seen, entries)
    await this.scanInto(bakedDir, seen, entries)
    entries.sort((a, b) => a.name.localeCompare(b.name))
    this.cache = entries
    this.cacheKey = key
    return entries
  }

  /** Look up a single entry by name. Returns `null` if not found. */
  async get(name: string): Promise<T | null> {
    const all = await this.list()
    return all.find((e) => e.name === name) ?? null
  }

  /** Drop the cached scan so the next `list()` re-reads the filesystem. */
  reload(): void {
    this.cache = null
    this.cacheKey = null
  }

  private async scanInto(
    baseDir: string,
    seen: Set<string>,
    out: T[],
  ): Promise<void> {
    if (!existsSync(baseDir)) return
    let names: string[]
    try {
      names = await readdir(baseDir)
    } catch {
      return
    }
    for (const child of names) {
      const childPath = join(baseDir, child)
      // Filter by expected layout. For directory-layout registries we
      // skip plain files (and vice versa) — that keeps stray junk
      // (e.g. a stray README.md in /home/sprite/skills/) from becoming
      // a "broken entry" issue. The parse callback only ever sees
      // candidate paths.
      try {
        const s = await stat(childPath)
        if (this.layout === 'directory' && !s.isDirectory()) continue
        if (this.layout === 'file' && !s.isFile()) continue
      } catch {
        continue
      }
      let entry: T | null
      try {
        entry = await this.parse(childPath)
      } catch {
        // A parse callback that throws is treated as "invalid entry,
        // skip" rather than crashing the whole registry. Callers that
        // want to surface diagnostic detail should swallow internally
        // and return null themselves.
        entry = null
      }
      if (!entry) continue
      if (seen.has(entry.name)) continue
      seen.add(entry.name)
      out.push(entry)
    }
  }
}
