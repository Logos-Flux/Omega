// bun scripts/user-channel.ts <email> <channel>
// Move a user between alpha/beta/launch. Looks up by email so the
// operator doesn't need to copy UUIDs.

import { adminCall, die } from './lib'

const [email, channel] = process.argv.slice(2)
if (!email || !channel) {
  die('usage: bun scripts/user-channel.ts <email> <alpha|beta|launch>')
}

interface UserRow { id: string; email: string; release_channel: string }

// Find by email. /users doesn't support email-filter; pull a wide page
// and grep client-side. Sane up to a few hundred users.
const list = await adminCall<{ users: UserRow[] }>('/api/admin/users?limit=200')
const user = list.users.find((u) => u.email === email)
if (!user) die(`no user with email ${email}`)

const out = await adminCall(`/api/admin/users/${user.id}/channel`, {
  method: 'POST',
  body: { channel },
})
console.log(JSON.stringify(out, null, 2))
