import { anthropic as anthropicTools, createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI, google as googleProvider } from '@ai-sdk/google'
import { createPerplexity } from '@ai-sdk/perplexity'
import { tool, type LanguageModel, type ToolSet } from 'ai'
import { z } from 'zod'
import { isRagEnabled, searchRag } from './rag'

export type ProviderId = 'anthropic' | 'google' | 'perplexity' | 'deepseek'

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY })
const perplexity = createPerplexity({ apiKey: process.env.PERPLEXITY_API_KEY })
const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })

// Gemini File Search — when GEMINI_FILE_SEARCH_STORE is set (a
// `fileSearchStores/<id>` resource name owned by GOOGLE_API_KEY's project),
// the Gemini provider retrieves from that managed store via the native
// file_search tool instead of RAGFlow's rag_search. Lets us A/B Gemini File
// Search against the RAGFlow path (Anthropic) on the same KB. File Search is
// mutually exclusive with google_search/url_context, so that path drops
// google_search grounding.
function geminiFileSearchStore(): string {
  return process.env.GEMINI_FILE_SEARCH_STORE?.trim() ?? ''
}
export function isGeminiFileSearchEnabled(): boolean {
  return geminiFileSearchStore().length > 0
}

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
  deepseek: {
    // Advanced-only: deepseek-chat (the non-reasoning tier) defaults to
    // Chinese for many prompts, so we expose just deepseek-v4-pro. Its raw
    // chain-of-thought is hidden via sendReasoning:false in routes/chat.ts.
    label: 'DeepSeek',
    models: ['deepseek-v4-pro'] as const,
    resolve: (model: string): LanguageModel => deepseek(model),
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

  // When Gemini File Search is active for the google provider, that path uses
  // the native file_search tool for retrieval instead of RAGFlow's rag_search
  // — keeps the A/B clean (Anthropic → RAGFlow, Gemini → File Search on the
  // same KB).
  const geminiFileSearch = provider === 'google' && isGeminiFileSearchEnabled()

  // rag_search — registered when both RAG_API_URL and RAG_SERVICE_TOKEN
  // are set. Mirror of the harness's rag_search tool (apps/pi-harness/
  // src/assembler.ts) so the chunk shape, citation rendering, and
  // user-facing description are consistent across plain-chat and
  // Agent-Mode sessions.
  if (isRagEnabled() && !geminiFileSearch) {
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
    if (geminiFileSearch) {
      // Native managed-RAG retrieval from the configured File Search store.
      // Mutually exclusive with google_search/url_context, so grounding is
      // dropped on this path (the A/B is KB retrieval, not live web).
      tools.file_search = googleProvider.tools.fileSearch({
        fileSearchStoreNames: [geminiFileSearchStore()],
      })
    } else {
      // Tool name MUST be `google_search` for Gemini to recognize it as the
      // server-side grounding tool. Args are empty — Gemini composes queries
      // from conversation context.
      tools.google_search = googleProvider.tools.googleSearch({})
    }
  }

  return Object.keys(tools).length === 0 ? undefined : tools
}

export const DEFAULT_PROVIDER: ProviderId = 'perplexity'
export const DEFAULT_MODEL = 'sonar-pro'

export function isValidSelection(provider: string, model: string): provider is ProviderId {
  if (!(provider in PROVIDERS)) return false
  return (PROVIDERS[provider as ProviderId].models as readonly string[]).includes(model)
}
