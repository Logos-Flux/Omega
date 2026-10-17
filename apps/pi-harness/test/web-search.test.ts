import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV3 } from 'ai/test'
import type { Outgoing, Invocation } from '../src/types'

const root = mkdtempSync(join(tmpdir(), 'omega-web-search-'))
mkdirSync(join(root, 'conversations'))
process.env.WORKSPACE_ROOT = root
const { PromptAssembler } = await import('../src/assembler')
const { dispatchUser } = await import('../src/dispatcher')
const { run } = await import('../src/engine')
const { PROVIDERS } = await import('../src/providers')
const { readConversation } = await import('../src/memory')
const { PARALLEL_MCP_URL, SEARCH_USER_AGENT } = await import('../src/lib/web-search')

const envKeys = ['WEB_SEARCH_PROVIDER', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY',
  'PERPLEXITY_API_KEY', 'DEEPSEEK_API_KEY', 'PARALLEL_API_KEY', 'GEMINI_FILE_SEARCH_STORE']
let saved: Record<string, string | undefined>
const realFetch = globalThis.fetch
const realResolve = PROVIDERS.anthropic.resolve

type RequestRecord = { url: string; method: string; headers: Headers; body?: any }
let requests: RequestRecord[]
let mode: 'ok' | 'rpc-error' | 'tool-error' | 'http-error' | 'stall' | 'missing' | 'malformed'

