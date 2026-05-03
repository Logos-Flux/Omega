// bun scripts/golden-promote.ts <version> <channel>
// Promotes a manifest to a new channel. Idempotent.

import { adminCall, die } from './lib'

const [version, channel] = process.argv.slice(2)
if (!version || !channel) {
  die('usage: bun scripts/golden-promote.ts <version> <alpha|beta|launch>')
}

const out = await adminCall(`/api/admin/golden/${encodeURIComponent(version)}/promote`, {
  method: 'POST',
  body: { to: channel },
})
console.log(JSON.stringify(out, null, 2))
