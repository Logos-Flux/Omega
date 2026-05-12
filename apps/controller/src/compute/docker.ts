import type { ComputeProvider, ContainerHandle, ContainerStatus } from './types'

/**
 * DockerProvider — spawns a per-user pi-harness container on the local Docker
 * daemon. Each container gets a named volume mounted at /workspace so its
 * memory + skills + conversation jsonl survive restarts.
 *
 * Usage shape:
 *   const provider = new DockerProvider({
 *     image: 'omega-pi-harness:local',
 *     network: 'omega_default',     // optional; the controller's compose network
 *     hostUrlBase: 'http://localhost', // returned to browsers via the controller
 *   })
 *
 * The `hostUrlBase` is what the browser uses to reach the harness. On a
 * single-machine deploy that's `http://localhost` (the host); the random
 * published port comes from `docker inspect`. For multi-machine setups, point
 * it at the host's reachable hostname or set up a reverse proxy.
 *
 * The controller talks to the Docker daemon via the unix socket (default
 * `/var/run/docker.sock`). When the controller itself runs in a container,
 * mount that socket: `volumes: ['/var/run/docker.sock:/var/run/docker.sock']`.
 */
export interface DockerProviderOptions {
  /** Image to spawn for new harness containers. */
  image: string
  /** Per-container env vars (API keys, etc.). All harnesses share these. */
  env?: Record<string, string | undefined>
  /**
   * Docker network name to attach harness containers to. Defaults to the
   * `bridge` network. If the controller runs in compose, set this to the
   * compose network so the controller can reach the harness by container
   * name as well as via `hostUrlBase:<port>`.
   */
  network?: string
  /**
   * URL base the *browser* uses to reach the harness. The provider appends
   * `:<published-port>` from `docker inspect`. Default: `http://localhost`.
   * Ignored when `publicUrl` is set.
   */
  hostUrlBase?: string
  /**
   * Verbatim URL the *browser* uses to reach the harness. When set, replaces
   * the `${hostUrlBase}:${HostPort}` composition — useful when the harness
   * sits behind a TLS reverse proxy on a path (e.g. Caddy `/harness/*`),
   * because the browser-visible URL has no port and isn't constructible from
   * Docker's inspect output. Pair with `hostPort` so the proxy upstream is
   * predictable. Only one concurrent session works in this mode; multi-tenant
   * deploys need per-session path routing.
   */
  publicUrl?: string
  /**
   * Fixed host port for the harness's `8080/tcp` binding. Default: empty
   * string, which lets Docker pick a random port. Set this when fronting the
   * harness with a reverse proxy that expects a known upstream port.
   */
  hostPort?: string
  /**
   * Path to the Docker daemon socket. Default: `/var/run/docker.sock`.
   */
  socketPath?: string
}

/**
 * Compose the URL handed to the browser. When `publicUrl` is set it wins
 * verbatim; otherwise we append the published host port to `hostUrlBase`.
 * Exposed for unit tests.
 */
export function composeHarnessUrl(opts: {
  publicUrl?: string
  hostUrlBase: string
  hostPort: string
}): string {
  if (opts.publicUrl) return opts.publicUrl
  return `${opts.hostUrlBase}:${opts.hostPort}`
}

export class DockerProvider implements ComputeProvider {
  readonly name = 'docker'
  private readonly image: string
  private readonly env: Record<string, string | undefined>
  private readonly network: string | undefined
  private readonly hostUrlBase: string
  private readonly publicUrl: string | undefined
  private readonly hostPort: string
  private readonly socketPath: string

  constructor(opts: DockerProviderOptions) {
    if (!opts.image) throw new Error('DockerProvider: image is required')
    this.image = opts.image
    this.env = opts.env ?? {}
    this.network = opts.network
    this.hostUrlBase = opts.hostUrlBase ?? 'http://localhost'
    this.publicUrl = opts.publicUrl
    this.hostPort = opts.hostPort ?? ''
    this.socketPath = opts.socketPath ?? '/var/run/docker.sock'
  }

  static containerNameForUser(userId: string): string {
    const slug = userId.replace(/-/g, '').slice(0, 12)
    return `harness-${slug}`
  }

