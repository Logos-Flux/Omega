import type { ComputeProvider } from './types'
import { SpritesProvider } from './sprites'
import { DockerProvider } from './docker'
import { dockerHarnessEnv } from './env'

let _provider: ComputeProvider | null = null

/**
 * Returns the compute provider chosen by env.
 *
 *   COMPUTE_PROVIDER=docker   → DockerProvider (single-machine, local Docker)
 *   COMPUTE_PROVIDER=sprites  → SpritesProvider (Fly Sprites; requires SPRITES_API_TOKEN)
 *
 * Default is `docker` — that's the zero-config path for the bundled
 * docker-compose.yml. Operators using Fly Sprites set
 * `COMPUTE_PROVIDER=sprites` and `SPRITES_API_TOKEN`.
 */
export function getComputeProvider(): ComputeProvider {
  if (_provider) return _provider
  const choice = (process.env.COMPUTE_PROVIDER ?? 'docker').toLowerCase()
  switch (choice) {
    case 'sprites': {
      const token = process.env.SPRITES_API_TOKEN
      if (!token) throw new Error('COMPUTE_PROVIDER=sprites but SPRITES_API_TOKEN is not set')
      const auth = (process.env.SPRITES_URL_AUTH ?? 'sprite') as 'sprite' | 'public'
      _provider = new SpritesProvider({ token, defaultUrlAuth: auth })
      return _provider
    }
    case 'docker': {
      const image = process.env.HARNESS_IMAGE ?? 'omega-pi-harness:local'
      _provider = new DockerProvider({
        image,
        env: dockerHarnessEnv(),
        network: process.env.HARNESS_NETWORK,
        hostUrlBase: process.env.HARNESS_HOST_URL_BASE ?? 'http://localhost',
        socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock',
      })
      return _provider
    }
    default:
      throw new Error(`Unknown COMPUTE_PROVIDER: ${choice} (expected 'docker' or 'sprites')`)
  }
}

export type { ComputeProvider, ContainerHandle, ContainerStatus } from './types'
export { dockerHarnessEnv } from './env'
