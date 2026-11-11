/** Durable orchestration choices the user changes at runtime. */

import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const provider = z.enum(['codex', 'antigravity', 'claude-code', 'openrouter'])
const role = z.enum([
  'reader',
  'searcher',
  'inspector',
  'planner',
  'architect',
  'implementer',
  'reviewer',
  'tester',
  'release',
])

/**
 * Stored orchestration state. Every field is optional: an absent field means
 * the user never changed it and the deployment default applies.
 */
export const toranjaOrchestrationState = z.object({
  mode: z.union([provider, z.literal('team')]).optional(),
  profile: z.enum(['economico', 'equilibrado', 'qualidade']).optional(),
  fallbackOrder: z.array(provider).min(1).optional(),
  roleProviders: z.partialRecord(role, provider).optional(),
  crossReview: z.boolean().optional(),
})

/** Stored orchestration state inferred from {@link toranjaOrchestrationState}. */
export type ToranjaOrchestrationState = z.infer<typeof toranjaOrchestrationState>

const NOTHING_STORED: ToranjaOrchestrationState = {}

/**
 * Storage domain holding the orchestration state as one global value. A stored
 * value that no longer matches the schema rejects opening the domain.
 */
export const toranjaOrchestrationDomain = defineDomain({
  name: 'toranja_orchestration',
  version: 1,
  global: { schema: toranjaOrchestrationState, initial: NOTHING_STORED },
  tables: {},
})
