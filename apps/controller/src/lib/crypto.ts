// AES-256-GCM token encryption for pi.oauth_tokens.refresh_token.
// Single-key MVP: rotation = re-encrypt-all migration; no key versioning.
//
// Wire format (base64-encoded): nonce(12B) || ciphertext || authTag(16B)
//
// Key source: process.env.OAUTH_TOKEN_ENC_KEY, hex-encoded 32 bytes (64 hex
// chars). The key is read lazily on first use so module import doesn't crash
// non-OAuth code paths (and so tests can set a fixed key before calling).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGO = 'aes-256-gcm'
const NONCE_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const KEY_HEX_LEN = KEY_BYTES * 2

let _key: Buffer | null = null

function getKey(): Buffer {
  if (_key) return _key
  const raw = process.env.OAUTH_TOKEN_ENC_KEY
  if (!raw) {
    throw new Error(
      'OAUTH_TOKEN_ENC_KEY is not set. Generate 32 random bytes hex-encoded ' +
        '(`openssl rand -hex 32`) and set it as a Fly secret on <your-controller>.',
    )
  }
  if (raw.length !== KEY_HEX_LEN || !/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      `OAUTH_TOKEN_ENC_KEY must be ${KEY_HEX_LEN} hex chars (32 bytes); got length ${raw.length}.`,
    )
  }
  _key = Buffer.from(raw, 'hex')
  return _key
}

/** Test-only: clear the cached key so a new env var value takes effect. */
export function _resetKeyForTests(): void {
  _key = null
}

export function encryptToken(plaintext: string): string {
  const key = getKey()
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv(ALGO, key, nonce)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([nonce, ct, tag]).toString('base64')
}

export function decryptToken(ciphertext: string): string {
  const key = getKey()
  const buf = Buffer.from(ciphertext, 'base64')
  if (buf.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('decryptToken: ciphertext too short')
  }
  const nonce = buf.subarray(0, NONCE_BYTES)
  const tag = buf.subarray(buf.length - TAG_BYTES)
  const ct = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES)
  const decipher = createDecipheriv(ALGO, key, nonce)
  decipher.setAuthTag(tag)
  const pt = Buffer.concat([decipher.update(ct), decipher.final()])
  return pt.toString('utf8')
}
