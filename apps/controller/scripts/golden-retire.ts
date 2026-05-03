// bun scripts/golden-retire.ts <version>
// Marks a manifest retired — blocks new provisions; existing
// containers on that version stay there until they're updated.

import { adminCall, die } from './lib'

const [version] = process.argv.slice(2)
if (!version) die('usage: bun scripts/golden-retire.ts <version>')

const out = await adminCall(`/api/admin/golden/${encodeURIComponent(version)}/retire`, {
  method: 'POST',
})
console.log(JSON.stringify(out, null, 2))
