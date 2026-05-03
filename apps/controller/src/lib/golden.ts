import { getPool, hasDatabase } from './db'

export interface Golden {
  version: string
  manifest_uri: string
  manifest_sha: string
  released_to: string[]
  retired_at: string | null
}

// Latest non-retired golden for a channel. "Latest" is decided by built_at
// (which equals registration time) rather than semver-sort because the
// version string is opaque text in the table — pre-release tags like
// 1.5.0-rc1 should win against 1.5.0 only if registered later, which is
// what the operator likely intends.
export async function latestGoldenForChannel(channel: string): Promise<Golden | null> {
  if (!hasDatabase) return null
  const res = await getPool().query<Golden>(
    `SELECT version, manifest_uri, manifest_sha, released_to, retired_at
     FROM pi.golden_images
     WHERE retired_at IS NULL AND $1 = ANY(released_to)
     ORDER BY built_at DESC
     LIMIT 1`,
    [channel],
  )
  return res.rows[0] ?? null
}
