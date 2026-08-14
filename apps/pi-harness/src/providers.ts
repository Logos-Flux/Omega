import { createAnthropic } from '@ai-sdk/anthropic'
import { createDeepSeek } from '@ai-sdk/deepseek'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createPerplexity } from '@ai-sdk/perplexity'
import type { LanguageModel } from 'ai'

export type ProviderId = 'anthropic' | 'google' | 'perplexity' | 'deepseek'

const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_API_KEY })
const perplexity = createPerplexity({ apiKey: process.env.PERPLEXITY_API_KEY })
const deepseek = createDeepSeek({ apiKey: process.env.DEEPSEEK_API_KEY })

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
    models: ['sonar-pro', 'sonar'] as const,
    resolve: (model: string): LanguageModel => perplexity(model),
  },
  deepseek: {
    // Advanced-only — see chat-api providers.ts. deepseek-v4-pro only;
    // the basic deepseek-chat tier was dropped (defaulted to Chinese).
    label: 'DeepSeek',
    models: ['deepseek-v4-pro'] as const,
    resolve: (model: string): LanguageModel => deepseek(model),
  },
} satisfies Record<
  ProviderId,
  { label: string; models: readonly string[]; resolve: (model: string) => LanguageModel }
>

export const DEFAULT_PROVIDER: ProviderId =
  (process.env.DEFAULT_PROVIDER as ProviderId | undefined) ?? 'anthropic'
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? 'claude-opus-4-7'

export function isValidSelection(provider: string, model: string): provider is ProviderId {
  if (!(provider in PROVIDERS)) return false
  return (PROVIDERS[provider as ProviderId].models as readonly string[]).includes(model)
}
