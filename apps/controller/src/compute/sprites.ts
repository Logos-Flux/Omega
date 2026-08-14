import type { ComputeProvider, ContainerHandle, ContainerStatus } from './types'

const API_BASE = 'https://api.sprites.dev/v1'

interface SpriteRecord {
  id: string
  name: string
  status: string
  url: string
  url_settings?: { auth: string; private_access: string }
  created_at: string
  organization: string
}

export class SpritesProvider implements ComputeProvider {
  readonly name = 'sprites'
  private readonly token: string
  private readonly defaultUrlAuth: 'sprite' | 'public'

  constructor(opts: { token: string; defaultUrlAuth?: 'sprite' | 'public' }) {
    if (!opts.token) throw new Error('SpritesProvider: missing token')
    this.token = opts.token
    this.defaultUrlAuth = opts.defaultUrlAuth ?? 'sprite'
  }

  static spriteNameForUser(userId: string): string {
    const slug = userId.replace(/-/g, '').slice(0, 12)
    return `harness-${slug}`
  }

  async ensureContainer(userId: string): Promise<ContainerHandle> {
    const name = SpritesProvider.spriteNameForUser(userId)
    const existing = await this.fetchSprite(name)
    if (existing) {
      return { name, url: existing.url, provider: this.name, freshlyProvisioned: false }
    }
    const created = await this.createSprite(name)
    return { name, url: created.url, provider: this.name, freshlyProvisioned: true }
  }

  async freeze(_name: string): Promise<void> {
    // Sprites auto-checkpoints on idle. No explicit freeze API needed.
  }

  async destroy(name: string): Promise<void> {
    const res = await this.req(`/sprites/${encodeURIComponent(name)}`, { method: 'DELETE' })
    if (!res.ok && res.status !== 404) {
      throw new Error(`destroy ${name} failed: ${res.status} ${await res.text()}`)
    }
  }

  async status(name: string): Promise<ContainerStatus> {
    const sprite = await this.fetchSprite(name)
    if (!sprite) return 'gone'
    return spriteStatusToContainerStatus(sprite.status)
  }

  private async fetchSprite(name: string): Promise<SpriteRecord | null> {
    const res = await this.req(`/sprites/${encodeURIComponent(name)}`, { method: 'GET' })
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`get sprite failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as SpriteRecord
  }

  private async createSprite(name: string): Promise<SpriteRecord> {
    const res = await this.req('/sprites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) throw new Error(`create sprite ${name} failed: ${res.status} ${await res.text()}`)
    const created = (await res.json()) as SpriteRecord
    if (this.defaultUrlAuth !== 'sprite' && created.url_settings?.auth !== this.defaultUrlAuth) {
      // Flip auth at creation time so the sprite is browser-reachable even if a
      // later bootstrap step fails. Retry: a sprite can briefly 404 on the PATCH
      // immediately after POST returns. Best-effort (the bootstrap flips again
      // as a backup), but loud if every attempt fails.
      await this.setUrlAuthWithRetry(name, this.defaultUrlAuth)
    }
    return created
  }

  private async setUrlAuthWithRetry(
    name: string,
    auth: 'sprite' | 'public',
    attempts = 3,
  ): Promise<void> {
    for (let i = 1; i <= attempts; i++) {
      try {
        await this.updateUrlAuth(name, auth)
        return
      } catch (e) {
        if (i === attempts) {
          console.warn(
            `[sprites] url-auth ${auth} for ${name} failed after ${attempts} attempts; bootstrap flip will retry`,
            e,
          )
          return
        }
        await new Promise((r) => setTimeout(r, 400 * i))
      }
    }
  }

  private async updateUrlAuth(name: string, auth: 'sprite' | 'public'): Promise<void> {
    const res = await this.req(`/sprites/${encodeURIComponent(name)}/url`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auth }),
    })
    if (!res.ok) throw new Error(`url-auth ${auth} for ${name}: ${res.status}`)
  }

  private async req(path: string, init: RequestInit): Promise<Response> {
    const url = `${API_BASE}${path}`
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${this.token}`)
    headers.set('accept', 'application/json')
    return fetch(url, { ...init, headers })
  }
}

function spriteStatusToContainerStatus(s: string): ContainerStatus {
  switch (s) {
    case 'running':
    case 'warm':
      return 'running'
    case 'cold':
    case 'frozen':
      return 'frozen'
    default:
      return 'frozen'
  }
}