beforeEach(() => {
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  for (const key of envKeys) delete process.env[key]
  process.env.WORKSPACE_ROOT = root
  requests = []
  mode = 'ok'
  globalThis.fetch = (async (url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    requests.push({ url: String(url), method: init?.method ?? 'GET', headers: new Headers(init?.headers), body })
    if (mode === 'http-error') return new Response('unavailable', { status: 503 })
    if (init?.method !== 'POST') return new Response(null, { status: 405 })
    if (body?.id === undefined) return new Response(null, { status: 202 })
    if (mode === 'malformed' && body.method === 'tools/list') {
      return new Response('invalid json', { headers: { 'Content-Type': 'application/json' } })
    }
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result })
    if (body.method === 'initialize') return reply({
      protocolVersion: body.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: 'test-search', version: '1' },
    })
    if (body.method === 'tools/list') return reply({ tools: mode === 'missing' ? [] :
      ['web_search', 'web_fetch'].map((name) => ({ name, inputSchema: { type: 'object', properties: {} } })),
    })
    if (body.method === 'tools/call') {
      if (mode === 'stall') return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      if (mode === 'rpc-error') return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'search failed' } })
      if (mode === 'tool-error') return reply({ isError: true, content: [{ type: 'text', text: 'quota reached' }] })
      return reply({ content: [{ type: 'text', text: JSON.stringify({
        results: [{ url: 'https://example.com/source', title: 'A source', excerpts: ['Grounded result'] }],
      }) }] })
    }
    throw new Error(`unexpected method ${body.method}`)
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  PROVIDERS.anthropic.resolve = realResolve
  for (const key of envKeys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
afterAll(() => rm(root, { recursive: true, force: true }))

function invocation(provider: Invocation['provider'] = 'anthropic'): Invocation {
  return dispatchUser({ type: 'send', id: 'turn', sessionId: 'web-session', content: 'Find a current source',
    provider, model: PROVIDERS[provider].models[0] }, { userId: 'user' })
}
async function execute(name: string, args: unknown, signal?: AbortSignal) {
  const payload = await PromptAssembler.build(invocation())
  return (payload.tools?.[name] as any).execute(args, { abortSignal: signal, toolCallId: 'call', messages: [] })
}
const search = { objective: 'Find sources', search_queries: ['example current source'] }

describe('normal assembler search resolution', () => {
  test('fresh no-key installation exposes anonymous tools without network during assembly', async () => {
    const payload = await PromptAssembler.build(invocation())
    expect(payload.tools?.web_search?.type).not.toBe('provider')
    expect(payload.tools?.web_fetch).toBeDefined()
    expect(payload.provider).toBe('anthropic')
    expect(requests).toHaveLength(0)
  })
  test('configured credentials retain native tools; explicit override wins', async () => {
    process.env.ANTHROPIC_API_KEY = 'configured-native'
    let payload = await PromptAssembler.build(invocation())
    expect(payload.tools?.web_search?.type).toBe('provider')
    expect(payload.tools?.web_fetch).toBeUndefined()
    process.env.WEB_SEARCH_PROVIDER = 'parallel'
    payload = await PromptAssembler.build(invocation())
    expect(payload.tools?.web_fetch).toBeDefined()
    process.env.WEB_SEARCH_PROVIDER = 'native'
    expect((await PromptAssembler.build(invocation())).tools?.web_fetch).toBeUndefined()
  })
  test('Gemini native search and File Search stay configured; DeepSeek gains search', async () => {
    process.env.GOOGLE_API_KEY = 'configured-google'
    expect((await PromptAssembler.build(invocation('google'))).tools?.google_search).toBeDefined()
    delete process.env.GOOGLE_API_KEY
    process.env.GEMINI_FILE_SEARCH_STORE = 'fileSearchStores/configured'
    const fileSearch = await PromptAssembler.build(invocation('google'))
    expect(fileSearch.tools?.file_search).toBeDefined()
    expect(fileSearch.tools?.web_search).toBeUndefined()
    expect((await PromptAssembler.build(invocation('deepseek'))).tools?.web_fetch).toBeDefined()
  })
  test('Perplexity retains integrated search and rejects unsupported Parallel override', async () => {
    expect((await PromptAssembler.build(invocation('perplexity'))).tools).toBeUndefined()
    process.env.WEB_SEARCH_PROVIDER = 'parallel'
    expect(PromptAssembler.build(invocation('perplexity'))).rejects.toThrow('requires Anthropic')
  })
  test('disable, invalid configuration and invocation denials never enable search', async () => {
    process.env.WEB_SEARCH_PROVIDER = 'none'
    const disabled = await PromptAssembler.build(invocation())
    expect(disabled.tools?.web_search).toBeUndefined()
    expect(disabled.tools?.web_fetch).toBeUndefined()
    expect(JSON.stringify(disabled.systemMessages)).not.toContain('call `web_search`')
    process.env.WEB_SEARCH_PROVIDER = 'invalid'
    expect(PromptAssembler.build(invocation())).rejects.toThrow('WEB_SEARCH_PROVIDER')
    delete process.env.WEB_SEARCH_PROVIDER
    const inv = invocation()
    inv.policy.toolsDenied = ['google_search', 'web_fetch']
    const denied = await PromptAssembler.build(inv)
    expect(denied.tools?.web_search).toBeUndefined()
    expect(denied.tools?.web_fetch).toBeUndefined()
    expect(requests).toHaveLength(0)
  })
  test('persona denials apply to Parallel and native search aliases', async () => {
    const dir = join(root, 'personas', 'restricted-web')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'persona.md'), '---\nname: restricted-web\ntools_denied: web_search, web_fetch\n---\nRestricted.\n')
    for (const provider of ['anthropic', 'google'] as const) {
      const inv = invocation(provider)
      inv.personaName = 'restricted-web'
      const payload = await PromptAssembler.build(inv)
      expect(payload.tools?.web_search).toBeUndefined()
      expect(payload.tools?.web_fetch).toBeUndefined()
      process.env.WEB_SEARCH_PROVIDER = 'native'
      expect((await PromptAssembler.build(inv)).tools?.google_search).toBeUndefined()
      delete process.env.WEB_SEARCH_PROVIDER
    }
  })
})

