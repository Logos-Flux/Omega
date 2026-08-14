import { AwsClient } from 'aws4fetch'

/**
 * OPS-14 — object storage for sprite workspace backups (conversations + memory).
 * **Tigris** (Fly-native, S3-compatible). Provision with
 * `fly storage create -a <your-controller-app>`, which injects AWS_ACCESS_KEY_ID /
 * AWS_SECRET_ACCESS_KEY / AWS_ENDPOINT_URL_S3 (https://fly.storage.tigris.dev) /
 * AWS_REGION / BUCKET_NAME as Fly secrets. Private bucket (no `-p`).
 *
 * Lazy init so the controller still boots when storage isn't configured yet —
 * the backup endpoints 503 instead of crashing boot (mirrors weechat-api).
 */

const endpoint = process.env.AWS_ENDPOINT_URL_S3
const bucket = process.env.BUCKET_NAME
const accessKeyId = process.env.AWS_ACCESS_KEY_ID
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY
const region = process.env.AWS_REGION ?? 'auto'

let client: AwsClient | null = null

export function backupConfigured(): boolean {
  return Boolean(endpoint && bucket && accessKeyId && secretAccessKey)
}

function aws(): AwsClient {
  if (!backupConfigured()) {
    throw new Error('backup storage not configured (AWS_* + BUCKET_NAME)')
  }
  if (!client) {
    client = new AwsClient({
      accessKeyId: accessKeyId!,
      secretAccessKey: secretAccessKey!,
      service: 's3',
      region,
    })
  }
  return client
}

/** Upload a backup object. `key` segments must be URL-safe. Throws on non-2xx. */
export async function putBackup(
  key: string,
  body: string | Uint8Array,
  contentType = 'application/json',
): Promise<void> {
  const res = await aws().fetch(`${endpoint}/${bucket}/${key}`, {
    method: 'PUT',
    body,
    headers: { 'Content-Type': contentType },
  })
  if (!res.ok) {
    throw new Error(`Tigris PUT ${res.status}: ${await res.text().catch(() => '')}`)
  }
}