  async ensureContainer(userId: string): Promise<ContainerHandle> {
    const name = DockerProvider.containerNameForUser(userId)
    const existing = await this.inspect(name)
    if (existing) {
      if (!isRunning(existing)) {
        await this.daemon('POST', `/containers/${name}/start`)
      }
      const url = await this.urlFor(name)
      return { name, url, provider: this.name, freshlyProvisioned: false }
    }
    await this.create(name)
    await this.daemon('POST', `/containers/${name}/start`)
    const url = await this.urlFor(name)
    return { name, url, provider: this.name, freshlyProvisioned: true }
  }

  async freeze(name: string): Promise<void> {
    const res = await this.daemon('POST', `/containers/${name}/stop?t=5`)
    if (res.status === 404 || res.status === 304) return
    if (res.status >= 400) throw new Error(`stop ${name}: ${res.status} ${await res.text()}`)
  }

  async destroy(name: string): Promise<void> {
    const res = await this.daemon('DELETE', `/containers/${name}?force=true&v=true`)
    if (res.status === 404) return
    if (res.status >= 400) throw new Error(`rm ${name}: ${res.status} ${await res.text()}`)
  }

  async status(name: string): Promise<ContainerStatus> {
    const c = await this.inspect(name)
    if (!c) return 'gone'
    return isRunning(c) ? 'running' : 'frozen'
  }

  // -- internals -----------------------------------------------------------

  private async create(name: string): Promise<void> {
    const Env: string[] = []
    for (const [k, v] of Object.entries(this.env)) {
      if (v != null && v !== '') Env.push(`${k}=${v}`)
    }
    const body = {
      Image: this.image,
      Env,
      ExposedPorts: { '8080/tcp': {} },
      Labels: { 'com.logos-flux.omega.role': 'pi-harness', 'com.logos-flux.omega.user': name.slice(8) },
      HostConfig: {
        // Random host port → 8080 in container (or fixed via `hostPort` when
        // the harness lives behind a reverse proxy with a known upstream).
        PortBindings: { '8080/tcp': [{ HostPort: this.hostPort }] },
        // Per-user named volume keeps /workspace state across restarts.
        Mounts: [{ Type: 'volume', Source: `${name}-workspace`, Target: '/workspace' }],
        RestartPolicy: { Name: 'unless-stopped' },
        ...(this.network ? { NetworkMode: this.network } : {}),
      },
    }
    const res = await this.daemon('POST', `/containers/create?name=${encodeURIComponent(name)}`, body)
    if (res.status >= 400) {
      throw new Error(`create ${name}: ${res.status} ${await res.text()}`)
    }
  }

  private async inspect(name: string): Promise<ContainerInspect | null> {
    const res = await this.daemon('GET', `/containers/${name}/json`)
    if (res.status === 404) return null
    if (res.status >= 400) throw new Error(`inspect ${name}: ${res.status} ${await res.text()}`)
    return (await res.json()) as ContainerInspect
  }

  private async urlFor(name: string): Promise<string> {
    if (this.publicUrl) return this.publicUrl
    const c = await this.inspect(name)
    if (!c) throw new Error(`urlFor: container ${name} disappeared`)
    const binding = c.NetworkSettings?.Ports?.['8080/tcp']?.[0]
    if (!binding?.HostPort) {
      throw new Error(`urlFor: ${name} has no published 8080/tcp binding`)
    }
    return composeHarnessUrl({
      hostUrlBase: this.hostUrlBase,
      hostPort: binding.HostPort,
    })
  }

  private async daemon(method: string, path: string, body?: unknown): Promise<Response> {
    // Bun's fetch supports unix sockets via the `unix` option.
    const init: RequestInit & { unix?: string } = {
      method,
      unix: this.socketPath,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    }
    return fetch(`http://docker${path}`, init)
  }
}

interface ContainerInspect {
  Id: string
  State?: { Running?: boolean; Status?: string }
  NetworkSettings?: {
    Ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>
  }
}

function isRunning(c: ContainerInspect): boolean {
  return c.State?.Running === true || c.State?.Status === 'running'
}