describe('HTTP MCP through assembled tool execution', () => {
  test('search/fetch keep URLs, project User-Agent and stable context without ambient authorization', async () => {
    process.env.PARALLEL_API_KEY = 'must-not-leak'
    expect(JSON.stringify(await execute('web_search', search))).toContain('https://example.com/source')
    expect(JSON.stringify(await execute('web_fetch', { urls: ['https://example.com/source'] }))).toContain('Grounded result')
    const calls = requests.filter((r) => r.body?.method === 'tools/call')
    expect(calls.map((r) => r.body.params.name)).toEqual(['web_search', 'web_fetch'])
    expect(calls[0]!.body.params.arguments.session_id).toMatch(/^[a-f0-9]{64}$/)
    expect(calls[0]!.body.params.arguments.session_id).toBe(calls[1]!.body.params.arguments.session_id)
    expect(calls[0]!.body.params.arguments.model_name).toBe('claude-opus-4-7')
    for (const request of requests) {
      expect(request.url).toBe(PARALLEL_MCP_URL)
      expect(request.headers.get('User-Agent')).toBe(SEARCH_USER_AGENT)
      expect(request.headers.has('Authorization')).toBe(false)
    }
    const tool = (await PromptAssembler.build(invocation())).tools!.web_fetch!
    const schema = tool.inputSchema as any
    expect(schema.safeParse({ urls: ['file:///etc/passwd'] }).success).toBe(false)
    expect(schema.safeParse({ urls: ['https://example.com'] }).success).toBe(true)
  })
  test('MCP, HTTP, missing-tool and malformed responses remain errors with no fallback', async () => {
    for (const failure of ['rpc-error', 'http-error', 'missing', 'malformed'] as const) {
      mode = failure
      const result = await execute('web_search', search)
      expect((result as any).error).toBeString()
    }
    mode = 'tool-error'
    const result = await execute('web_search', search)
    expect((result as any).isError).toBe(true)
    expect(JSON.stringify(result)).toContain('quota reached')
    expect(requests.every((r) => r.url === PARALLEL_MCP_URL)).toBe(true)
  })
  test('turn cancellation aborts the pending HTTP request', async () => {
    mode = 'stall'
    const controller = new AbortController()
    const pending = execute('web_search', search, controller.signal)
    while (!requests.some((r) => r.body?.method === 'tools/call')) await Bun.sleep(1)
    controller.abort(new DOMException('cancelled', 'AbortError'))
    expect(pending).rejects.toThrow('cancelled')
  })
  test('deadline aborts a stalled caller and returns a useful error', async () => {
    mode = 'stall'
    const setTimer = globalThis.setTimeout
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, delay: number, ...args: any[]) =>
      setTimer(fn, delay === 30_000 ? 20 : delay, ...args)) as typeof setTimeout)
    try {
      expect((await execute('web_search', search) as any).error).toBe('Parallel search timed out')
    } finally { timerSpy.mockRestore() }
  })
})

test('scripted model drives engine search, fetch and source consumption', async () => {
  let step = 0
  const mock = new MockLanguageModelV3({
    doStream: async ({ prompt, tools }) => {
      const current = step++
      expect(tools?.some((t) => t.type === 'function' && t.name === 'web_search')).toBe(true)
      if (current > 0) expect(JSON.stringify(prompt)).toContain('https://example.com/source')
      return { stream: new ReadableStream({ start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] })
        if (current < 2) {
          controller.enqueue({ type: 'tool-call', toolCallId: `call-${current}`,
            toolName: current === 0 ? 'web_search' : 'web_fetch',
            input: JSON.stringify(current === 0 ? search : { urls: ['https://example.com/source'] }) })
        } else {
          controller.enqueue({ type: 'text-start', id: 'answer' })
          controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Grounded result: https://example.com/source' })
          controller.enqueue({ type: 'text-end', id: 'answer' })
        }
        controller.enqueue({ type: 'finish', finishReason: { unified: current < 2 ? 'tool-calls' : 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } } as never)
        controller.close()
      } }) }
    },
  })
  PROVIDERS.anthropic.resolve = () => mock
  const events: Outgoing[] = []
  await run({ type: 'send', id: 'engine-web', sessionId: 'engine-web', content: 'Find and read a source',
    provider: 'anthropic', model: 'claude-opus-4-7' }, (event) => events.push(event), { userId: 'user' })
  expect(step).toBe(3)
  expect(events.filter((e) => e.type === 'tool' && e.status === 'done')).toHaveLength(2)
  expect(events.some((e) => e.type === 'delta' && e.text.includes('https://example.com/source'))).toBe(true)
  expect((await readConversation('engine-web')).at(-1)?.text).toContain('Grounded result')
  expect(events.at(-1)?.type).toBe('done')
})
