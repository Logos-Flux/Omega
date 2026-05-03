// bun scripts/fleet-status.ts
// Prints the controller's /api/admin/fleet summary. Useful on a cron
// once the channels have any rollout activity.

import { adminCall } from './lib'

interface Fleet {
  users_by_channel: Record<string, number>
  containers: { channel: string; version: string | null; status: string | null; count: number }[]
  updates_last_7d: Record<string, number>
}

const fleet = await adminCall<Fleet>('/api/admin/fleet')

console.log('Users by channel:')
for (const [ch, n] of Object.entries(fleet.users_by_channel)) {
  console.log(`  ${ch.padEnd(8)} ${n}`)
}
if (Object.keys(fleet.users_by_channel).length === 0) console.log('  (none)')

console.log('\nContainer fleet:')
if (fleet.containers.length === 0) {
  console.log('  (no containers tracked yet)')
} else {
  for (const row of fleet.containers) {
    const v = row.version ?? '(legacy/null)'
    console.log(`  ${row.channel.padEnd(8)} ${v.padEnd(14)} ${(row.status ?? '?').padEnd(16)} ${row.count}`)
  }
}

console.log('\nUpdates (last 7d):')
if (Object.keys(fleet.updates_last_7d).length === 0) {
  console.log('  (no update activity)')
} else {
  for (const [status, n] of Object.entries(fleet.updates_last_7d)) {
    console.log(`  ${status.padEnd(12)} ${n}`)
  }
}
