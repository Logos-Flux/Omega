export interface ContainerHandle {
  name: string
  url: string
  provider: string
  // True when ensureContainer just created the sprite; the caller is
  // responsible for running the bootstrap before the harness can serve.
  // False on returning-user calls.
  freshlyProvisioned: boolean
}

export type ContainerStatus = 'running' | 'frozen' | 'gone'

export interface ComputeProvider {
  readonly name: string

  /**
   * Idempotent. Ensures a container exists for the given userId and returns
   * its handle. If the container already exists it MUST be returned as-is
   * rather than recreated. The `freshlyProvisioned` flag tells the caller
   * whether the bootstrap step still has to run.
   */
  ensureContainer(userId: string): Promise<ContainerHandle>

  /**
   * Best-effort idle freeze. Sprites checkpoints automatically on idle, so
   * this can be a no-op for that provider; Proxmox impl will need to act.
   */
  freeze(name: string): Promise<void>

  /**
   * Permanent destruction. Caller is responsible for clearing the
   * pi.containers row.
   */
  destroy(name: string): Promise<void>

  status(name: string): Promise<ContainerStatus>
}
