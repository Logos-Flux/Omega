import { anthropic as anthropicTools, createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI, google as googleProvider } from '@ai-sdk/google'
import { createPerplexity } from '@ai-sdk/perplexity'
import { tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import { isRagEnabled, searchRag } from './rag'

export type ProviderId = 'anthropic' | 'google' | 'perplexity'

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY })
const perplexity = createPerplexity({ apiKey: process.env.PERPLEXITY_API_KEY })

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6'] as const,
    resolve: (model: string): LanguageModel => anthropic(model),
  },
  google: {
    label: 'Gemini',
    models: ['gemini-3.1-pro-preview', 'gemini-3-flash-preview'] as const,
    resolve: (model: string): LanguageModel => google(model),
  },
  perplexity: {
    label: 'Perplexity',
    models: ['sonar', 'sonar-pro'] as const,
    resolve: (model: string): LanguageModel => perplexity(model),
  },
} satisfies Record<
  ProviderId,
  { label: string; models: readonly string[]; resolve: (model: string) => LanguageModel }
>

export interface ToolContext {
  userId: string
}

// Builds the per-turn tool set for a chat request. Provider-specific
// server-side tools (Anthropic's web_search, Gemini's google_search) layer
// on top of any cross-provider tools we register ourselves (currently:
// rag_search). Returning `undefined` when there's nothing to wire keeps
// the request payload free of `tools: {}` which some providers reject.
export function toolsForProvider(provider: ProviderId, ctx: ToolContext): ToolSet | undefined {
  const tools: ToolSet = {}

  // rag_search — registered when both RAG_API_URL and RAG_SERVICE_TOKEN
  // are set. Mirror of the harness's rag_search tool (apps/pi-harness/
  // src/assembler.ts) so the chunk shape, citation rendering, and
  // user-facing description are consistent across plain-chat and
  // Agent-Mode sessions.
  if (isRagEnabled()) {
    tools.rag_search = tool({
      description: [
        "Search the user's indexed Drive content (their personal `my-ai/` folder plus any shared knowledge base) for chunks relevant to a query.",
        'Returns up to top_k snippets with file_name + source_url for citation.',
        'Use this when the user asks a question whose answer is likely in their own documents rather than general knowledge.',
        'Empty `chunks: []` is normal when nothing matches or the user has not synced any files yet — say so plainly rather than fabricating an answer.',
      ].join(' '),
      inputSchema: z.object({
        query: z
          .string()
          .describe(
            'Natural-language question or keywords. The retriever does its own embedding + keyword hybrid; you do not need to format this for any specific search syntax.',
          ),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Max chunks to return. Default 5. Raise to 10–15 for broad/exploratory questions.'),
      }),
      execute: async ({ query, top_k }) => searchRag({ userId: ctx.userId, query, topK: top_k }),
    })
  }

  if (provider === 'anthropic') {
    tools.web_search = anthropicTools.tools.webSearch_20250305({ maxUses: 5 })
  }
  if (provider === 'google') {
    // Tool name MUST be `google_search` for Gemini to recognize it as the
    // server-side grounding tool. Args are empty — Gemini composes queries
    // from conversation context.
    tools.google_search = googleProvider.tools.googleSearch({})
  }

  return Object.keys(tools).length === 0 ? undefined : tools
}

export const DEFAULT_PROVIDER: ProviderId = 'perplexity'
export const DEFAULT_MODEL = 'sonar-pro'

export function isValidSelection(provider: string, model: string): provider is ProviderId {
  if (!(provider in PROVIDERS)) return false
  return (PROVIDERS[provider as ProviderId].models as readonly string[]).includes(model)
}
