// bun scripts/golden-register.ts <version> <manifest_uri> <manifest_sha> [notes]
// Registers a new golden manifest. Auto-published to alpha only.

import { adminCall, die } from './lib'

const [version, manifest_uri, manifest_sha, ...rest] = process.argv.slice(2)
if (!version || !manifest_uri || !manifest_sha) {
  die('usage: bun scripts/golden-register.ts <version> <manifest_uri> <manifest_sha> [notes]')
}
const notes = rest.join(' ') || undefined

const out = await adminCall('/api/admin/golden', {
  method: 'POST',
  body: { version, manifest_uri, manifest_sha, notes },
})
console.log(JSON.stringify(out, null, 2))
