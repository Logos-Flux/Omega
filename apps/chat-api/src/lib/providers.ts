import { anthropic as anthropicTools, createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createPerplexity } from '@ai-sdk/perplexity'
import type { LanguageModel } from 'ai'

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

export function toolsForProvider(provider: ProviderId) {
  if (provider === 'anthropic') {
    return { web_search: anthropicTools.tools.webSearch_20250305({ maxUses: 5 }) }
  }
  return undefined
}

export const DEFAULT_PROVIDER: ProviderId = 'perplexity'
export const DEFAULT_MODEL = 'sonar-pro'

export function isValidSelection(provider: string, model: string): provider is ProviderId {
  if (!(provider in PROVIDERS)) return false
  return (PROVIDERS[provider as ProviderId].models as readonly string[]).includes(model)
}
