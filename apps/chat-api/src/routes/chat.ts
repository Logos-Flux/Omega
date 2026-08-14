import { Hono } from 'hono'
import { stepCountIs, streamText, type ModelMessage, type ToolSet, type UIMessage } from 'ai'
import { getPool, hasDatabase } from '../lib/db'
import { requireSession } from '../middleware/session'
import { PROVIDERS, DEFAULT_PROVIDER, DEFAULT_MODEL, isValidSelection, toolsForProvider, type ProviderId } from '../lib/providers'
import { resolveThreadLock, ThreadOwnershipError } from '../lib/thread-lock'

export const chatRoutes = new Hono()

chatRoutes.use('*', requireSession)

// Minimal, provider-neutral system prompt. Primary purpose: pin the response
// language. DeepSeek (deepseek-chat in particular) otherwise answers in
// Chinese for many prompts — it has no inherent bias toward the user's
// language the way Claude/Gemini do. A one-line steer fixes it without
// imposing a persona on the other providers.
const CHAT_SYSTEM_PROMPT =
  'Respond in the same language the user writes in. When their language is unclear, mixed, or the message is too short to tell, default to English. Never switch languages unprompted.'

interface ChatRequestBody {
  id?: string
  messages: UIMessage[]
  provider?: string
  model?: string
  // I.D.1 — `override: true` means the user has acknowledged that switching
  // providers/models mid-thread invalidates the prompt cache, and wants to
  // re-lock the thread to the new pair. Without it, a turn whose
  // provider/model differs from the locked value is silently rewritten
  // back to the locked value (and `mismatched: true` is signalled in the
  // response headers).
  override?: boolean
}

function partsToText(msg: UIMessage): string {
  const parts = (msg.parts ?? []) as Array<{ type: string; text?: string }>
  return parts
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text!)
    .join('\n')
}

function buildModelMessages(messages: UIMessage[]): ModelMessage[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text = partsToText(m).trim()
    if (!text) continue
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role) {
      prev.content += '\n\n' + text
    } else {
      out.push({ role: m.role, content: text })
    }
  }
  while (out.length > 0 && out[0].role === 'assistant') out.shift()
  return out
}

async function persistMessage(
  threadId: string,
  userId: string,
  msg: { id?: string; role: string; parts?: unknown; content?: unknown },
): Promise<void> {
  if (!hasDatabase) return
  const pool = getPool()
  await pool.query(
    `INSERT INTO chat.messages (id, thread_id, user_id, role, content)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO NOTHING`,
    [msg.id ?? crypto.randomUUID(), threadId, userId, msg.role, JSON.stringify(msg)],
  )
}

chatRoutes.post('/', async (c) => {
  const user = c.get('user')
  // QUAL-10 — guard the body parse and shape so a malformed request is a 400,
  // not an unhandled throw → 500. `[...body.messages]` below would explode on
  // a missing/non-array `messages`.
  const body = (await c.req.json().catch(() => null)) as ChatRequestBody | null
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: 'messages must be a non-empty array' }, 400)
  }

  const requestedProvider = (body.provider ?? DEFAULT_PROVIDER) as ProviderId
  const requestedModel = body.model ?? DEFAULT_MODEL
  if (!isValidSelection(requestedProvider, requestedModel)) {
    return c.json({ error: `Unknown provider/model: ${body.provider}/${body.model}` }, 400)
  }

  const threadId = body.id ?? crypto.randomUUID()
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')
  const userText = lastUser ? partsToText(lastUser) : ''

  // Apply per-thread provider lock-in (I.D.1). If this thread is already
  // locked to a different (provider, model) and the user did not pass
  // `override: true`, the locked pair wins and we surface `mismatched: true`
  // in the response headers so the UI can show "switching invalidates cache".
  let lock = { provider: requestedProvider as string, model: requestedModel as string, mismatched: false }
  if (hasDatabase) {
    try {
      lock = await resolveThreadLock({
        threadId,
        userId: user.id,
        requestedProvider,
        requestedModel,
        override: !!body.override,
        firstUserMessage: userText,
      })
    } catch (e) {
      // BUG-12 — a foreign-owned thread id must 404 and must NOT have the
      // attacker's messages persisted against the victim's thread.
      if (e instanceof ThreadOwnershipError) {
        return c.json({ error: 'thread not found' }, 404)
      }
      console.error('[chat] resolveThreadLock failed', e)
    }
  }

  // Validate the resolved pair (the locked value could in principle have
  // gotten out of sync with PROVIDERS — fall back to the request if so).
  const provider = (isValidSelection(lock.provider, lock.model) ? lock.provider : requestedProvider) as ProviderId
  const model = isValidSelection(lock.provider, lock.model) ? lock.model : requestedModel

  if (lastUser) {
    await persistMessage(threadId, user.id, lastUser).catch((e) =>
      console.error('[chat] persist user msg failed', e),
    )
  }

  const modelMessages = buildModelMessages(body.messages)
  if (modelMessages.length === 0) {
    return c.json({ error: 'No usable messages in request' }, 400)
  }
  console.log(
    `[chat] ${provider}/${model} thread=${threadId} messages=${modelMessages.length} roles=${modelMessages.map((m) => m.role[0]).join('')} mismatched=${lock.mismatched}`,
  )

  const tools = toolsForProvider(provider, { userId: user.id })
  const result = streamText({
    model: PROVIDERS[provider].resolve(model),
    system: CHAT_SYSTEM_PROMPT,
    messages: modelMessages,
    ...(tools ? { tools: tools as ToolSet, stopWhen: stepCountIs(5) } : {}),
    onFinish: async ({ text, steps, response }) => {
      const aggregated = steps?.map((s) => s.text).filter(Boolean).join('\n\n') || text
      if (!aggregated) return
      await persistMessage(threadId, user.id, {
        id: response.id,
        role: 'assistant',
        parts: [{ type: 'text', text: aggregated }],
      }).catch((e) => console.error('[chat] persist assistant msg failed', e))
    },
    onError: ({ error }) => {
      console.error('[chat] streamText error', error)
    },
  })

  // Surface the lock state to the client. Frontend reads these via a custom
  // `fetch` wrapper on the AI SDK transport to render the cache-invalidation
  // indicator and to know what the canonical lock is for the active thread.
  //
  // sendReasoning:false — reasoning models (e.g. deepseek-v4-pro) stream a
  // separate chain-of-thought that the SDK exposes as reasoning parts. We
  // don't surface raw CoT in this chat product; without this it renders as
  // the answer — and DeepSeek frequently reasons in Chinese, so the user
  // sees a Chinese "response" even though the final answer is English.
  const response = result.toUIMessageStreamResponse({ sendSources: true, sendReasoning: false })
  response.headers.set('X-Locked-Provider', provider)
  response.headers.set('X-Locked-Model', model)
  response.headers.set('X-Lock-Mismatched', lock.mismatched ? '1' : '0')
  return response
})
