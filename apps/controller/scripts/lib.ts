// Shared helpers for the controller admin CLI scripts.
//
// All credentials come from env vars (set them in your shell or pass them
// inline before the bun command):
//   CONTROLLER_URL       — base URL of your controller deployment
//   ADMIN_BEARER_TOKEN   — same value as the controller's env
//
// These scripts are operator helpers for the SpritesProvider workflow
// (provision/update/golden management). The DockerProvider doesn't need
// any of this — the harness image already contains its dependencies.

export function adminToken(): string {
  const t = process.env.ADMIN_BEARER_TOKEN
  if (!t) throw new Error('ADMIN_BEARER_TOKEN is not set in env')
  return t
}

export function controllerUrl(): string {
  return process.env.CONTROLLER_URL ?? 'http://localhost:3001'
}

export interface AdminCallOptions {
  method?: 'GET' | 'POST'
  body?: unknown
}

export async function adminCall<T = unknown>(path: string, opts: AdminCallOptions = {}): Promise<T> {
  const url = `${controllerUrl()}${path}`
  const headers: Record<string, string> = {
    authorization: `Bearer ${adminToken()}`,
  }
  let body: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  const res = await fetch(url, { method: opts.method ?? 'GET', headers, body })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`${opts.method ?? 'GET'} ${path} → ${res.status}: ${text}`)
  }
  return text ? (JSON.parse(text) as T) : (undefined as T)
}

export function die(msg: string, code = 1): never {
  console.error(msg)
  process.exit(code)
}
