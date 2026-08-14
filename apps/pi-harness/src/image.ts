import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, basename } from 'node:path'
import { uploadPath } from './uploads'

// Image generation via the Ideogram 3.0 API. Registered as the native
// `generate_image` tool in assembler.ts (driven by the `image-gen` skill).
//
// Why a native tool and not an exec-driven skill: the harness `exec`/`shell`
// sandbox (exec.ts) has no `curl`, strips every secret-looking env var
// (`IDEOGRAM_API_KEY` matches SECRET_NAME_RE) from child processes, and caps
// stdout at 100 KB — so a markdown skill shelling out could neither reach the
// API, see the key, nor return image bytes. This module runs IN the harness
// process, which holds the full env, and saves the result straight into the
// session's uploads dir (same path the /files download endpoint serves) — the
// exact pattern drive.ts::fetchFile uses for binary Drive files.

const ENDPOINT = 'https://api.ideogram.ai/v1/ideogram-v3/generate'

/** Gate: the tool is only registered when the key is present on the harness env. */
export function isImageGenEnabled(): boolean {
  return typeof process.env.IDEOGRAM_API_KEY === 'string' && process.env.IDEOGRAM_API_KEY.length > 0
}

// Mirror Ideogram v3's accepted enums so the model can't send a value the API
// will 422 on. aspect_ratio uses the `WxH` form (e.g. "16x9"), NOT "16:9".
export const ASPECT_RATIOS = [
  '1x1', '16x9', '9x16', '4x3', '3x4', '3x2', '2x3', '16x10', '10x16', '4x5', '5x4', '21x9', '9x21',
] as const
export const RENDERING_SPEEDS = ['FLASH', 'TURBO', 'DEFAULT', 'QUALITY'] as const
export const MAGIC_PROMPT = ['AUTO', 'ON', 'OFF'] as const
export const STYLE_TYPES = ['AUTO', 'GENERAL', 'REALISTIC', 'DESIGN', 'FICTION'] as const

export interface GenerateImageParams {
  prompt: string
  aspect_ratio?: (typeof ASPECT_RATIOS)[number]
  rendering_speed?: (typeof RENDERING_SPEEDS)[number]
  magic_prompt?: (typeof MAGIC_PROMPT)[number]
  style_type?: (typeof STYLE_TYPES)[number]
  negative_prompt?: string
  num_images?: number
  seed?: number
}

interface IdeogramImage {
  url: string
  prompt?: string
  resolution?: string
  seed?: number
  is_image_safe?: boolean
  style_type?: string
}

export interface SavedImage {
  filename: string
  resolution?: string
  seed?: number
  is_image_safe?: boolean
}

export interface GenerateImageResult {
  images: SavedImage[]
  /** The prompt Ideogram actually rendered (magic_prompt may rewrite it). */
  rendered_prompt?: string
  note: string
}

/**
 * Generate image(s) with Ideogram and save each PNG into the session's uploads
 * dir. Returns the saved filenames (downloadable by the user, listed in
 * list_uploads) — NOT raw bytes. The Ideogram `data[].url` links are ephemeral,
 * so we download them immediately.
 */
export async function generateImage(
  params: GenerateImageParams,
  sessionId: string,
): Promise<GenerateImageResult> {
  const apiKey = process.env.IDEOGRAM_API_KEY
  if (!apiKey) throw new Error('IDEOGRAM_API_KEY not set')

  const form = new FormData()
  form.set('prompt', params.prompt)
  if (params.aspect_ratio) form.set('aspect_ratio', params.aspect_ratio)
  form.set('rendering_speed', params.rendering_speed ?? 'DEFAULT')
  if (params.magic_prompt) form.set('magic_prompt', params.magic_prompt)
  if (params.style_type) form.set('style_type', params.style_type)
  if (params.negative_prompt) form.set('negative_prompt', params.negative_prompt)
  if (typeof params.num_images === 'number') form.set('num_images', String(params.num_images))
  if (typeof params.seed === 'number') form.set('seed', String(params.seed))

  // v3 generate is multipart/form-data with an `Api-Key` header — NOT JSON.
  // Let fetch set the multipart Content-Type (with boundary) from the FormData.
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Api-Key': apiKey },
    body: form,
  })
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300)
    throw new Error(`Ideogram API error (${res.status}): ${body}`)
  }
  const json = (await res.json()) as { created?: string; data?: IdeogramImage[] }
  const data = json.data ?? []
  if (data.length === 0) throw new Error('Ideogram returned no images')

  const stamp = Date.now()
  const saved: SavedImage[] = []
  for (let i = 0; i < data.length; i++) {
    const img = data[i]
    const dl = await fetch(img.url)
    if (!dl.ok) throw new Error(`failed to download generated image (${dl.status})`)
    const buf = Buffer.from(await dl.arrayBuffer())
    const name = `ideogram-${stamp}-${i + 1}.png`
    // uploadPath → safeFilename, the SAME mapping the /files download endpoint
    // resolves, so the name we hand the model is the name the link serves.
    const path = uploadPath(sessionId, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, buf)
    saved.push({
      filename: basename(path),
      resolution: img.resolution,
      seed: img.seed,
      is_image_safe: img.is_image_safe,
    })
  }

  const names = saved.map((s) => `"${s.filename}"`).join(', ')
  return {
    images: saved,
    rendered_prompt: data[0].prompt,
    note: `Generated ${saved.length} image${saved.length === 1 ? '' : 's'} and saved to this session's uploads (${names}). They are listed in list_uploads and downloadable by the user. Tell the user the image is ready and reference it by that exact filename — do NOT try to read the PNG bytes yourself.`,
  }
}
