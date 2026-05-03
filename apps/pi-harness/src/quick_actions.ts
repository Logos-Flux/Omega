import { z } from 'zod'
import { join } from 'node:path'
import { workspaceRoot } from './memory'
import { Registry, type RegistryEntry } from './lib/registry'

// QuickActionRegistry — declarative bundles of every assembler input
// plus prompt plus runtime policy. The model never has to guess which
// skills to load or what tools it has; the QA author already decided.
//
// See AGENT_ARCHITECTURE.md L389-431 for the canonical shape and
// ROADMAP.md III.B.1 for the activation plan. Phase I starts the
// registry empty: no baked QAs, no user QAs. The shape and zod schema
// are wired up now so Phase III only needs to add parse semantics
// (read the YAML file → validate against `QuickActionSchema`) and
// drop starter QAs into /home/sprite/quick_actions/.
//
// Layout:
//   /workspace/quick_actions/<id>/quick_action.yaml   — user-mutable
//   /home/sprite/quick_actions/<id>/quick_action.yaml — golden-baked

const userQADir = (): string => join(workspaceRoot(), 'quick_actions')
const BAKED_QA_DIR = '/home/sprite/quick_actions'

// ---
// Zod schema. This is the validation surface III.B.1 will consume —
// the parse callback below stays a stub in Phase I, but the schema is
// final so downstream consumers (the dispatcher's QA path,
// chat-frontend chip rendering) can already type against it.
// ---
export const TriggerCompatibleSchema = z.enum([
  'user',
  'schedule',
  'event',
  'agent',
])

export const DeliverySchema = z.enum(['chat', 'inbox', 'silent'])

export const ConfirmationSchema = z.enum([
  'none',
  'side_effects',
  'explicit',
])

export const MemoryScopeSchema = z.enum([
  'read_only',
  'read_write',
  'none',
])

export const FollowupChipSchema = z.union([
  z.object({ label: z.string(), prompt: z.string() }),
  z.object({ label: z.string(), action: z.string() }),
])

export const QuickActionBudgetSchema = z.object({
  max_input_tokens: z.number().int().positive().optional(),
  max_output_tokens: z.number().int().positive().optional(),
  max_cost_usd: z.number().positive().optional(),
})

export const QuickActionSchema = z.object({
  // Frontmatter block (display + identification).
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  icon: z.string().optional(),
  category: z.string().optional(),

  // Body block (runtime spec).
  trigger_compatible: z.array(TriggerCompatibleSchema).min(1),
  persona: z.string().min(1),
  soul: z.string().min(1).default('inherit'),
  preferences: z.string().min(1).default('inherit'),

  skills_required: z.array(z.string()).default([]),
  tools_allowed: z.array(z.string()).default([]),
  knowledge_corpora: z.array(z.string()).default([]),
  memory_scope: MemoryScopeSchema.default('read_only'),

  prompt: z.string().min(1),

  budget: QuickActionBudgetSchema.default({}),

  delivery: DeliverySchema.default('chat'),
  confirmation: ConfirmationSchema.default('none'),

  followup_chips: z.array(FollowupChipSchema).default([]),
})

/**
 * The validated runtime shape of a QA. `name` is the registry-required
 * identifier and aliases `id` so the same value satisfies both the
 * registry contract and the QA frontmatter spec.
 */
export type QuickAction = z.infer<typeof QuickActionSchema> &
  RegistryEntry & {
    name: string
    /** Absolute path to the directory holding quick_action.yaml. */
    path: string
  }

// ---
// Parse callback. Phase I always returns null because:
//   1. There are no baked QAs to parse yet (III.B.2 ships them).
//   2. Real `quick_action.yaml` parsing needs a full YAML parser; the
//      `lib/frontmatter.ts` splitter only handles scalar frontmatter
//      and the QA body uses block scalars (`prompt: |`), arrays,
//      and nested objects.
//
// III.B.1 will replace this with a real parser (likely the `yaml`
// npm package + `QuickActionSchema.safeParse`).
// ---
async function parseQuickAction(_path: string): Promise<QuickAction | null> {
  return null
}

const qaRegistry = new Registry<QuickAction>({
  bakedDir: BAKED_QA_DIR,
  userDir: userQADir,
  parse: parseQuickAction,
})

export const QuickActionRegistry = {
  async list(): Promise<QuickAction[]> {
    qaRegistry.reload()
    return qaRegistry.list()
  },
  async get(id: string): Promise<QuickAction | null> {
    qaRegistry.reload()
    return qaRegistry.get(id)
  },
}
